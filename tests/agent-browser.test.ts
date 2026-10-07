import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { BrowserContext, Page } from "playwright-core";
import { createServer as createTcpServer } from "node:net";
import { AgentBrowser } from "../src/server/agent-browser";
import { Computer } from "../src/server/computer";
import { ComputerSessions } from "../src/server/computer-sessions";
import { Store } from "../src/server/store";
import type { BrowserBackend } from "../src/shared/types";

const runtime = resolve(".jelly/runtime");
const available =
  existsSync("/usr/bin/google-chrome") &&
  (existsSync("/usr/bin/Xvfb") || existsSync(join(runtime, "usr/bin/Xvfb")));

test("browser controller setting survives database reopen and migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-backend-store-"));
  const path = join(dir, "test.sqlite");
  let store = new Store(path);
  try {
    expect(store.instance().browserBackend).toBe("agent-browser");
    store.setBrowserBackend("playwright");
    store.close();
    store = new Store(path);
    expect(store.instance().browserBackend).toBe("playwright");
    store.db.exec(
      "ALTER TABLE instance DROP COLUMN browserBackend; PRAGMA user_version=11;",
    );
    store.close();
    store = new Store(path);
    expect(store.instance().browserBackend).toBe("agent-browser");
    expect(() =>
      store.setBrowserBackend("invalid" as BrowserBackend),
    ).toThrow();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("controller selection is captured per isolated session, with unchanged persistent paths", async () => {
  let backend: BrowserBackend = "agent-browser";
  const sessions = new ComputerSessions(
    "/unused",
    () => true,
    () => {},
    () => backend,
  );
  const first = sessions.get("a");
  backend = "playwright";
  expect(sessions.get("a").backend).toBe("agent-browser");
  expect(sessions.get("b").backend).toBe("playwright");
  expect(sessions.get("b").dataDir).not.toBe(first.dataDir);
  await sessions.closeSession("a");
  expect(sessions.get("a").dataDir).toBe(first.dataDir);
  expect(sessions.get("a").backend).toBe("playwright");
  await sessions.close();
});

test("unavailable native daemon fails without exposing process diagnostics and closes safely", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-native-unavailable-"));
  rmSync(dir, { recursive: true, force: true });
  const controller = new AgentBrowser(dir);
  try {
    await expect(
      controller.start("ws://127.0.0.1:1/devtools/browser/test", () => {}, 1),
    ).rejects.toThrow("AgentBrowser could not start");
  } finally {
    await controller.close();
  }
});

(available ? test : test.skip)(
  "every controller blocks other agents' native HTTP and WebSocket control ports",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "jelly-cross-controller-"));
    if (existsSync(runtime)) symlinkSync(runtime, join(dir, "runtime"), "dir");
    const owner = new Computer(
      join(dir, "owner"),
      () => {},
      dir,
      "agent-browser",
    );
    const visitors = (["playwright", "agent-browser"] as const).map(
      (backend) => new Computer(join(dir, backend), () => {}, dir, backend),
    );
    try {
      // Start visitors first to cover controller ports registered after routes exist.
      for (const visitor of visitors) await visitor.ensure();
      await owner.ensure();
      for (const visitor of visitors) {
        for (const port of (owner as unknown as Internal).controllerPorts) {
          await expect(
            visitor.action("open", {
              url: `http://localhost:${port}/json/list`,
            }),
          ).rejects.toThrow("control interface");
          const page = (visitor as unknown as Internal).page;
          expect(
            await page.evaluate(async (port) => {
              try {
                await fetch(`http://127.0.0.1:${port}/json/list`, {
                  mode: "no-cors",
                });
                return false;
              } catch {
                return true;
              }
            }, port),
          ).toBe(true);
          expect(
            await page.evaluate(
              (port) =>
                new Promise<boolean>((resolve) => {
                  const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
                  const timer = setTimeout(() => {
                    socket.close();
                    resolve(false);
                  }, 3000);
                  socket.onopen = () => {
                    clearTimeout(timer);
                    socket.close();
                    resolve(false);
                  };
                  socket.onerror = socket.onclose = () => {
                    clearTimeout(timer);
                    resolve(true);
                  };
                }),
              port,
            ),
          ).toBe(true);
        }
      }
    } finally {
      for (const visitor of visitors) await visitor.close();
      await owner.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60000,
);

