import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { chromium } from "playwright-core";
import { BrowserEgress } from "../src/server/browser-egress";

// Run in a separate Bun process: mixing managed persistent contexts with this
// headless WebRTC fixture intermittently hangs browser.close() after all of its
// assertions pass on Bun 1.3.9. No assertions are skipped or weakened.
const available = existsSync("/usr/bin/google-chrome");

(available && existsSync("/usr/bin/openssl") ? test : test.skip)(
  "SOCKS browser transport supports IPv6, verified HTTPS and WSS without direct fallback",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "jelly-socks-tls-"));
    const key = join(dir, "test-key.pem"),
      cert = join(dir, "test-cert.pem");
    execFileSync(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const denied = new Set<number>(),
      attempted: { host: string; port: number }[] = [];
    const proxy = new BrowserEgress((host, port) => {
      attempted.push({ host, port });
      return (
        denied.has(port) ||
        !["127.0.0.1", "::1", "0:0:0:0:0:0:0:1"].includes(host)
      );
    });
    const server = await proxy.listen((port) => denied.add(port));
    const tls = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: readFileSync(key), cert: readFileSync(cert) },
      fetch: (request, server) => {
        if (
          new URL(request.url).pathname === "/socket" &&
          server.upgrade(request)
        )
          return;
        return new Response("TLS fixture");
      },
      websocket: {
        message(socket, message) {
          socket.send(message);
        },
      },
    });
    const ipv6 = Bun.serve({
      hostname: "::1",
      port: 0,
      fetch: () => new Response("IPv6 fixture"),
    });
    const browser = await chromium.launch({
      executablePath: "/usr/bin/google-chrome",
      headless: true,
      proxy: { server, bypass: "<-loopback>" },
      args: ["--disable-quic"],
    });
    try {
      const strict = await browser.newContext();
      const strictPage = await strict.newPage();
      // The egress gate does not weaken certificate validation.
      await expect(strictPage.goto(tls.url.href)).rejects.toThrow(
        "ERR_CERT_AUTHORITY_INVALID",
      );
      await strict.close();
      // Only this test context accepts its ephemeral fixture certificate.
      const trusted = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await trusted.newPage();
      await page.goto(tls.url.href);
      expect(await page.textContent("body")).toBe("TLS fixture");
      expect(
        await page.evaluate(
          () =>
            new Promise<string>((resolve, reject) => {
              const socket = new WebSocket(
                location.origin.replace("https", "wss") + "/socket",
              );
              socket.onopen = () => socket.send("normal-wss");
              socket.onmessage = (event) => {
                resolve(event.data);
                socket.close();
              };
              socket.onerror = () => reject(new Error("WSS failed"));
            }),
        ),
      ).toBe("normal-wss");
      await page.goto(`http://[::1]:${ipv6.port}/`);
      expect(await page.textContent("body")).toBe("IPv6 fixture");
      expect(
        attempted.some(
          (item) => item.port === ipv6.port && item.host.includes(":"),
        ),
      ).toBe(true);
      expect(attempted.some((item) => item.port === tls.port)).toBe(true);
      let directTcp = 0;
      const turn = createTcpServer((socket) => {
        directTcp++;
        socket.destroy();
      });
      await new Promise<void>((resolve) =>
        turn.listen(0, "127.0.0.1", resolve),
      );
      const turnPort = (turn.address() as { port: number }).port;
      denied.add(turnPort);
      try {
        const peer = await page.evaluateHandle(
          async ({ turnPort }) => {
            const peer = new RTCPeerConnection({
              iceServers: [
                {
                  urls: `turn:127.0.0.1:${turnPort}?transport=tcp`,
                  username: "fixture",
                  credential: "fixture",
                },
              ],
            });
            peer.createDataChannel("fixture");
            await peer.setLocalDescription(await peer.createOffer());
            return peer;
          },
          { turnPort },
        );
        try {
          // Observe the actual proxy attempt, not a renderer timer: Chromium
          // can throttle page timers during combined headless browser tests.
          const deadline = Date.now() + 5000;
          while (
            !attempted.some((item) => item.port === turnPort) &&
            Date.now() < deadline
          )
            await new Promise((resolve) => setTimeout(resolve, 20));
          expect(directTcp).toBe(0);
          expect(attempted.some((item) => item.port === turnPort)).toBe(true);
        } finally {
          await peer.evaluate((connection) => connection.close());
          await peer.dispose();
        }
      } finally {
        await new Promise<void>((resolve) => turn.close(() => resolve()));
      }

      denied.add(ipv6.port!);
      proxy.revoke(ipv6.port!);
      await expect(
        page.goto(`http://[::1]:${ipv6.port}/denied`),
      ).rejects.toThrow();
      denied.add(tls.port!);
      proxy.revoke(tls.port!);
      await expect(page.goto(tls.url.href + "denied")).rejects.toThrow();
      await proxy.close();
      await expect(
        page.goto("http://127.0.0.1:" + ipv6.port + "/no-fallback"),
      ).rejects.toThrow();
      await trusted.close();
    } finally {
      await browser.close();
      await proxy.close();
      tls.stop(true);
      ipv6.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);
