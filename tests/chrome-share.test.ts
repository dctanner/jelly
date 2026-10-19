import { expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
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
import { localX11Desktop } from "../src/server/chrome-desktop";
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
    browserTarget: "chrome" as const,
    chromeProfile: profile,
    chromeOrigins: ["https://example.com"],
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

test("global desktop latch fences two profiles, cached ports, delayed begin/results, resume, new peers and settlement", async () => {
  const f = await fixture();
  const pending = gate(),
    freeze = gate();
  try {
    const a = await f.peer(),
      b = await f.peer();
    const pa = f.chrome.allocate("a", "run-a", f.selection(a.profile), "A");
    const pb = f.chrome.allocate("b", "run-b", f.selection(b.profile), "B");
    await pb.action("open", { url: "https://example.com" });
    a.onCall(async (r) => {
      if (r.method === "begin") await pending.promise;
      if (r.method === "freeze") await freeze.promise;
      return r.method === "freeze" ? { frozen: true } : { ok: true };
    });
    const delayed = pa.action("snapshot").catch((e) => e.message);
    await waitFor(() => a.requests.some((r) => r.method === "begin"));
    f.chrome.lockDesktop();
    const draining = f.chrome.freezeDesktop();
    let acknowledged = false;
    void draining.then(() => {
      acknowledged = true;
    });
    expect(f.chrome.state("b").task?.paused).toBe(false);
    expect(() =>
      f.chrome.allocate("new", "run", f.selection(a.profile), "New"),
    ).toThrow("paused");
    expect(await pb.action("snapshot").catch((e) => e.message)).toContain(
      "paused",
    );
    expect(await f.chrome.control("b", "resume").catch((e) => e.status)).toBe(
      409,
    );
    const rejected = await f.peer();
    expect(rejected.socket.destroyed).toBe(true);
    pending.resolve();
    expect(await delayed).toContain("revoked");
    expect(acknowledged).toBe(false);
    freeze.resolve();
    await draining;
    expect(a.frozen() && b.frozen()).toBe(true);
    expect(f.chrome.state("b").task?.paused).toBe(true);
    await f.chrome.settle("b", "run-b");
    expect(f.chrome.sharingDesktop).toBe(true);
    await f.chrome.unlockDesktop();
    expect(f.chrome.state("a").task?.paused).toBe(true);
    expect(f.chrome.state("b").task?.paused).toBe(true);
    expect(await pa.action("snapshot").catch((e) => e.message)).toContain(
      "paused",
    );
  } finally {
    pending.resolve();
    freeze.resolve();
    await f.close();
  }
});

test("direct take freezes first; failed/delayed detach cannot capture or falsely hand back; stale/concurrent owners fail", async () => {
  const f = await fixture(),
    ack = gate();
  try {
    const p = await f.peer();
    p.onCall(async (r) => {
      if (r.method === "freeze") {
        await ack.promise;
        throw new Error("detach rejected");
      }
      return { ok: true };
    });
    const take = f.share
      .take("owner", "a", p.profile, p.generation)
      .catch((e) => e.status);
    expect(f.share.state("owner").status).toBe("pausing");
    expect(f.chrome.sharingDesktop).toBe(true);
    expect(
      await f.share
        .take("other", "a", p.profile, p.generation)
        .catch((e) => e.status),
    ).toBe(409);
    expect(() => f.share.ticket("owner", f.share.state().generation)).toThrow(
      "not ready",
    );
    expect(
      await f.share
        .release("other", f.share.state().generation)
        .catch((e) => e.status),
    ).toBe(403);
    expect((f.share as any).runtime).toBeNull();
    ack.resolve();
    expect(await take).toBe(409);
    expect(f.share.state().status).toBe("failed");
    expect(
      existsSync(join(f.chrome.bridge.directory, "desktop-share.json")),
    ).toBe(true);
    expect(
      await f.share
        .release("owner", f.share.state().generation, true)
        .catch((e) => e.status),
    ).toBe(409);
    expect(f.chrome.sharingDesktop).toBe(true);
    p.onCall(async () => ({ frozen: true }));
    await f.share.release("owner", f.share.state().generation, true);
    expect(f.chrome.sharingDesktop).toBe(false);
  } finally {
    ack.resolve();
    await f.close();
  }
});

test("single-use expiring tickets bind owner and epoch; forwarding/reconnect and owner expiry revoke old connections", async () => {
  const f = await fixture();
  try {
    const p = await f.peer();
    f.chrome.lockDesktop();
    await f.chrome.freezeDesktop();
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

test("bridge-generation loss revokes viewer/tickets and stays latched after late freeze ACK", async () => {
  const f = await fixture(),
    ack = gate();
  try {
    const p = await f.peer();
    p.onCall(async (r) => {
      if (r.method === "freeze") await ack.promise;
      return { frozen: true };
    });
    const take = f.share
      .take("owner", "a", p.profile, p.generation)
      .catch(() => {});
    await waitFor(() => p.requests.some((r) => r.method === "freeze"));
    p.socket.destroy();
    await waitFor(() => f.share.state().status === "failed");
    ack.resolve();
    await take;
    expect(f.share.state().status).toBe("failed");
    expect(f.chrome.sharingDesktop).toBe(true);
    expect((f.share as any).process).toBeNull();
  } finally {
    ack.resolve();
    await f.close();
  }
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
    expect(f.chrome.sharingDesktop).toBe(false);
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
    app.service.chrome.lockDesktop();
    for (const route of [
      "desktop/connect",
      "desktop/settings",
      "desktop/resume",
      "desktop/foreground",
      "desktop/handback",
    ])
      expect((await post(route)).status).toBe(409);
    expect(
      (await post("chrome/resume", { agentId: app.store.agents()[0]!.id }))
        .status,
    ).toBe(409);
    expect((await post("chrome/share/ticket", { generation: 0 })).status).toBe(
      403,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("owner expiry during a delayed handback ACK cannot reopen global browser authority", async () => {
  const f = await fixture(),
    ack = gate();
  try {
    const p = await f.peer();
    f.chrome.lockDesktop();
    await f.chrome.freezeDesktop();
    Object.assign(f.share, {
      status: "disconnected",
      owner: "owner",
      profile: p.profile,
      profileGeneration: p.generation,
      frozen: true,
    });
    writeFileSync(
      join(f.chrome.bridge.directory, "desktop-share.json"),
      JSON.stringify({ runtime: null }),
      { mode: 0o600 },
    );
    p.onCall(async (r) => {
      if (r.method === "unfreeze") await ack.promise;
      return { ok: true };
    });
    let valid = true;
    f.share.ownerValid = () => valid;
    const release = f.share
      .release("owner", f.share.state().generation)
      .catch((e) => e.status);
    await waitFor(() => p.requests.some((r) => r.method === "unfreeze"));
    valid = false;
    ack.resolve();
    expect(await release).toBe(409);
    expect(f.chrome.sharingDesktop).toBe(true);
    expect(f.share.state().status).toBe("orphaned");
    expect(() =>
      f.chrome.allocate("fresh", "run", f.selection(p.profile), "Fresh"),
    ).toThrow("paused");
  } finally {
    ack.resolve();
    await f.close();
  }
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
    expect(f.chrome.sharingDesktop).toBe(true);
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
    app.service.chrome.lockDesktop();
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
    expect(app.service.chrome.sharingDesktop).toBe(true);
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup-only handback after native disconnect ACKs current peers after input cleanup, never revives lost tasks", async () => {
  const f = await fixture(),
    cleanup = gate();
  try {
    const a = await f.peer(),
      b = await f.peer();
    const old = f.chrome.allocate("a", "run-a", f.selection(a.profile), "A");
    await old.action("name", { name: "Old task" });
    await f.chrome
      .allocate("b", "run-b", f.selection(b.profile), "B")
      .action("name", { name: "Current task" });
    await f.share.take("owner", "a", a.profile, a.generation).catch(() => {});
    a.socket.destroy();
    await waitFor(
      () => f.chrome.state("a").task?.pauseState === "disconnected",
    );
    expect(f.share.state().status).toBe("failed");
    await expect(f.chrome.freezeDesktop()).rejects.toThrow("disconnected");
    await expect(
      f.share.release("owner", f.share.state().generation),
    ).rejects.toThrow("failed share");
    let cleaned = false;
    const stopCapture = (f.share as any).stopCapture.bind(f.share);
    (f.share as any).stopCapture = async (repair: boolean) => {
      await stopCapture(repair);
      await cleanup.promise;
      cleaned = true;
    };
    const before = b.requests.length;
    b.onCall(async (r) => {
      if (r.method === "freeze") expect(cleaned).toBe(true);
      return r.method === "freeze" ? { frozen: true } : { ok: true };
    });
    const handback = f.share.release("owner", f.share.state().generation, true);
    await Bun.sleep(10);
    expect(b.requests.length).toBe(before);
    expect(f.chrome.sharingDesktop).toBe(true);
    cleanup.resolve();
    await handback;
    expect(f.share.state().status).toBe("idle");
    expect(f.chrome.sharingDesktop).toBe(false);
    expect(f.chrome.state("a").task?.pauseState).toBe("disconnected");
    expect(f.chrome.state("a").task?.paused).toBe(false);
    expect(f.chrome.state("b").task?.paused).toBe(true);
    expect(b.requests.slice(before).map((r) => r.method)).toEqual([
      "freeze",
      "unfreeze",
    ]);
    expect((f.share as any).process).toBeNull();
    expect((f.share as any).connections.size).toBe(0);
    expect(() => f.share.ticket("owner", f.share.state().generation)).toThrow();
    await expect(old.action("snapshot")).rejects.toThrow("expired");
    await expect(f.chrome.control("a", "resume")).rejects.toThrow();
  } finally {
    cleanup.resolve();
    await f.close();
  }
});

test("cleanup-only native-disconnect recovery stays latched if any current peer fails its freeze ACK", async () => {
  const f = await fixture();
  try {
    const a = await f.peer(),
      b = await f.peer();
    await f.chrome
      .allocate("a", "run-a", f.selection(a.profile), "A")
      .action("name", { name: "Lost task" });
    await f.share.take("owner", "a", a.profile, a.generation).catch(() => {});
    a.socket.destroy();
    await waitFor(
      () => f.chrome.state("a").task?.pauseState === "disconnected",
    );
    b.onCall(async () => {
      throw new Error("Fixture current-peer detach failed");
    });
    await expect(
      f.share.release("owner", f.share.state().generation, true),
    ).rejects.toThrow();
    expect(f.share.state().status).toBe("failed");
    expect(f.chrome.sharingDesktop).toBe(true);
    expect(
      existsSync(join(f.chrome.bridge.directory, "desktop-share.json")),
    ).toBe(true);
    expect((f.share as any).process).toBeNull();
    expect(() =>
      f.chrome.allocate("new", "run", f.selection(b.profile), "New"),
    ).toThrow("paused");
    expect(() => f.share.ticket("owner", f.share.state().generation)).toThrow();
  } finally {
    await f.close();
  }
});

test("expired-owner cleanup cannot bypass a failed current-peer freeze ACK", async () => {
  const f = await fixture();
  try {
    const a = await f.peer();
    const browser = f.chrome.allocate(
      "a",
      "run-a",
      f.selection(a.profile),
      "A",
    );
    await browser.action("name", { name: "Retained task" });
    a.onCall(async (r) => {
      if (r.method === "freeze") throw new Error("Fixture failed detach");
      return { ok: true };
    });
    await expect(
      f.share.take("expired-owner", "a", a.profile, a.generation),
    ).rejects.toThrow();
    f.share.ownerValid = (session) => session === "new-owner";
    expect(f.share.state("new-owner").status).toBe("orphaned");
    await expect(
      f.share.release("new-owner", f.share.state().generation, true),
    ).rejects.toThrow();
    expect(a.requests.filter((r) => r.method === "freeze")).toHaveLength(2);
    expect(a.requests.some((r) => r.method === "unfreeze")).toBe(false);
    expect(f.chrome.sharingDesktop).toBe(true);
    expect(f.share.state().status).toBe("orphaned");
    expect(
      existsSync(join(f.chrome.bridge.directory, "desktop-share.json")),
    ).toBe(true);
    expect((f.share as any).process).toBeNull();
    expect(() =>
      f.share.ticket("new-owner", f.share.state().generation),
    ).toThrow();
    expect(() =>
      f.chrome.allocate("new", "new-run", f.selection(a.profile), "New"),
    ).toThrow("paused");
    await expect(browser.action("snapshot")).rejects.toThrow("paused");

    // Only a new, successful acknowledgement can reopen admission. Cleanup does
    // not start capture or resume the task, even for a valid replacement owner.
    a.onCall(async (r) =>
      r.method === "freeze" ? { frozen: true } : { ok: true },
    );
    await f.share.release("new-owner", f.share.state().generation, true);
    expect(a.requests.filter((r) => r.method === "freeze")).toHaveLength(3);
    expect(a.requests.filter((r) => r.method === "unfreeze")).toHaveLength(1);
    expect(f.share.state().status).toBe("idle");
    expect(f.chrome.sharingDesktop).toBe(false);
    expect(f.chrome.state("a").task?.paused).toBe(true);
    await expect(browser.action("snapshot")).rejects.toThrow("paused");
    expect((f.share as any).process).toBeNull();
  } finally {
    await f.close();
  }
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

test("deferred admit/drop ABA during delayed unfreeze preserves failed share epoch and durable latch", async () => {
  const f = await fixture(), ack = gate();
  let pending: Socket | undefined;
  try {
    const p = await f.peer();
    f.chrome.lockDesktop();
    await f.chrome.freezeDesktop();
    Object.assign(f.share, { status: "sharing", owner: "owner", frozen: true });
    (f.share as any).persist();
    p.onCall(async r => { if (r.method === "unfreeze") await ack.promise; return { ok: true }; });
    const release = f.share.release("owner", f.share.state().generation).catch(e => e.status);
    await waitFor(() => p.requests.some(r => r.method === "unfreeze"));
    const config = JSON.parse(readFileSync(join(f.chrome.bridge.directory, "pairing.json"), "utf8"));
    f.chrome.bridge.deferDesktop = () => ({ available: true, display: ":3999", auth: f.auth });
    pending = connect(config.socket); pending.on("error", () => {});
    pending.write(chromeFrame({ type: "hello", version: CHROME_PROTOCOL, capabilities: CHROME_METHODS,
      instance: "share-test", grant: config.grant, extensionId: "a".repeat(32), profile: crypto.randomUUID(),
      generation: crypto.randomUUID(), desktop: { available: false } }));
    await waitFor(() => f.chrome.bridge.deferredProfiles().length === 1);
    pending.destroy();
    await waitFor(() => f.share.state().status === "failed" && !f.chrome.bridge.deferredProfiles().length);
    ack.resolve();
    expect(await release).toBe(409);
    expect(f.share.state().status).toBe("failed");
    expect(f.chrome.sharingDesktop).toBe(true);
    expect(existsSync(join(f.chrome.bridge.directory, "desktop-share.json"))).toBe(true);
  } finally { ack.resolve(); pending?.destroy(); await f.close(); }
});

test("viewer-disconnect cleanup cannot overwrite a newer stopping handback with disconnected", async () => {
  const f = await fixture(), stopped = gate();
  try {
    await f.peer(); f.chrome.lockDesktop(); await f.chrome.freezeDesktop();
    Object.assign(f.share, { status: "sharing", owner: "owner", frozen: true, stopCapture: () => stopped.promise });
    (f.share as any).persist();
    const disconnect = f.share.attach(() => {});
    disconnect();
    const release = f.share.release("owner", f.share.state().generation);
    stopped.resolve();
    expect((await release).status).toBe("idle");
    expect(f.chrome.sharingDesktop).toBe(false);
    expect(existsSync(join(f.chrome.bridge.directory, "desktop-share.json"))).toBe(false);
  } finally { stopped.resolve(); await f.close(); }
});

test("cleanup-only orphan acquires native privacy exclusion without viewing before reopening admission", async () => {
  const f = await fixture();
  let safe = false, drained = 0;
  try {
    await f.peer(); f.chrome.lockDesktop();
    Object.assign(f.share, { status: "orphaned", owner: null, drainDesktop: async () => { drained++; safe = true; } });
    f.share.privacyValid = () => safe;
    (f.share as any).persist();
    expect((await f.share.release("fresh-owner", f.share.state().generation, true)).status).toBe("idle");
    expect(drained).toBe(1);
    expect(f.chrome.sharingDesktop).toBe(false);
    expect((f.share as any).process).toBeNull();
  } finally { await f.close(); }
});

for (const restored of [false, true]) test(`already-clean owned Chrome death retires only cleanup latch (restored=${restored})`, async () => {
  const f = await fixture();
  let share = f.share;
  try {
    const peer = await f.peer();
    f.chrome.lockDesktop();
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
    // A fresh current-peer ACK is mandatory, even with a cached frozen flag.
    peer.onCall(async () => { throw new Error("no ACK"); });
    await expect(share.release("owner", share.state().generation, true)).rejects.toThrow();
    expect(f.chrome.sharingDesktop).toBe(true);
    peer.onCall(async r => r.method === "freeze" ? { frozen: true } : { ok: true });
    await share.release("owner", share.state().generation, true);
    expect(share.state().status).toBe("idle");
    expect(peer.requests.slice(-2).map(r => r.method)).toEqual(["freeze", "unfreeze"]);
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
      expect(f.chrome.sharingDesktop).toBe(true);
      expect(existsSync(join(f.chrome.bridge.directory, "desktop-share.json"))).toBe(true);
    } finally {
      // Synthetic unresolved obligations have no native process to clean.
      if (restored) { Object.assign(restored, { inputCleanupRequired: false }); await restored.close(); }
      await f.close();
    }
  });

test("clean owned record replacement during peer ACK cannot publish authority", async () => {
  const f = await fixture();
  try {
    const peer = await f.peer(); f.chrome.lockDesktop();
    Object.assign(f.share, { status: "failed", owner: "owner", ownedGeneration: crypto.randomUUID(), binding: {} });
    (f.share as any).persist();
    let stamp = "original";
    f.share.ownedDesktop.cleanupRecord = () => ({ stamp }) as any;
    peer.onCall(async () => { stamp = "replacement"; return { frozen: true }; });
    await expect(f.share.release("owner", 0, true)).rejects.toThrow("revoked");
    expect(f.chrome.sharingDesktop).toBe(true);
    expect(peer.requests.some(r => r.method === "unfreeze")).toBe(false);
  } finally { await f.close(); }
});

test("clean owned recovery refuses missing runtime and changed durable completion evidence", async () => {
  const f = await fixture();
  try {
    f.chrome.lockDesktop();
    Object.assign(f.share, { status: "failed", owner: "owner", ownedGeneration: crypto.randomUUID(), binding: {} });
    f.share.ownedDesktop.cleanupRecord = () => ({ retained: true }) as any;
    for (const patch of [{ runtime: undefined }, { inputCleanupRequired: null }, { authUncertain: "false" }, { ownedGeneration: crypto.randomUUID() }]) {
      (f.share as any).persist();
      const path = join(f.chrome.bridge.directory, "desktop-share.json");
      const saved = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...saved, ...patch }), { mode: 0o600 });
      await expect(f.share.release("owner", f.share.state().generation, true)).rejects.toThrow("evidence");
      expect(f.chrome.sharingDesktop).toBe(true);
      expect(existsSync(path)).toBe(true);
    }
  } finally { await f.close(); }
});