type Internal = {
  context: BrowserContext;
  page: Page;
  controllerPorts: Set<number>;
  agentBrowser: { process: import("node:child_process").ChildProcess };
};
(available ? test : test.skip)(
  "installed native AgentBrowser controls managed tabs, preserves private handoff and profile, and fails closed",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "jelly-native-browser-"));
    if (existsSync(runtime)) symlinkSync(runtime, join(dir, "runtime"), "dir");
    let computer = new Computer(
      join(dir, "agent-a"),
      () => {},
      dir,
      "agent-browser",
    );
    let managedHeader = false;
    const site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        managedHeader = req.headers.get("X-Jelly-Managed-Browser") === "1";
        return new Response(
          '<h1>Native fixture</h1><input id="field"><input type="password" value="DO_NOT_EXPOSE"><button style="position:absolute;left:300px;top:100px" onclick="this.textContent=\'Clicked\'">Go</button><div style="height:3000px"></div>',
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    try {
      expect(
        await computer.action("open", { url: site.url.href }),
      ).toMatchObject({ status: 200 });
      expect(managedHeader).toBe(true);
      let internal = computer as unknown as Internal;
      expect(internal.context.pages()).toHaveLength(1);
      const page = internal.page;
      await expect(
        computer.action("open", {
          url: "http://127.0.0.1:1/private-do-not-echo",
        }),
      ).rejects.toThrow(
        "AgentBrowser action failed. Refresh the observation and try again.",
      );
      await computer.action("open", { url: site.url.href });
      expect(await page.title()).toBe("");
      expect(await page.locator("h1").innerText()).toBe("Native fixture");
      await computer.action("click", { x: 310, y: 110 });
      expect(await page.locator("button").innerText()).toBe("Clicked");
      await page.locator("#field").focus();
      await computer.action("type", { text: "native input" });
      await computer.action("key", { key: "End" });
      expect(await page.locator("#field").inputValue()).toBe("native input");
      await computer.action("scroll", { y: 400 });
      expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
      await computer.action("scroll", { y: -400 });
      const snapshot = (await computer.action("snapshot")) as {
        pageId: string;
        elements: { ref: string; type: string }[];
      };
      expect(JSON.stringify(snapshot)).not.toContain("DO_NOT_EXPOSE");
      await expect(
        computer.action("fill", {
          ref: snapshot.elements.find((e) => e.type === "password")!.ref,
          text: "forbidden",
        }),
      ).rejects.toThrow("request_browser_login");
      await computer.action("tabs", {
        operation: "new",
        url: site.url.href + "other",
      });
      const other = internal.page;
      await computer.action("tabs", {
        operation: "select",
        pageId: snapshot.pageId,
      });
      await computer.action("open", { url: site.url.href + "selected" });
      expect(page.url()).toEndWith("/selected");
      expect(other.url()).toEndWith("/other");
      // Assert actual listeners, not only requested Chromium launch flags.
      expect(internal.controllerPorts.size).toBe(3);
      const listeners = ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((file) =>
        existsSync(file)
          ? readFileSync(file, "utf8")
              .trim()
              .split("\n")
              .slice(1)
              .map((line) => line.trim().split(/\s+/))
              .filter((fields) => fields[3] === "0A")
              .map((fields) => fields[1]!)
          : [],
      );
      // Internal native control surfaces are unavailable to pages, even through aliases.
      for (const port of internal.controllerPorts) {
        const addresses = listeners
          .filter((address) => parseInt(address.split(":")[1]!, 16) === port)
          .map((address) => address.split(":")[0]);
        expect(addresses.length).toBeGreaterThan(0);
        expect(
          addresses.every((address) =>
            ["0100007F", "00000000000000000000000001000000"].includes(address!),
          ),
        ).toBe(true);
        expect(
          await page.evaluate(
            (port) =>
              new Promise<boolean>((resolve) => {
                const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
                const timer = setTimeout(() => {
                  socket.close();
                  resolve(false);
                }, 3000);
                socket.onopen = () => {
                  clearTimeout(timer);
                  socket.close();
                  resolve(false);
                };
                socket.onerror = socket.onclose = () => {
                  clearTimeout(timer);
                  resolve(true);
                };
              }),
            port,
          ),
        ).toBe(true);
        await expect(
          computer.action("open", { url: `http://localhost:${port}/` }),
        ).rejects.toThrow("control interface");
        expect(
          await page.evaluate(async (port) => {
            try {
              await fetch(`http://127.0.0.1:${port}/`, { mode: "no-cors" });
              return false;
            } catch {
              return true;
            }
          }, port),
        ).toBe(true);
      }
      await computer.reserveLogin("private", site.url.href);
      await computer.take("owner");
      await expect(computer.action("snapshot")).rejects.toThrow(
        "person controls",
      );
      await expect(
        computer.action("type", { text: "blocked" }),
      ).rejects.toThrow("person controls");
      await expect(computer.ticket("other-owner", "view")).rejects.toThrow(
        "private",
      );
      await internal.context.addCookies([
        { name: "login", value: "temporary-test-login", url: site.url.href },
      ]);
      await internal.page.evaluate(() =>
        localStorage.setItem("logged-in", "yes"),
      );
      expect(await computer.release("owner")).toBe("private");
      await computer.action("open", { url: site.url.href + "resumed" });
      const isolated = new Computer(
        join(dir, "agent-b"),
        () => {},
        dir,
        "agent-browser",
      );
      try {
        await isolated.action("open", { url: site.url.href });
        const otherSession = isolated as unknown as Internal;
        expect(otherSession.agentBrowser.process.pid).not.toBe(
          internal.agentBrowser.process.pid,
        );
        expect(
          (await otherSession.context.cookies()).some(
            (cookie) => cookie.name === "login",
          ),
        ).toBe(false);
        expect(
          await otherSession.page.evaluate(() =>
            localStorage.getItem("logged-in"),
          ),
        ).toBeNull();
        await isolated.action("open", { url: site.url.href + "isolated" });
        expect(internal.page.url()).toEndWith("/resumed");
      } finally {
        await isolated.close();
      }
      const daemon = internal.agentBrowser.process;
      await computer.close();
      expect(daemon.exitCode !== null || daemon.signalCode !== null).toBe(true);
      // Switching controller uses the very same profile, not a state export/copy.
      computer = new Computer(
        join(dir, "agent-a"),
        () => {},
        dir,
        "playwright",
      );
      await computer.action("open", { url: site.url.href });
      expect(
        (await (computer as unknown as Internal).context.cookies()).some(
          (cookie) => cookie.name === "login",
        ),
      ).toBe(true);
      await computer.close();
      computer = new Computer(
        join(dir, "agent-a"),
        () => {},
        dir,
        "agent-browser",
      );
      await computer.action("open", { url: site.url.href });
      internal = computer as unknown as Internal;
      expect(
        (await internal.context.cookies()).some(
          (cookie) =>
            cookie.name === "login" && cookie.value === "temporary-test-login",
        ),
      ).toBe(true);
      expect(
        await internal.page.evaluate(() => localStorage.getItem("logged-in")),
      ).toBe("yes");
      internal.agentBrowser.process.kill("SIGKILL");
      await new Promise((resolve) =>
        internal.agentBrowser.process.once("exit", resolve),
      );
      await expect(
        computer.action("open", { url: site.url.href + "must-not-open" }),
      ).rejects.toThrow("AgentBrowser disconnected");
      expect(internal.page.url()).not.toContain("must-not-open");
    } finally {
      await computer.close();
      site.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  },
  90000,
);

