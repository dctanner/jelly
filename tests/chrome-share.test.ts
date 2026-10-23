import { expect, test } from "bun:test";
import { connect, createServer, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { bindChromeDesktop, localX11Desktop } from "../src/server/chrome-desktop";
import { COMPUTER_CLIPBOARD_BODY_BYTES, validClipboardText } from "../src/shared/computer-clipboard";
import { ChromeSessions } from "../src/server/chrome-sessions";
import { ChromeShare } from "../src/server/chrome-share";
import {
  CHROME_METHODS,
  CHROME_PROTOCOL,
  ChromeFrames,
  chromeFrame,
} from "../src/shared/chrome-protocol";
import { startApp } from "./fixtures/app";

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
async function waitFor(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Fixture timed out");
    await Bun.sleep(5);
  }
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-chrome-share-test-"));
  symlinkSync(resolve(".jelly/runtime"), join(dir, "runtime"));
  const auth = join(dir, "Xauthority");
  writeFileSync(auth, "test", { mode: 0o600 });
  const chrome = new ChromeSessions(dir, "share-test");
  await chrome.bridge.ready;
  const sockets: Socket[] = [];
  const peers: any[] = [];
  const config = JSON.parse(
    readFileSync(join(chrome.bridge.directory, "pairing.json"), "utf8"),
  );
  writeFileSync(join(chrome.bridge.directory, "extension-id"), "a".repeat(32), {
    mode: 0o600,
  });
  async function peer() {
    const profile = crypto.randomUUID(),
      generation = crypto.randomUUID();
    const socket = connect(config.socket);
    sockets.push(socket);
    const requests: any[] = [],
      frames = new ChromeFrames();
    let frozen = false;
    let onCall = async (r: any): Promise<unknown> =>
      r.method === "freeze"
        ? { frozen: true }
        : r.method === "open"
          ? { pageId: crypto.randomUUID() }
          : { ok: true };
    socket.on("error", () => {});
    socket.on("data", (b) => {
      for (const r of frames.push(Buffer.from(b)) as any[]) {
        requests.push(r);
        if (r.type === "paired") continue;
        if (r.method === "freeze") frozen = true;
        void onCall(r).then(
          (result) => {
            if (r.method === "unfreeze") frozen = false;
            socket.write(
              chromeFrame({ jsonrpc: "2.0", id: r.id, generation, result }),
            );
          },
          () =>
            socket.write(
              chromeFrame({
                jsonrpc: "2.0",
                id: r.id,
                generation,
                error: { code: -1 },
              }),
            ),
        );
      }
    });
    socket.write(
      chromeFrame({
        type: "hello",
        version: CHROME_PROTOCOL,
        capabilities: CHROME_METHODS,
        instance: "share-test",
        grant: config.grant,
        extensionId: "a".repeat(32),
        profile,
        generation,
        desktop: { available: true, display: ":3999", auth },
      }),
    );
    await waitFor(() => requests.length > 0 || socket.destroyed);
    const result = {
      profile,
      generation,
      socket,
      requests,
      frozen: () => frozen,
      onCall: (fn: typeof onCall) => {
        onCall = fn;
      },
    };
    peers.push(result);
    return result;
  }
  const share = new ChromeShare(chrome, dir, async () => {});
  const selection = (profile: string) => ({
    chromeProfile: profile,
  });
  return {
    dir,
    chrome,
    share,
    auth,
    peer,
    selection,
    close: async () => {
      await share.close();
      for (const s of sockets) s.destroy();
      await waitFor(() => !chrome.bridge.profiles().length);
      await chrome.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("local desktop binding accepts only explicitly local Linux X11 with private authorization", () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-desktop-attestation-"));
  const auth = join(dir, "auth");
  writeFileSync(auth, "private", { mode: 0o600 });
  const env = { XDG_SESSION_TYPE: "x11", DISPLAY: ":17.0", XAUTHORITY: auth };
  try {
    expect(localX11Desktop(env)).toEqual({
      available: true,
      display: ":17.0",
      auth,
    });
    for (const changed of [
      { DISPLAY: "localhost:0" },
      { DISPLAY: "host:0" },
      { DISPLAY: ":0;evil" },
      { XDG_SESSION_TYPE: "wayland" },
      { XDG_SESSION_TYPE: "" },
      { WAYLAND_DISPLAY: "wayland-0" },
      { XAUTHORITY: "relative" },
      { XAUTHORITY: "/does/not/exist" },
    ])
      expect(localX11Desktop({ ...env, ...changed })).toEqual({
        available: false,
      });
    expect(localX11Desktop(env, "darwin")).toEqual({ available: false });
    expect(localX11Desktop(env, "win32")).toEqual({ available: false });
    chmodSync(auth, 0o644);
    expect(localX11Desktop(env)).toEqual({ available: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("human-use status never revokes in-flight results or blocks cached and newly allocated ports", async () => {
  const f = await fixture(), ack = gate();
  try {
    const a = await f.peer(), b = await f.peer();
    a.onCall(async r => { if (r.method === "snapshot") await ack.promise; return { ok: true }; });
    const browser = f.chrome.allocate("a", "run", f.selection(a.profile), "A");
    const delayed = browser.action("snapshot");
    await waitFor(() => a.requests.some(r => r.method === "snapshot"));
    f.chrome.setHumanDesktop(true);
    const fresh = f.chrome.allocate("b", "run-b", f.selection(b.profile), "B");
    expect(await fresh.action("snapshot")).toMatchObject({ humanUsing: true });
    const peer = await f.peer(); expect(peer.requests[0].type).toBe("paired");
    ack.resolve(); expect(await delayed).toMatchObject({ humanUsing: true });
    f.chrome.setHumanDesktop(false);
    expect(await browser.action("snapshot")).toMatchObject({ humanUsing: false });
  } finally { ack.resolve(); await f.close(); }
});

test("taking computer control is advisory during delayed capture; owner and stale generations remain isolated", async () => {
  const f = await fixture(), ready = gate();
  try {
    const p = await f.peer();
    const browser = f.chrome.allocate("a", "run", f.selection(p.profile), "A");
    await browser.action("open", { url: "https://example.com" });
    Object.assign(f.share, { startCapture: async () => { await ready.promise; (f.share as any).status = "sharing"; } });
    const taking = f.share.take("owner", "a", p.profile, p.generation);
    expect(f.chrome.humanState()).toBe(true);
    expect(await browser.action("snapshot")).toMatchObject({ humanUsing: true });
    expect(() => f.share.ticket("owner", 0)).toThrow();
    await expect(f.share.take("other", "a", p.profile, p.generation)).rejects.toThrow();
    await expect(f.share.release("other", f.share.state().generation)).rejects.toThrow("private");
    await expect(f.share.release("owner", -1)).rejects.toThrow("Stale");
    ready.resolve(); await taking;
    expect(await browser.action("snapshot")).toMatchObject({ humanUsing: true });
    await f.share.release("owner", f.share.state().generation);
    expect(await browser.action("snapshot")).toMatchObject({ humanUsing: false });
    expect(p.requests.some(r => ["freeze", "unfreeze", "pause", "resume"].includes(r.method))).toBe(false);
  } finally { ready.resolve(); await f.close(); }
});

test("Done binds one Take and one computer, survives socket churn/failure, and rejects a replaced Take", async () => {
  const f = await fixture();
  try {
    const p = await f.peer(), other = await f.peer();
    const a = f.chrome.allocate("a", "run-a", f.selection(p.profile), "A");
    const b = f.chrome.allocate("b", "run-b", f.selection(other.profile), "B");
    await a.reserveLogin("login-a", "https://example.com");
    await b.reserveLogin("login-b", "https://example.com");
    Object.assign(f.share, { startCapture: async () => { (f.share as any).status = "sharing"; } });
    const completed: string[] = [];
    f.share.onDone = handoffs => {
      for (const h of handoffs) { f.chrome.done(h.agent, h.id); completed.push(h.id); }
    };
    const first = await f.share.take("owner", "a", p.profile, p.generation);
    const stop = (f.share as any).stopCapture.bind(f.share);
    Object.assign(f.share, {
      generation: first.generation + 3,
      status: "failed",
      stopCapture: async () => { throw new Error("uncertain cleanup"); },
    });
    await expect(f.share.release("owner", first.generation, false, first.controlId)).rejects.toThrow();
    expect(completed).toEqual(["login-a"]);
    expect(f.chrome.state("b").task?.handoff).toBe("login-b");
    expect(f.chrome.state("a").task?.humanUsing).toBe(false);
    Object.assign(f.share, { stopCapture: stop });
    await f.share.release("owner", first.generation, true, first.controlId);
    const second = await f.share.take("owner", "b", other.profile, other.generation);
    expect(second.controlId).not.toBe(first.controlId);
    await expect(f.share.release("owner", second.generation, false, first.controlId)).rejects.toThrow("Stale");
    await expect(f.share.reconnect("owner", second.generation, first.controlId)).rejects.toThrow();
    expect(f.chrome.state("b").task?.handoff).toBe("login-b");
    await f.share.release("owner", second.generation, false, second.controlId);
    expect(completed).toEqual(["login-a", "login-b"]);
  } finally { await f.close(); }
});

test("single-use expiring tickets bind owner and epoch; forwarding/reconnect and owner expiry revoke old connections", async () => {
  const f = await fixture();
  try {
    const p = await f.peer();
    Object.assign(f.share, {
      status: "sharing",
      owner: "owner",
      profile: p.profile,
      profileGeneration: p.generation,
      runtime: f.dir,
    });
    expect(() => f.share.ticket("other", f.share.state().generation)).toThrow(
      "private",
    );
    const first = f.share.ticket("owner", f.share.state().generation);
    const c = f.share.consume(first.ticket, "owner");
    expect(() => f.share.consume(first.ticket, "owner")).toThrow("Expired");
    const second = f.share.ticket("owner", first.generation);
    expect(f.share.validConnection(c.generation, "owner")).toBe(false);
    expect(() => f.share.consume(second.ticket, "other")).toThrow("foreign");
    const third = f.share.ticket("owner", second.generation);
    (f.share as any).tickets.get(third.ticket).expires = Date.now() - 1;
    expect(() => f.share.consume(third.ticket, "owner")).toThrow("Expired");
    const fourth = f.share.ticket("owner", third.generation);
    f.share.ownerValid = () => false;
    expect(f.share.validConnection(fourth.generation, "owner")).toBe(false);
    expect(f.share.state().status).toBe("orphaned");
    expect(() => f.share.consume(fourth.ticket, "owner")).toThrow();
    Object.assign(f.share, { runtime: null }); // Unit state has no spawned capture process.
  } finally {
    await f.close();
  }
});

test("target connection loss revokes viewer tickets without blocking other browser profiles", async () => {
  const f = await fixture();
  try {
    const p = await f.peer(), other = await f.peer();
    Object.assign(f.share, { startCapture: async () => { (f.share as any).status = "sharing"; } });
    await f.share.take("owner", "a", p.profile, p.generation);
    const ticket = f.share.ticket("owner", f.share.state().generation);
    p.socket.destroy();
    await waitFor(() => f.share.state().status === "failed");
    expect(() => f.share.consume(ticket.ticket, "owner")).toThrow();
    const browser = f.chrome.allocate("b", "run", f.selection(other.profile), "B");
    expect(await browser.action("snapshot")).toMatchObject({ humanUsing: true });
    expect(f.chrome.humanState()).toBe(true);
  } finally { await f.close(); }
});

test("restart latch permits only explicit cleanup-without-viewing, never restores tasks or old owner", async () => {
  const f = await fixture();
  let restarted: ChromeShare | undefined;
  try {
    const p = await f.peer();
    p.onCall(async () => {
      throw new Error("detach failed");
    });
    await f.share.take("owner", "a", p.profile, p.generation).catch(() => {});
    await f.share.close();
    restarted = new ChromeShare(f.chrome, f.dir, async () => {});
    expect(restarted.state("owner").status).toBe("orphaned");
    expect(restarted.state("owner").owned).toBe(false);
    expect(() =>
      restarted!.ticket("new", restarted!.state().generation),
    ).toThrow("private");
    expect(
      await restarted
        .release("new", restarted.state().generation)
        .catch((e) => e.status),
    ).toBe(400);
    // A real restart loses all bridge peers. No old capability is reconstructed.
    p.socket.destroy();
    await waitFor(() => !f.chrome.bridge.profiles().length);
    await restarted.release("new", restarted.state().generation, true);
    expect(f.chrome.humanState()).toBe(false);
    expect(restarted.state().status).toBe("idle");
  } finally {
    await restarted?.close();
    await f.close();
  }
});

test("Chrome share API protects reads, direct take, tickets, stale profiles and alternate desktop/resume routes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-chrome-share-api-"));
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
  });
  try {
    const origin = app.server.url.origin;
    const auth = await fetch(`${origin}/api/control-session`);
    const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
    const { csrf } = (await auth.json()) as { csrf: string };
    const headers = {
      cookie,
      "x-jelly-csrf": csrf,
      "content-type": "application/json",
    };
    const post = (
      path: string,
      body = {},
      h: Record<string, string> = headers,
    ) =>
      fetch(`${origin}/api/${path}`, {
        method: "POST",
        headers: h,
        body: JSON.stringify(body),
      });
    expect((await fetch(`${origin}/api/chrome/share`)).status).toBe(401);
    expect(
      (
        await post(
          "chrome/share/take",
          {},
          { cookie, "content-type": "application/json" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          "chrome/share/ticket",
          {},
          { ...headers, origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post("chrome/share/take", {
          agentId: app.store.agents()[0]!.id,
          profile: crypto.randomUUID(),
          profileGeneration: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409);
    const publicState = await (
      await fetch(`${origin}/api/chrome/share`, { headers })
    ).text();
    expect(publicState).not.toMatch(/DISPLAY|XAUTHORITY|\/tmp\//);
    Object.assign(app.service.chromeShare, { status: "failed" });
    for (const route of [
      "desktop/connect",
      "desktop/settings",
    ])
      expect((await post(route)).status).toBe(409);
    expect(
      (await post("chrome/resume", { agentId: app.store.agents()[0]!.id }))
        .status,
    ).toBe(400);
    expect((await post("chrome/share/ticket", { generation: 0 })).status).toBe(
      403,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("owner expiry during delayed viewer cleanup retains cleanup obligation, never browser permission", async () => {
  const f = await fixture(), ack = gate();
  try {
    const p = await f.peer();
    Object.assign(f.share, { status: "disconnected", owner: "owner", profile: p.profile, profileGeneration: p.generation,
      stopCapture: () => ack.promise });
    (f.share as any).persist();
    let valid = true;
    f.share.ownerValid = () => valid;
    const release = f.share.release("owner", f.share.state().generation).catch(e => e.status);
    valid = false; ack.resolve();
    expect(await release).toBe(409);
    expect(f.share.state().status).toBe("orphaned");
    expect(existsSync(join(f.chrome.bridge.directory, "desktop-share.json"))).toBe(true);
    expect(await f.chrome.allocate("fresh", "run", f.selection(p.profile), "Fresh").action("snapshot")).toMatchObject({ humanUsing: false });
  } finally { ack.resolve(); await f.close(); }
});

test("unavailable exact X11 backend fails closed without leaking native paths or display metadata", async () => {
  const f = await fixture();
  try {
    const p = await f.peer(); // Its attested fixture display does not exist.
    expect(
      await f.share
        .take("owner", "agent", p.profile, p.generation)
        .catch((e) => e.status),
    ).toBe(409);
    expect(f.share.state().status).toBe("failed");
    expect(f.chrome.humanState()).toBe(true);
    expect(f.share.state().error).not.toMatch(
      /\/tmp|Xauthority|3999|ENOENT|grant/,
    );
    expect((f.share as any).process).toBeNull();
    await f.share.release("owner", f.share.state().generation, true);
  } finally {
    await f.close();
  }
});

test("app shutdown closes the real Chrome bridge after share cleanup rejects and preserves the privacy latch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-chrome-share-shutdown-"));
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
  });
  const bridge = app.service.chrome.bridge;
  await bridge.ready;
  const socketPath = join(bridge.directory, "bridge.sock");
  const latch = join(bridge.directory, "desktop-share.json");
  const canConnect = () =>
    new Promise<boolean>((resolve) => {
      const socket = connect(socketPath);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
  const failure = new Error("Fixture input cleanup remains uncertain");
  const closeChrome = app.service.chrome.close.bind(app.service.chrome);
  let chromeClosed = false;
  app.service.chrome.close = async () => {
    await closeChrome();
    chromeClosed = true;
  };
  try {
    expect(await canConnect()).toBe(true);
    Object.assign(app.service.chromeShare, { status: "failed" });
    writeFileSync(latch, JSON.stringify({ runtime: null }), { mode: 0o600 });
    Object.assign(app.service.chromeShare, {
      status: "failed",
      stopCapture: async () => {
        throw failure;
      },
    });
    await expect(app.close()).rejects.toBe(failure);
    expect(chromeClosed).toBe(true);
    expect(await canConnect()).toBe(false);
    expect(existsSync(latch)).toBe(true);
    expect(app.service.chromeShare.state().status).not.toBe("idle");
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup after target disconnect never revives lost tabs or waits for unrelated Chrome peers", async () => {
  const f = await fixture(), cleanup = gate();
  try {
    const a = await f.peer(), b = await f.peer();
    const old = f.chrome.allocate("a", "run-a", f.selection(a.profile), "A");
    await old.action("open", { url: "https://example.com" });
    await f.share.take("owner", "a", a.profile, a.generation).catch(() => {});
    a.socket.destroy();
    await waitFor(() => f.chrome.state("a").task?.connected === false);
    const browser = f.chrome.allocate("b", "run-b", f.selection(b.profile), "B");
    Object.assign(f.share, { stopCapture: () => cleanup.promise });
    const handback = f.share.release("owner", f.share.state().generation, true);
    expect(await browser.action("snapshot")).toMatchObject({ humanUsing: false });
    cleanup.resolve(); await handback;
    await expect(old.action("snapshot")).rejects.toThrow("expired");
    expect(b.requests.some(r => ["freeze", "unfreeze"].includes(r.method))).toBe(false);
  } finally { cleanup.resolve(); await f.close(); }
});

test("failed viewer cleanup clears advisory status and notifies bound handoffs once, while preserving repair", async () => {
  const f = await fixture();
  try {
    const p = await f.peer();
    const browser = f.chrome.allocate("a", "run", f.selection(p.profile), "A");
    await browser.reserveLogin("login", "https://example.com");
    Object.assign(f.share, { startCapture: async () => { (f.share as any).status = "sharing"; } });
    await f.share.take("owner", "a", p.profile, p.generation);
    const done: unknown[] = [];
    f.share.onDone = handoffs => { done.push(...handoffs); for (const h of handoffs) f.chrome.done(h.agent, h.id); };
    const stop = (f.share as any).stopCapture.bind(f.share);
    Object.assign(f.share, { stopCapture: async () => { throw new Error("cleanup failed"); } });
    await expect(f.share.release("owner", f.share.state().generation)).rejects.toThrow();
    expect(done).toEqual([{ agent: "a", id: "login" }]);
    expect(await browser.action("snapshot")).toMatchObject({ humanUsing: false });
    expect(existsSync(join(f.chrome.bridge.directory, "desktop-share.json"))).toBe(true);
    expect(() => f.share.ticket("owner", f.share.state().generation)).toThrow();
    Object.assign(f.share, { stopCapture: stop });
    await f.share.release("owner", f.share.state().generation, true);
    expect(done).toHaveLength(1);
  } finally { await f.close(); }
});

test("orphaned human-use status does not block current or newly allocated browser tasks", async () => {
  const f = await fixture();
  try {
    const p = await f.peer();
    const browser = f.chrome.allocate("a", "run", f.selection(p.profile), "A");
    await browser.action("open", { url: "https://example.com" });
    await f.share.take("expired", "a", p.profile, p.generation).catch(() => {});
    f.share.ownerValid = s => s === "new";
    expect(f.share.state("new").status).toBe("orphaned");
    expect(await browser.action("snapshot")).toMatchObject({ humanUsing: true });
    expect(await f.chrome.allocate("b", "run-b", f.selection(p.profile), "B").action("snapshot")).toMatchObject({ humanUsing: true });
    await f.share.release("new", f.share.state().generation, true);
    expect(await browser.action("snapshot")).toMatchObject({ humanUsing: false });
    expect(p.requests.some(r => r.method === "freeze")).toBe(false);
  } finally { await f.close(); }
});

test("overlapping viewer loss and handback stop the capture process only once", async () => {
  const f = await fixture(),
    released = gate();
  let signals = 0,
    cleanups = 0;
  class Capture extends EventEmitter {
    exitCode: number | null = null;
    signalCode: string | null = null;
    killed = false;
    kill() {
      signals++;
      if (this.killed) return false;
      this.killed = true;
      queueMicrotask(() => {
        this.exitCode = 2; // x11vnc's normal SIGTERM cleanup exit status.
        this.emit("exit", 2, null);
      });
      return true;
    }
  }
  Object.assign(f.share, {
    status: "stopping",
    process: new Capture(),
    inputCleanupRequired: true,
    inputHelper: async (mode: string) => {
      expect(mode).toBe("--release");
      cleanups++;
      await released.promise;
    },
  });
  try {
    const first = (f.share as any).stopCapture(false);
    const second = (f.share as any).stopCapture(false);
    await waitFor(() => cleanups === 1);
    expect(signals).toBe(1);
    expect((f.share as any).unexpectedExit).toBe(false);
    released.resolve();
    await Promise.all([first, second]);
    expect(cleanups).toBe(1);
    expect((f.share as any).inputCleanupRequired).toBe(false);
  } finally {
    released.resolve();
    await f.close();
  }
});

test("unrelated profile admission and loss during viewer cleanup cannot revoke the target computer", async () => {
  const f = await fixture(), ack = gate();
  try {
    const p = await f.peer();
    Object.assign(f.share, { status: "sharing", owner: "owner", profile: p.profile, profileGeneration: p.generation, stopCapture: () => ack.promise });
    (f.share as any).persist();
    const release = f.share.release("owner", f.share.state().generation);
    const other = await f.peer();
    expect(other.requests[0].type).toBe("paired");
    other.socket.destroy(); await waitFor(() => f.chrome.bridge.profiles().length === 1);
    ack.resolve();
    expect((await release).status).toBe("idle");
  } finally { ack.resolve(); await f.close(); }
});

test("viewer-disconnect cleanup cannot overwrite a newer stopping handback with disconnected", async () => {
  const f = await fixture(), stopped = gate();
  try {
    await f.peer();
    Object.assign(f.share, { status: "sharing", owner: "owner", frozen: true, stopCapture: () => stopped.promise });
    (f.share as any).persist();
    const disconnect = f.share.attach(() => {});
    disconnect();
    const release = f.share.release("owner", f.share.state().generation);
    stopped.resolve();
    expect((await release).status).toBe("idle");
    expect(f.chrome.humanState()).toBe(false);
    expect(existsSync(join(f.chrome.bridge.directory, "desktop-share.json"))).toBe(false);
  } finally { stopped.resolve(); await f.close(); }
});

test("cleanup-only orphan acquires native privacy exclusion without viewing before reopening admission", async () => {
  const f = await fixture();
  let safe = false, drained = 0;
  try {
    await f.peer();
    Object.assign(f.share, { status: "orphaned", owner: null, drainDesktop: async () => { drained++; safe = true; } });
    f.share.privacyValid = () => safe;
    (f.share as any).persist();
    expect((await f.share.release("fresh-owner", f.share.state().generation, true)).status).toBe("idle");
    expect(drained).toBe(1);
    expect(f.chrome.humanState()).toBe(false);
    expect((f.share as any).process).toBeNull();
  } finally { await f.close(); }
});

for (const restored of [false, true]) test(`already-clean owned Chrome death retires only cleanup latch (restored=${restored})`, async () => {
  const f = await fixture();
  let share = f.share;
  try {
    const peer = await f.peer();
    Object.assign(share, { status: "disconnected", owner: "owner", ownedGeneration: crypto.randomUUID(), binding: { fixture: true }, frozen: true });
    (share as any).persist();
    if (restored) {
      await share.close();
      share = new ChromeShare(f.chrome, f.dir, async () => {});
    }
    share.ownedDesktop.record = () => { throw new Error("dead Chrome"); };
    share.ownedDesktop.cleanupRecord = () => ({ fixture: "retained" }) as any;
    (share as any).inputHelper = async () => { throw new Error("must not replay input"); };
    (share as any).verifyOwnedAuth = async () => { throw new Error("must not replay auth"); };
    await expect(share.release("owner", share.state().generation)).rejects.toThrow();
    await expect(share.reconnect("owner", share.state().generation)).rejects.toThrow();
    // Browser peer failures cannot prevent native viewer cleanup.
    peer.onCall(async () => { throw new Error("unrelated browser fault"); });
    await share.release("owner", share.state().generation, true);
    expect(share.state().status).toBe("idle");
    expect(peer.requests.some(r => r.method === "freeze" || r.method === "unfreeze")).toBe(false);
    expect(existsSync(join(f.chrome.bridge.directory, "desktop-share.json"))).toBe(false);
  } finally { if (share !== f.share) await share.close(); await f.close(); }
});

for (const field of ["inputCleanupRequired", "authUncertain"]) for (const value of [undefined, null, 0, "false", true])
  test(`dead owned cleanup rejects ${field}=${String(value)}`, async () => {
    const f = await fixture();
    let restored: ChromeShare | undefined;
    try {
      const saved = { runtime: null, inputCleanupRequired: false, authUncertain: false, ownedGeneration: crypto.randomUUID(), binding: {} , [field]: value };
      writeFileSync(join(f.chrome.bridge.directory, "desktop-share.json"), JSON.stringify(saved), { mode: 0o600 });
      restored = new ChromeShare(f.chrome, f.dir, async () => {});
      restored.ownedDesktop.record = () => { throw new Error("dead Chrome"); };
      await expect(restored.release("new", 0, true)).rejects.toThrow();
      expect(f.chrome.humanState()).toBe(false);
      expect(existsSync(join(f.chrome.bridge.directory, "desktop-share.json"))).toBe(true);
    } finally {
      // Synthetic unresolved obligations have no native process to clean.
      if (restored) { Object.assign(restored, { inputCleanupRequired: false }); await restored.close(); }
      await f.close();
    }
  });

test("clean owned record replacement during native cleanup cannot retire the latch", async () => {
  const f = await fixture();
  try {
    const peer = await f.peer();
    Object.assign(f.share, { status: "failed", owner: "owner", ownedGeneration: crypto.randomUUID(), binding: {} });
    (f.share as any).persist();
    let stamp = "original";
    f.share.ownedDesktop.cleanupRecord = () => ({ stamp }) as any;
    Object.assign(f.share, { stopCapture: async () => { stamp = "replacement"; } });
    await expect(f.share.release("owner", 0, true)).rejects.toThrow("revoked");
    expect(f.chrome.humanState()).toBe(false);
    expect(peer.requests.some(r => r.method === "unfreeze")).toBe(false);
  } finally { await f.close(); }
});

test("clean owned recovery refuses missing runtime and changed durable completion evidence", async () => {
  const f = await fixture();
  try {
    Object.assign(f.share, { status: "failed", owner: "owner", ownedGeneration: crypto.randomUUID(), binding: {} });
    f.share.ownedDesktop.cleanupRecord = () => ({ retained: true }) as any;
    for (const patch of [{ runtime: undefined }, { inputCleanupRequired: null }, { authUncertain: "false" }, { ownedGeneration: crypto.randomUUID() }]) {
      (f.share as any).persist();
      const path = join(f.chrome.bridge.directory, "desktop-share.json");
      const saved = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...saved, ...patch }), { mode: 0o600 });
      await expect(f.share.release("owner", f.share.state().generation, true)).rejects.toThrow("evidence");
      expect(f.chrome.humanState()).toBe(false);
      expect(existsSync(path)).toBe(true);
    }
  } finally { await f.close(); }
});

test("human clipboard requires owner, connected exact Take/generation and unchanged native binding before and after async transfer", async () => {
  const f = await fixture(), ack = gate();
  const display = `:${100000000 + Math.floor(Math.random() * 100000000)}`;
  const native = createServer();
  await new Promise<void>(resolve => native.listen(`/tmp/.X11-unix/X${display.slice(1)}`, resolve));
  try {
    const p = await f.peer();
    const binding = bindChromeDesktop({ available: true, display, auth: f.auth });
    Object.assign(f.share, { status: "sharing", owner: "owner", controlId: "take", generation: 7,
      profile: p.profile, profileGeneration: p.generation, binding, connections: new Set([() => {}]) });
    const calls: unknown[] = [];
    const backend = (f.share as any).clipboard;
    backend.transfer = async (_binding: unknown, current: () => void, text: string) => {
      calls.push(text); await ack.promise; current(); return { text: "private-response" };
    };
    const identity = { controlId: "take", generation: 7 };
    for (const [owner, input] of [["foreign", identity], ["owner", { ...identity, generation: 6 }], ["owner", { ...identity, controlId: "old" }]] as const)
      await expect(f.share.transferClipboard(owner, input, false)).rejects.toThrow();
    expect(calls).toHaveLength(0);
    await expect(f.share.transferClipboard("owner", { ...identity, text: "🪼".repeat(65537) }, true)).rejects.toThrow("256 KiB");
    await expect(f.share.transferClipboard("owner", { ...identity, display: ":0" }, false)).rejects.toThrow("options");
    const pending = f.share.transferClipboard("owner", { ...identity, text: "雪\n🪼" }, true);
    (f.share as any).generation++;
    ack.resolve(); await expect(pending).rejects.toThrow("connection changed");
    expect(calls).toEqual(["雪\n🪼"]);
    (f.share as any).generation = 7;
    (f.share as any).connections.clear();
    await expect(f.share.transferClipboard("owner", identity, false)).rejects.toThrow();
    (f.share as any).connections.add(() => {});
    writeFileSync(f.auth, "changed", { mode: 0o600 });
    await expect(f.share.transferClipboard("owner", identity, false)).rejects.toThrow();
  } finally {
    ack.resolve(); Object.assign(f.share, { status: "idle" }); await f.close();
    await new Promise<void>(resolve => native.close(() => resolve()));
  }
});

test("clipboard HTTP routes require cookie/CSRF/same-origin and scope the expanded escaped JSON limit only to send", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-clipboard-http-"));
  const app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
  const origin = app.server.url.origin;
  try {
    const session = await fetch(`${origin}/api/control-session`);
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const { csrf } = await session.json() as { csrf: string };
    const headers = { cookie, "x-jelly-csrf": csrf, "content-type": "application/json" };
    const post = (route: string, raw = "{}", h: Record<string, string> = headers) => fetch(`${origin}/api/chrome/share/${route}`, { method: "POST", headers: h, body: raw });
    for (const route of ["clipboard/send", "clipboard/receive"]) {
      expect((await post(route, "{}", { "content-type": "application/json" })).status).toBe(401);
      expect((await post(route, "{}", { cookie, "content-type": "application/json" })).status).toBe(403);
      expect((await post(route, "{}", { ...headers, origin: "https://evil.example" })).status).toBe(403);
      expect((await post(route)).status).toBe(403); // no active owner
    }
    let input: any;
    app.service.chromeShare.transferClipboard = async (_session, value) => { input = value; return { ok: true }; };
    const malformed = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    for (const route of ["clipboard/send", "clipboard/receive"]) {
      const result = await fetch(`${origin}/api/chrome/share/${route}`, { method: "POST", headers, body: malformed });
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({ error: "Invalid JSON object." });
      expect(input).toBeUndefined();
    }
    const escaped = '{"text":"' + "\\u0001".repeat(256 * 1024) + '"}';
    expect((await post("clipboard/send", escaped)).status).toBe(200);
    expect(input.text.length).toBe(256 * 1024);
    expect((await post("clipboard/receive", escaped)).status).toBe(413);
    expect((await post("take", escaped)).status).toBe(413);
    expect((await post("clipboard/send", " ".repeat(COMPUTER_CLIPBOARD_BODY_BYTES + 1))).status).toBe(413);
    expect(validClipboardText("\uFEFF雪\n🪼\r\n")).toBe(true);
    expect(validClipboardText("\ud800")).toBe(false);
    expect(validClipboardText("🪼".repeat(65536))).toBe(true);
    expect(validClipboardText("🪼".repeat(65537))).toBe(false);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
