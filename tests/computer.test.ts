import { WebSocket } from "ws";
import { expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startApp } from "./fixtures/app";
import { Computer } from "../src/server/computer";
import type { BrowserContext } from "playwright-core";
async function until(fn: () => boolean) {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw new Error("Condition timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}
class Rfb {
  data = Buffer.alloc(0);
  closed = false;
  wake = () => {};
  constructor(readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (e) => {
      this.data = Buffer.concat([
        this.data,
        Buffer.from(e.data as ArrayBuffer),
      ]);
      this.wake();
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      this.wake();
    });
  }
  async read(n: number) {
    const end = Date.now() + 5000;
    while (this.data.length < n) {
      if (this.closed) throw new Error("RFB closed before enough bytes");
      if (Date.now() > end) throw new Error("RFB read timed out");
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, 25);
      });
    }
    const out = this.data.subarray(0, n);
    this.data = this.data.subarray(n);
    return out;
  }
  send(data: number[] | Buffer) {
    this.ws.send(Buffer.from(data));
  }
  async handshake() {
    expect((await this.read(12)).toString()).toBe("RFB 003.008\n");
    this.send(Buffer.from("RFB 003.008\n"));
    const count = (await this.read(1))[0]!;
    expect([...(await this.read(count))]).toContain(1);
    this.send([1]);
    expect((await this.read(4)).readUInt32BE()).toBe(0);
    this.send([1]);
    const init = await this.read(24);
    expect(init.readUInt16BE()).toBe(1280);
    expect(init.readUInt16BE(2)).toBe(800);
    await this.read(init.readUInt32BE(20));
  }
  click(x: number, y: number) {
    for (const mask of [1, 0]) {
      const b = Buffer.alloc(6);
      b[0] = 5;
      b[1] = mask;
      b.writeUInt16BE(x, 2);
      b.writeUInt16BE(y, 4);
      this.send(b);
    }
  }
  key(key: number, down: boolean) {
    const b = Buffer.alloc(8);
    b[0] = 4;
    b[1] = down ? 1 : 0;
    b.writeUInt32BE(key, 4);
    this.send(b);
  }
  type(value: string) {
    for (const c of value) {
      this.key(c.charCodeAt(0), true);
      this.key(c.charCodeAt(0), false);
    }
  }
  enter() {
    this.key(0xff0d, true);
    this.key(0xff0d, false);
  }
  close() {
    this.ws.close();
  }
}
const runtime = resolve(".jelly/runtime");
const available =
  process.platform === "linux" &&
  existsSync(join(runtime, "usr/bin/Xvfb")) &&
  existsSync("/usr/bin/google-chrome");
(available ? test : test.skip)(
  "login popup closes and browser actions resume on the signed-in opener",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "jelly-popup-test-"));
    symlinkSync(runtime, join(dir, "runtime"), "dir");
    const computer = new Computer(dir);
    let sessionSeen = false;
    const site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/popup")
          return new Response(
            '<button onclick="window.close()">Finish login</button>',
            {
              headers: {
                "Content-Type": "text/html",
                "Set-Cookie": "popup_session=logged-in; HttpOnly; Path=/",
              },
            },
          );
        if (path === "/session")
          sessionSeen =
            req.headers.get("cookie")?.includes("popup_session=logged-in") ??
            false;
        return new Response('<a style="position:absolute;top:100px" href="/popup" target="_blank">Sign in</a>', {
          headers: { "Content-Type": "text/html" },
        });
      },
    });
    try {
      await computer.reserveLogin("popup-login", site.url.href);
      // Playwright simulates the person interacting during the private handoff.
      const context = (computer as unknown as { context: BrowserContext })
        .context;
      const opener = context.pages()[0]!;
      const popupOpened = context.waitForEvent("page");
      await opener.click("a");
      const popup = await popupOpened;
      await popup.waitForLoadState();
      const popupClosed = popup.waitForEvent("close");
      await popup.click("button");
      await popupClosed;
      computer.cancelLogin("popup-login");
      const shot = (await computer.action("screenshot")) as { image: string };
      expect(Buffer.from(shot.image, "base64").subarray(1, 4).toString()).toBe(
        "PNG",
      );
      const sessionUrl = new URL("/session", site.url).href;
      await computer.action("open", { url: sessionUrl });
      expect(opener.url()).toBe(sessionUrl);
      expect(sessionSeen).toBe(true);
      expect(context.pages()).toEqual([opener]);
    } finally {
      await computer.close();
      site.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);