(available ? test : test.skip)(
  "redirects cannot reach late-registered controller endpoints from either backend",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "jelly-controller-redirect-"));
    if (existsSync(runtime)) symlinkSync(runtime, join(dir, "runtime"), "dir");
    const owner = new Computer(
      join(dir, "owner"),
      () => {},
      dir,
      "agent-browser",
    );
    const visitors = (["playwright", "agent-browser"] as const).map(
      (backend) => new Computer(join(dir, backend), () => {}, dir, backend),
    );
    const site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => {
        const url = new URL(request.url);
        if (url.pathname === "/redirect")
          return Response.redirect(url.searchParams.get("to")!);
        if (url.pathname === "/worker.js")
          return new Response(
            "onmessage=async e=>{try{await fetch(e.data,{mode:'no-cors'});postMessage(false)}catch{postMessage(true)}}",
            { headers: { "Content-Type": "text/javascript" } },
          );
        if (url.pathname === "/shared.js")
          return new Response(
            "onconnect=e=>{const p=e.ports[0];p.onmessage=async e=>{try{await fetch(e.data,{mode:'no-cors'});p.postMessage(false)}catch{p.postMessage(true)}}}",
            { headers: { "Content-Type": "text/javascript" } },
          );
        if (url.pathname === "/login")
          return new Response("Signed in", {
            headers: { "Set-Cookie": "fixture_redirect=ok; HttpOnly; Path=/" },
          });
        if (url.pathname === "/stream")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("first-event"));
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        if (url.pathname === "/upload")
          return request.text().then((text) => new Response(text));
        if (url.pathname === "/download")
          return new Response("download-bytes", {
            headers: {
              "Content-Disposition": 'attachment; filename="fixture.txt"',
            },
          });
        if (url.pathname === "/socket" && server.upgrade(request)) return;
        return new Response("Public fixture", {
          headers: { "Content-Type": "text/html" },
        });
      },
      websocket: {
        message(socket, message) {
          socket.send(message);
        },
      },
    });
    const redirect = (target: string) => {
      const url = new URL("/redirect", site.url);
      url.searchParams.set("to", target);
      return url.href;
    };
    try {
      // These pages and both worker types predate the protected ports.
      for (const visitor of visitors) {
        await visitor.action("open", { url: site.url.href });
        await (visitor as unknown as Internal).page.evaluate(() => {
          (globalThis as any).dedicated = new Worker("/worker.js");
          (globalThis as any).shared = new SharedWorker("/shared.js").port;
          (globalThis as any).shared.start();
        });
      }
      await owner.ensure();
      for (const visitor of [...visitors, owner]) {
        const page = (visitor as unknown as Internal).page;
        if (visitor === owner) await page.goto(site.url.href);
        for (const port of (owner as unknown as Internal).controllerPorts) {
          const url = redirect(redirect(`http://127.0.0.1:${port}/json/list`));
          expect(
            await page.evaluate(async (url) => {
              try {
                await fetch(url, { mode: "no-cors" });
                return false;
              } catch {
                return true;
              }
            }, url),
          ).toBe(true);
          if (visitor !== owner) {
            for (const name of ["dedicated", "shared"]) {
              expect(
                await page.evaluate(
                  ({ name, url }) =>
                    new Promise<boolean>((resolve) => {
                      const worker = (globalThis as any)[name];
                      worker.onmessage = (event: MessageEvent) =>
                        resolve(event.data);
                      worker.postMessage(url);
                    }),
                  { name, url },
                ),
              ).toBe(true);
            }
          }
          // Popup/new-page navigation is gated before any Computer page observer.
          const fresh = await page.context().newPage();
          let blocked = false;
          try {
            const response = await fresh.goto(url);
            blocked = response?.status() === 403;
          } catch {
            blocked = true;
          }
          expect(blocked).toBe(true);
          await fresh.close();
        }
        if (visitor === owner) continue;
        // Normal sign-in redirects, long responses, uploads, downloads and WS
        // continue streaming; the gate never fetches or buffers HTTP responses.
        await visitor.reserveLogin(
          "redirect-login",
          redirect(site.url.href + "login"),
        );
        expect(
          (await page.context().cookies()).some(
            (cookie) => cookie.name === "fixture_redirect",
          ),
        ).toBe(true);
        visitor.cancelLogin("redirect-login");
        await page.goto(site.url.href);
        expect(
          await page.evaluate(async () => {
            const reader = (await fetch("/stream")).body!.getReader();
            const first = await reader.read();
            await reader.cancel();
            return new TextDecoder().decode(first.value);
          }),
        ).toBe("first-event");
        expect(
          await page.evaluate(async () =>
            (
              await fetch("/upload", {
                method: "POST",
                body: "x".repeat(65536),
              })
            ).text(),
          ),
        ).toHaveLength(65536);
        expect(
          await page.evaluate(
            () =>
              new Promise<string>((resolve, reject) => {
                const socket = new WebSocket(
                  location.origin.replace("http", "ws") + "/socket",
                );
                socket.onopen = () => socket.send("normal-websocket");
                socket.onmessage = (event) => {
                  resolve(event.data);
                  socket.close();
                };
                socket.onerror = () => reject(new Error("WS failed"));
              }),
          ),
        ).toBe("normal-websocket");
        const pending = page.waitForEvent("download");
        await page.evaluate(() => {
          const a = document.createElement("a");
          a.href = "/download";
          a.click();
        });
        const download = await pending;
        expect(readFileSync((await download.path())!, "utf8")).toBe(
          "download-bytes",
        );
        // A dead mandatory proxy must never fall back to direct localhost access.
        await (
          visitor as unknown as {
            egress: import("../src/server/browser-egress").BrowserEgress;
          }
        ).egress.close();
        expect(
          await page.evaluate(
            (url) =>
              new Promise<boolean>((resolve) => {
                const socket = new WebSocket(url);
                const timer = setTimeout(() => {
                  socket.close();
                  resolve(false);
                }, 3000);
                socket.onopen = () => {
                  clearTimeout(timer);
                  socket.close();
                  resolve(false);
                };
                socket.onerror = socket.onclose = () => {
                  clearTimeout(timer);
                  resolve(true);
                };
              }),
            site.url.href.replace("http", "ws") + "socket",
          ),
        ).toBe(true);
        await expect(
          page.goto(site.url.href + "proxy-stopped"),
        ).rejects.toThrow();
      }
    } finally {
      for (const visitor of visitors) await visitor.close();
      await owner.close();
      site.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  },
  90000,
);

test("native stream fallback to an unreserved port fails before browser attachment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-stream-collision-"));
  const occupied = createTcpServer((socket) => socket.destroy());
  await new Promise<void>((resolve) =>
    occupied.listen(0, "127.0.0.1", resolve),
  );
  const port = (occupied.address() as { port: number }).port;
  const protectedPorts: number[] = [];
  const controller = new AgentBrowser(dir);
  try {
    await expect(
      controller.start(
        "http://127.0.0.1:1",
        (actual) => protectedPorts.push(actual),
        port,
      ),
    ).rejects.toThrow("control port changed");
    expect(protectedPorts).toHaveLength(1);
    expect(protectedPorts[0]).not.toBe(port);
  } finally {
    await controller.close();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