(available ? test : test.skip)(
  "real VNC frames, view-only input enforcement, private human handoff and persisted browser sign-in",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "jelly-desktop-test-"));
    symlinkSync(runtime, join(dir, "runtime"), "dir");
    let jellyOrigin = "";
    let keys: string[] = [],
      signedIn = false,
      sessionSeen = false;
    const site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/redirect-jelly")
          return Response.redirect(jellyOrigin);
        if (url.pathname === "/key") {
          keys.push(url.searchParams.get("k") ?? "");
          return new Response("ok");
        }
        if (url.pathname === "/login") {
          signedIn = url.searchParams.get("p") === "test-login";
          return new Response("Signed in", {
            headers: {
              "Set-Cookie":
                "fixture_session=logged-in; HttpOnly; Path=/; Max-Age=3600",
            },
          });
        }
        if (url.pathname === "/session") {
          sessionSeen =
            req.headers.get("cookie")?.includes("fixture_session=logged-in") ??
            false;
          return new Response(sessionSeen ? "Session retained" : "No session");
        }
        return new Response(
          '<!doctype html><form action="/login"><input name="p" autofocus type="password" style="width:300px;height:40px"><button>Sign in</button></form><script>document.addEventListener("keydown",e=>fetch("/key?k="+encodeURIComponent(e.key)));</script>',
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    let app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0, fixtureDelayMs: 1 });
    const clients: Rfb[] = [];
    const req = (
      path: string,
      data?: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(new URL("/api" + path + (path.startsWith("/computer") ? "?agentId=" + app.service.snapshot().selectedAgentId : ""), app.server.url), {
        method: data === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    const session = async () => {
      const res = await req("/control-session");
      return {
        cookie: res.headers.get("set-cookie")!.split(";")[0]!,
        "x-jelly-csrf": (await res.json()).csrf as string,
      };
    };
    const connect = async (headers: Record<string, string>, mode = "view") => {
      const res = await req("/computer/ticket", { mode }, headers);
      expect(res.status).toBe(200);
      const { ticket } = await res.json();
      const url = new URL(
        "/api/computer/socket?agentId=" + app.service.snapshot().selectedAgentId + "&ticket=" + ticket,
        app.server.url,
      );
      url.protocol = "ws:";
      const ws = new WebSocket(url, {
        headers: { ...headers, Origin: app.server.url.origin },
      });
      const rfb = new Rfb(ws);
      clients.push(rfb);
      await rfb.handshake();
      return { rfb, url };
    };
    try {
      jellyOrigin = app.server.url.origin;
      const owner = await session(),
        other = await session();
      expect((await req("/computer/start", {}, owner)).status).toBe(200);
      await expect(
        app.service.computer.get(app.service.snapshot().selectedAgentId!).action("open", { url: app.server.url.href }),
      ).rejects.toThrow("control interface");
      const redirectResult = (await app.service.computer.get(app.service.snapshot().selectedAgentId!).action("open", {
        url: new URL("/redirect-jelly", site.url).href,
      })) as { status: number };
      expect(redirectResult.status).toBe(403);
      await app.service.computer.get(app.service.snapshot().selectedAgentId!).action("open", { url: site.url.href });
      const { rfb: viewer, url: used } = await connect(other);
      // Request a small raw rectangle from the actual framebuffer.
      viewer.send([2, 0, 0, 1, 0, 0, 0, 0]);
      viewer.send([3, 0, 0, 0, 0, 0, 0, 64, 0, 64]);
      const update = await viewer.read(4);
      expect(update[0]).toBe(0);
      expect(update.readUInt16BE(2)).toBeGreaterThan(0);
      const rect = await viewer.read(12);
      expect(rect.readInt32BE(8)).toBe(0);
      expect(
        (await viewer.read(rect.readUInt16BE(4) * rect.readUInt16BE(6) * 4))
          .length,
      ).toBeGreaterThan(0);
      viewer.type("forbidden");
      await new Promise((r) => setTimeout(r, 150));
      expect(keys).toEqual([]);
      const replay = await fetch(used.href.replace("ws:", "http:"), {
        headers: { ...other, Origin: app.server.url.origin },
      });
      expect(replay.status).toBe(403);
      app.service.setMode("api");
      const agent = app.store.agents()[0]!.id;
      app.service.start(
        agent,
        crypto.randomUUID(),
        "/fixture login " + site.url.href,
      );
      await until(() => app.service.computer.get(app.service.snapshot().selectedAgentId!).state().handoffId !== null);
      await until(() => viewer.closed);
      expect(
        (await req("/computer/ticket", { mode: "view" }, other)).status,
      ).toBe(403);
      expect((await req("/computer/take", {}, owner)).status).toBe(200);
      expect((await req("/computer/take", {}, other)).status).toBe(409);
      await expect(app.service.computer.get(app.service.snapshot().selectedAgentId!).action("screenshot")).rejects.toThrow(
        "person",
      );
      await expect(
        app.service.computer.get(app.service.snapshot().selectedAgentId!).action("type", { text: "not allowed" }),
      ).rejects.toThrow("person");
      const { rfb: controller } = await connect(owner, "control");
      controller.click(100, 140);
      await new Promise((r) => setTimeout(r, 100));
      controller.type("test-login");
      controller.enter();
      await until(() => signedIn);
      controller.close();
      await until(() => controller.closed);
      expect(app.service.computer.get(app.service.snapshot().selectedAgentId!).state().control).toBe("human");
      const { rfb: reconnected } = await connect(owner, "control");
      expect((await req("/computer/release", {}, other)).status).toBe(403);
      reconnected.close();
      await until(() => reconnected.closed);
      expect((await req("/computer/release", {}, owner)).status).toBe(200);
      await app.service.settled();
      await until(() => reconnected.closed);
      expect(app.store.interventions()[0]?.status).toBe("completed");
      expect(app.store.runs(agent)[0]?.status).toBe("completed");
      await app.service.computer.get(app.service.snapshot().selectedAgentId!).action("open", {
        url: new URL("/session", site.url).href,
      });
      expect(sessionSeen).toBe(true);
      expect(JSON.stringify(app.service.snapshot())).not.toContain(
        "test-login",
      );
      expect(JSON.stringify(app.store.history(agent))).not.toContain(
        "test-login",
      );
      for (const client of clients) client.close();
      await until(() => clients.every(client => client.closed));
      // Same profile, new server process state: browser cookies survive orderly restart.
      await app.close();
      app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
      sessionSeen = false;
      await app.service.computer.get(app.service.snapshot().selectedAgentId!).action("open", {
        url: new URL("/session", site.url).href,
      });
      expect(sessionSeen).toBe(true);
    } finally {
      for (const c of clients) c.close();
      await app.close();
      site.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  },
  45000,
);

(available && (existsSync("/usr/bin/xclip") || existsSync(join(runtime, "usr/bin/xclip"))) ? test : test.skip)(
  "private remote clipboard transfers Unicode over HTTP, pastes through VNC, and clears on return",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "jelly-clipboard-test-"));
    symlinkSync(runtime, join(dir, "runtime"), "dir");
    const app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
    const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
      '<textarea autofocus style="width:500px;height:250px"></textarea>',
      { headers: { "Content-Type": "text/html" } },
    ) });
    let controller: Rfb | undefined;
    const post = (action: string, data: unknown, headers: Record<string, string> = {}) => fetch(new URL(`/api/computer/${action}?agentId=${app.service.snapshot().selectedAgentId}`, app.server.url), {
      method: "POST", headers: { "Content-Type": "application/json", Connection: "close", ...headers }, body: JSON.stringify(data),
    });
    const session = async () => {
      const response = await fetch(new URL("/api/control-session", app.server.url), { headers: { Connection: "close" } });
      return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, "x-jelly-csrf": (await response.json()).csrf as string };
    };
    try {
      const owner = await session(), other = await session();
      expect((await post("clipboard", { operation: "read" })).status).toBe(401);
      expect((await post("clipboard", { operation: "read" }, { cookie: owner.cookie })).status).toBe(403);
      expect((await post("clipboard", { operation: "read" }, owner)).status).toBe(403);
      await app.service.computer.get(app.service.snapshot().selectedAgentId!).action("open", { url: site.url.href });
      expect((await post("take", {}, owner)).status).toBe(200);
      expect((await post("clipboard", { operation: "read" }, other)).status).toBe(403);
      expect((await post("clipboard", { operation: "write", text: "x".repeat(12001) }, owner)).status).toBe(400);
      expect((await post("clipboard", { operation: "write", text: "bad\0text" }, owner)).status).toBe(400);
      expect((await post("clipboard", { operation: "delete" }, owner)).status).toBe(400);
      const { ticket } = await (await post("ticket", { mode: "control" }, owner)).json();
      const socketUrl = new URL(`/api/computer/socket?agentId=${app.service.snapshot().selectedAgentId}&ticket=${ticket}`, app.server.url); socketUrl.protocol = "ws:";
      controller = new Rfb(new WebSocket(socketUrl, { headers: { ...owner, Origin: app.server.url.origin } }));
      await controller.handshake();
      // Playwright here simulates the person, not an agent browser action.
      const context = (app.service.computer.get(app.service.snapshot().selectedAgentId!) as unknown as { context: BrowserContext }).context;
      const page = context.pages()[0]!;
      await page.locator("textarea").click();
      const text = "Private clipboard fixture 🦀\n日本語 and café";
      const written = await post("clipboard", { operation: "write", text }, owner);
      expect(written.status).toBe(200);
      expect(written.headers.get("cache-control")).toBe("no-store");
      controller.key(0xffe3, true); controller.key(0x76, true); controller.key(0x76, false); controller.key(0xffe3, false);
      await page.waitForFunction(expected => (document.querySelector("textarea") as HTMLTextAreaElement).value === expected, text);
      expect(await page.locator("textarea").inputValue()).toBe(text);
      const copied = "Copied from the remote browser: 🐙\nsecond line";
      await page.locator("textarea").fill(copied);
      await page.locator("textarea").press("Control+a");
      await page.locator("textarea").press("Control+c");
      expect(await (await post("clipboard", { operation: "read" }, owner)).json()).toEqual({ text: copied });
      await expect(app.service.computer.get(app.service.snapshot().selectedAgentId!).action("screenshot")).rejects.toThrow("person");
      expect(JSON.stringify(app.service.snapshot())).not.toContain("Private clipboard fixture");
      expect(JSON.stringify(app.store.events())).not.toContain(copied);
      await page.locator("textarea").fill("x".repeat(12001));
      await page.locator("textarea").press("Control+a");
      await page.locator("textarea").press("Control+c");
      expect((await post("clipboard", { operation: "read" }, owner)).status).toBe(413);
      // Close the fixture's VNC client explicitly: Bun can retain a server-closed
      // WebSocket in stop(true), independently of clipboard ownership checks.
      controller.close();
      await until(() => controller!.closed);
      expect((await post("release", {}, owner)).status).toBe(200);
      await until(() => controller!.closed);
      expect((await post("clipboard", { operation: "read" }, owner)).status).toBe(403);
      // Taking control again must not expose the prior clipboard.
      expect((await post("take", {}, owner)).status).toBe(200);
      expect(await (await post("clipboard", { operation: "read" }, owner)).json()).toEqual({ text: "" });
      expect((await post("release", {}, owner)).status).toBe(200);
    } finally {
      controller?.close();
      await app.close();
      site.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000,
);

(available ? test : test.skip)("two real agent desktops isolate pages, focus, private handoffs and tickets", async () => {
  const { ComputerSessions } = await import("../src/server/computer-sessions");
  const dir = mkdtempSync(join(tmpdir(), "jelly-isolated-desktops-"));
  symlinkSync(runtime, join(dir, "runtime"), "dir");
  const sessions = new ComputerSessions(dir, id => ["a", "b"].includes(id));
  const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new Response(
    `<body style="background:${new URL(request.url).pathname === "/a" ? "red" : "blue"}"><input style="position:absolute;left:10px;top:10px;width:300px;height:50px"><a style="position:absolute;top:100px" href="/popup" target="_blank">popup</a></body>`,
    { headers: { "Content-Type": "text/html" } },
  ) });
  try {
    const a = sessions.get("a"), b = sessions.get("b");
    await Promise.all([a.action("open", { url: new URL("/a", site.url).href }), b.action("open", { url: new URL("/b", site.url).href })]);
    await Promise.all([a.action("click", { x: 50, y: 30 }), b.action("click", { x: 50, y: 30 })]);
    await Promise.all([a.action("type", { text: "only-a" }), b.action("type", { text: "only-b" })]);
    const context = (computer: Computer) => (computer as unknown as { context: BrowserContext }).context;
    const pageA = context(a).pages()[0]!, pageB = context(b).pages()[0]!;
    expect(await pageA.locator("input").inputValue()).toBe("only-a");
    expect(await pageB.locator("input").inputValue()).toBe("only-b");
    const shots = await Promise.all([a.action("screenshot"), b.action("screenshot")]);
    expect(shots[0]).not.toEqual(shots[1]);
    const popupPromise = context(a).waitForEvent("page");
    await pageA.locator("a").click();
    const popup = await popupPromise;
    await popup.close();
    await a.action("type", { text: "" });
    expect((a as unknown as { page: unknown }).page).toBe(pageA);
    expect(context(a).pages()).not.toContain(pageB);
    const display = (computer: Computer) => (computer as unknown as { clipboardEnv: { DISPLAY: string } }).clipboardEnv.DISPLAY;
    expect(display(a)).not.toBe(display(b));
    await a.reserveLogin("private-a", new URL("/a", site.url).href);
    await a.take("human-a");
    await expect(a.action("screenshot")).rejects.toThrow("person");
    await b.action("type", { text: "-still-b" });
    expect(await pageB.locator("input").inputValue()).toBe("only-b-still-b");
    await b.action("screenshot");
    const { ticket } = await a.ticket("human-a", "control");
    expect(() => b.consume(ticket, "human-a")).toThrow("Expired");
    expect(a.consume(ticket, "human-a").path).not.toBe(b.consume((await b.ticket("human-a", "view")).ticket, "human-a").path);
    await expect(b.clipboard("human-a", "read")).rejects.toThrow("controlling window");
  } finally {
    await sessions.close();
    site.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
