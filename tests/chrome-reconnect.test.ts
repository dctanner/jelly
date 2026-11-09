import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeSessions } from "../src/server/chrome-sessions";
import { BrowserSessions } from "../src/server/browser-sessions";
import { interventionTools } from "../src/server/agent-tools";
import type { Interventions } from "../src/server/interventions";
import { startApp } from "./fixtures/app";

function gate<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(guard?: () => void) {
  const dir = mkdtempSync(join(tmpdir(), "jelly-browser-reconnect-"));
  const chrome = new ChromeSessions(dir, "reconnect-fixture");
  await chrome.bridge.ready;
  const profile = crypto.randomUUID();
  let generation = crypto.randomUUID(), connected = true;
  const calls: { profile: string; generation: string; session: string; run: string; method: string; params: Record<string, unknown> }[] = [];
  const selection = { chromeProfile: profile };
  chrome.bridge.profiles = () => connected ? [{ id: profile, generation, connected: true }] : [];
  chrome.bridge.canReconnect = (p, g) => connected && p === profile && g === generation;
  let nextTab = 1;
  // Minimal v9 extension: begin/end/createTab/listTabs, everything else acknowledged.
  const v9 = (method: string): unknown =>
    method === "begin" ? { ok: true, tabs: [] }
    : method === "end" ? { ok: true, retained: [] }
    : method === "createTab" ? { tab: { id: nextTab++, title: "", url: "about:blank", windowId: 1, active: true, origin: "agent", mark: null } }
    : method === "listTabs" ? { tabs: [] }
    : { ok: true };
  let handle = async (method: string, _params: Record<string, unknown>): Promise<unknown> => v9(method);
  chrome.bridge.call = async (p, g, session, run, method, params) => {
    calls.push({ profile: p, generation: g, session, run, method, params });
    return handle(method, params);
  };
  const router = new BrowserSessions(chrome);
  const scoped = router.forRun("agent", "run", selection, "Agent", guard);
  const browser = scoped.get("agent");
  return {
    chrome, router, scoped, browser, profile, selection, calls, v9,
    get generation() { return generation; },
    set connected(value: boolean) { connected = value; },
    handle: (next: typeof handle) => { handle = next; },
    lose: (repaired = true) => { chrome.bridge.onLoss(profile); if (repaired) generation = crypto.randomUUID(); },
    close: async () => { await chrome.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("browser_reconnect is the explicit path: fresh identity, same pinned profile, no RPC/replay or old tabs", async () => {
  const f = await fixture();
  try {
    await f.browser.engine.execute("tabs.new", {});
    const oldSession = f.calls[0]!.session;
    const oldTab = f.chrome.state("agent").task!.active!;
    expect(oldTab).toBe("1");
    f.lose();
    await expect(f.browser.engine.execute("tabs.list", {})).rejects.toThrow("browser_reconnect");
    const before = f.calls.length;
    expect(await f.browser.reconnect!()).toMatchObject({ status: "reconnected" });
    expect(f.calls.length).toBe(before); // No browser operation, even begin, is replayed.
    expect(f.scoped.get("agent")).toBe(f.browser); // Cached tool port now uses the fresh identity.
    expect(f.chrome.state("agent").task).toMatchObject({ connected: true, active: null, tabs: [], profile: f.profile });
    // Old tab handles are forgotten by the engine and never reach Chrome.
    await expect(f.browser.engine.execute("tab.show", { tab: Number(oldTab) })).rejects.toThrow("not part of this browser session");
    expect(f.calls.length).toBe(before);
    await f.browser.engine.execute("tabs.new", {});
    await f.browser.engine.execute("tabs.new", {});
    const begins = f.calls.filter(c => c.method === "begin");
    expect(begins).toHaveLength(2);
    const begin = begins.at(-1)!;
    expect(begin.session).not.toBe(oldSession);
    expect(begin).toMatchObject({ profile: f.profile, generation: f.generation, run: "run", params: { name: "Agent", agent: "agent" } });
    expect(Object.keys(begin.params).sort()).toEqual(["agent", "name"]);
  } finally { await f.close(); }
});

test("extension errors do not poison session authority; a reported pause does", async () => {
  const f = await fixture();
  try {
    await f.browser.engine.execute("tabs.new", {});
    const identity = f.calls[0]!;
    for (const message of ["Debugger is not attached", "No tab with id: 7", "Cannot access a chrome:// URL"]) {
      f.handle(async () => { throw new Error(message); });
      await expect(f.browser.engine.execute("tabs.list", {})).rejects.toThrow(message);
      expect(f.chrome.state("agent").task?.pauseState).toBe("active");
      expect(await f.browser.reconnect!()).toMatchObject({ status: "already_connected" });
    }
    f.handle(async method => f.v9(method));
    expect(await f.browser.engine.execute("tabs.list", {})).toEqual([]);
    expect(f.calls.at(-1)!.session).toBe(identity.session);
    f.chrome.bridge.onPauseState(f.profile, f.generation, identity.session, "r-other", "paused", "cleanup_failed");
    expect(f.chrome.state("agent").task?.pauseState).toBe("active");
    f.chrome.bridge.onPauseState(f.profile, f.generation, identity.session, "run", "paused", "cleanup_failed");
    const count = f.calls.length;
    await expect(f.browser.engine.execute("tabs.list", {})).rejects.toThrow("[cleanup_failed]");
    expect(f.calls).toHaveLength(count); // A paused session never reaches the extension.
    await expect(f.browser.reconnect!()).rejects.toThrow("cannot clear");
    f.lose();
    await expect(f.browser.reconnect!()).rejects.toThrow("cannot clear");
  } finally { await f.close(); }
});

test("pause notifications require the exact profile, generation, session and run", async () => {
  const f = await fixture();
  try {
    await f.browser.engine.execute("tabs.new", {});
    const identity = [f.profile, f.generation, f.calls[0]!.session, "run"] as const;
    for (let i = 0; i < identity.length; i++) {
      const stale = [...identity];
      stale[i] = "foreign-or-stale";
      f.chrome.bridge.onPauseState(stale[0]!, stale[1]!, stale[2]!, stale[3]!, "paused", "cleanup_failed");
      expect(f.chrome.state("agent").task).toMatchObject({ pauseState: "active", paused: false });
      expect(f.chrome.state("agent").task?.pauseReason).toBeUndefined();
    }
    expect(await f.browser.engine.execute("tabs.list", {})).toEqual([]);
    f.chrome.bridge.onPauseState(...identity, "paused", "cleanup_failed");
    expect(f.chrome.state("agent").task).toMatchObject({ pauseState: "paused", pauseReason: "cleanup_failed" });
    await expect(f.browser.engine.execute("tabs.list", {})).rejects.toThrow("[cleanup_failed]");
    await expect(f.browser.reconnect!()).rejects.toThrow("cannot clear");
  } finally { await f.close(); }
});

test("server-known native pauses and older-peer unknown pauses remain distinguishable and blocked", async () => {
  for (const native of [true, false]) {
    const f = await fixture();
    try {
      await f.browser.engine.execute("tabs.new", {});
      if (native) await f.chrome.pauseForNativeHandoff();
      else f.chrome.bridge.onPauseState(f.profile, f.generation, f.calls[0]!.session, "run", "paused");
      await expect(f.browser.engine.execute("tabs.list", {})).rejects.toThrow(native ? "[native_handoff]" : "[unknown]");
      await expect(f.browser.reconnect!()).rejects.toThrow("cannot clear");
    } finally { await f.close(); }
  }
});

test("legacy reasonless native pause ACKs retain provenance but independent failures replace it", async () => {
  for (const independent of [undefined, "cleanup_failed"] as const) {
    const f = await fixture();
    const entered = gate<void>(), ack = gate<unknown>();
    try {
      await f.browser.engine.execute("tabs.new", {});
      const session = f.calls[0]!.session;
      f.handle(async method => {
        if (method === "pause") { entered.resolve(); return ack.promise; }
        return f.v9(method);
      });
      const pending = f.chrome.pauseForNativeHandoff();
      await entered.promise;
      for (const state of ["pausing", "paused"] as const) {
        f.chrome.bridge.onPauseState(f.profile, f.generation, session, "run", state);
        expect(f.chrome.state("agent").task?.pauseReason).toBe("native_handoff");
      }
      ack.resolve({ ok: true });
      await pending;
      await expect(f.browser.engine.execute("tabs.list", {})).rejects.toThrow("[native_handoff]");
      await expect(f.browser.reconnect!()).rejects.toThrow("cannot clear");
      // Even a reasonless failed event must not retain an asserted native cause.
      f.chrome.bridge.onPauseState(f.profile, f.generation, session, "run", "failed", independent);
      expect(f.chrome.state("agent").task?.pauseReason).toBe(independent);
      await expect(f.browser.engine.execute("tabs.list", {})).rejects.toThrow(`[${independent ?? "unknown"}]`);
      await f.chrome.finishNativeHandoff();
      await expect(f.browser.reconnect!()).rejects.toThrow("cannot clear");
    } finally { ack.resolve({ ok: true }); await f.close(); }
  }
});

test("new runs do not auto-renew stale sessions or adopt a newly configured profile", async () => {
  const f = await fixture();
  try {
    await f.browser.engine.execute("tabs.new", {});
    f.lose();
    await f.chrome.settle("agent", "run");
    const next = f.router.forRun("agent", "next", { chromeProfile: crypto.randomUUID() }, "Agent").get("agent");
    await expect(next.engine.execute("tabs.list", {})).rejects.toThrow("browser_reconnect");
    await expect(f.browser.reconnect!()).rejects.toThrow("run authority expired");
    expect(await next.reconnect!()).toMatchObject({ status: "reconnected" });
    await next.engine.execute("tabs.new", {});
    expect(f.calls.at(-1)).toMatchObject({ profile: f.profile, run: "next", method: "createTab" });
    expect(f.chrome.state("agent").task).toMatchObject({ profile: f.profile });
  } finally { await f.close(); }
});

test("healthy reconnect is a no-op and another agent's lost session is untouched", async () => {
  const f = await fixture();
  try {
    const other = f.router.forRun("other", "other-run", f.selection, "Other").get("other");
    await f.browser.engine.execute("tabs.new", {});
    await other.engine.execute("tabs.new", {});
    const before = f.chrome.state("agent");
    const count = f.calls.length;
    expect(await f.browser.reconnect!()).toMatchObject({ status: "already_connected" });
    expect(f.calls).toHaveLength(count);
    expect(f.chrome.state("agent")).toEqual(before);
    f.lose();
    await f.browser.reconnect!();
    expect(f.chrome.state("other").task?.connected).toBe(false);
    await expect(other.engine.execute("tabs.list", {})).rejects.toThrow("browser_reconnect");
    expect(() => f.scoped.get("other")).toThrow("foreign");
  } finally { await f.close(); }
});

test("reconnect needs the pinned profile's new transport generation; other profiles cannot substitute", async () => {
  const f = await fixture();
  try {
    f.lose(false);
    await expect(f.browser.reconnect!()).rejects.toThrow("has not reconnected");
    f.connected = false;
    await expect(f.browser.reconnect!()).rejects.toThrow("has not reconnected");
    f.chrome.bridge.profiles = () => [{ id: crypto.randomUUID(), generation: crypto.randomUUID(), connected: true }];
    await expect(f.browser.reconnect!()).rejects.toThrow("has not reconnected");
    expect(f.chrome.state("agent").task?.connected).toBe(false);
    expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});

test("native/security pauses and pending sign-in are not cleared by reconnect, including after loss", async () => {
  for (const boundary of ["security", "native", "login"] as const) {
    const f = await fixture();
    try {
      await f.browser.engine.execute("tabs.new", {});
      if (boundary === "security") await f.chrome.control("agent", "pause");
      if (boundary === "native") await f.chrome.pauseForNativeHandoff();
      if (boundary === "login") await f.browser.reserveLogin("pending", "https://example.com/login");
      f.lose();
      await expect(f.browser.reconnect!()).rejects.toThrow("cannot clear");
      expect(f.chrome.state("agent").task?.connected).toBe(false);
      f.browser.cancelLogin("pending");
    } finally { await f.close(); }
  }
});

test("a newly blocked or closing transport cannot renew from a still-published profile", async () => {
  const f = await fixture();
  try {
    f.lose();
    f.chrome.bridge.canReconnect = () => false;
    await expect(f.browser.reconnect!()).rejects.toThrow("cannot clear revoked pairing");
    expect(f.chrome.state("agent").task?.connected).toBe(false);
    expect(f.calls).toHaveLength(0);
  } finally { await f.close(); }
});

test("human computer-control status alone does not block browser_reconnect", async () => {
  const f = await fixture();
  try {
    f.lose();
    f.chrome.setHumanDesktop(true);
    expect(await f.browser.reconnect!()).toMatchObject({ status: "reconnected" });
    expect(f.chrome.humanState()).toBe(true);
  } finally { await f.close(); }
});

test("reconnect never replays an in-flight operation and rejects work admitted before the fresh session", async () => {
  const f = await fixture();
  const entered = gate<void>(), ack = gate<unknown>();
  try {
    await f.browser.engine.execute("tabs.new", {});
    f.handle(async method => { if (method === "createTab") { entered.resolve(); return ack.promise; } return f.v9(method); });
    const mutation = f.browser.engine.execute("tabs.new", {}).catch(e => e.message);
    await entered.promise;
    f.lose();
    const recovery = f.browser.reconnect!();
    const queued = f.browser.engine.execute("tabs.new", {}).catch(e => e.message);
    ack.reject(new Error("Outcome unknown"));
    expect(await mutation).toBe("Outcome unknown");
    expect(await recovery).toMatchObject({ status: "reconnected" });
    expect(await queued).toContain("browser_reconnect");
    expect(f.calls.filter(c => c.method === "createTab")).toHaveLength(2);
    expect(f.calls.filter(c => c.method === "begin")).toHaveLength(1);
    expect(f.chrome.state("agent").task).toMatchObject({ connected: true, tabs: [], active: null });
  } finally { ack.resolve({}); await f.close(); }
});

test("cancellation and newly revoked service authority are rechecked after queued work drains", async () => {
  for (const cause of ["abort", "authority"] as const) {
    let allowed = true;
    const f = await fixture(() => { if (!allowed) throw new Error("Run revoked"); });
    const entered = gate<void>(), ack = gate<unknown>();
    try {
      await f.browser.engine.execute("tabs.new", {});
      // Sign-in reservation is serialized ahead of reconnect on the session queue.
      f.handle(async method => { if (method === "createTab") { entered.resolve(); return ack.promise; } return f.v9(method); });
      const pending = f.browser.reserveLogin("login", "https://example.com/login").catch(() => {});
      await entered.promise;
      f.lose();
      const controller = new AbortController();
      const recovery = f.browser.reconnect!(controller.signal).catch(e => e.message);
      if (cause === "abort") controller.abort(new Error("Cancelled reconnect"));
      else allowed = false;
      ack.reject(new Error("disconnected"));
      await pending;
      expect(await recovery).toBe(cause === "abort" ? "Cancelled reconnect" : "Run revoked");
      expect(f.chrome.state("agent").task).toMatchObject({ connected: false, handoff: null });
    } finally { ack.resolve({}); await f.close(); }
  }
});

test("settlement closes reconnect admission before waiting for in-flight work", async () => {
  const f = await fixture();
  const entered = gate<void>(), ack = gate<unknown>();
  try {
    await f.browser.engine.execute("tabs.new", {});
    f.handle(async method => { if (method === "listTabs") { entered.resolve(); return ack.promise; } return f.v9(method); });
    const pending = f.browser.engine.execute("tabs.list", {}).catch(() => {});
    await entered.promise;
    f.lose();
    const recovery = f.browser.reconnect!().catch(e => e.message);
    let done = false;
    const settled = f.chrome.settle("agent", "run").then(() => { done = true; });
    expect(await recovery).toContain("run authority expired");
    await Bun.sleep(5);
    expect(done).toBe(false); // Settlement drains accepted engine work.
    ack.reject(new Error("disconnected"));
    await pending;
    await settled;
    await expect(f.browser.reconnect!()).rejects.toThrow("run authority expired");
    await expect(f.browser.engine.execute("tabs.list", {})).rejects.toThrow("run authority expired");
    expect(() => f.browser.reserveLogin("old-run", "https://example.com")).toThrow("run authority expired");
    expect(f.chrome.state("agent").task?.handoff).toBeNull();
  } finally { ack.resolve({}); await f.close(); }
});

test("tool dispatch uses only the current agent port, passes cancellation and reports no replay", async () => {
  const f = await fixture();
  try {
    f.lose();
    const tools = interventionTools(f.scoped, {} as Interventions, "agent", "run", "/tmp");
    const tool = tools.find(t => t.name === "browser_reconnect")!;
    const result = await tool.execute("reconnect", {}, new AbortController().signal, undefined, {} as any);
    const text = (result.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toMatchObject({ status: "reconnected" });
    expect(text).toContain("previous action may already have completed");
    expect(f.calls).toHaveLength(0);
    const aborted = new AbortController(); aborted.abort(new Error("cancelled"));
    await expect(tool.execute("cancel", {}, aborted.signal, undefined, {} as any)).rejects.toThrow("cancelled");
  } finally { await f.close(); }
});

test("service rejects reconnect during cancellation, foreign and ended runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-reconnect-service-"));
  const app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
  const service = app.service as any;
  const agent = app.store.agents()[0]!.id, run = "reconnect-service-run", profile = crypto.randomUUID();
  let generation = crypto.randomUUID();
  service.chrome.bridge.profiles = () => [{ id: profile, generation, connected: true }];
  service.chrome.bridge.canReconnect = (p: string, g: string) => p === profile && g === generation;
  service.chrome.bridge.call = async () => ({ ok: true });
  const active = { agentId: agent, cancelled: false, done: Promise.resolve() };
  service.active.set(run, active);
  const port = service.scopedBrowser(agent, run, { chromeProfile: profile }, "Agent").get(agent);
  try {
    service.chrome.bridge.onLoss(profile); generation = crypto.randomUUID();
    active.cancelled = true;
    await expect(port.reconnect()).rejects.toThrow("current active run");
    active.cancelled = false;
    active.agentId = "foreign";
    await expect(port.reconnect()).rejects.toThrow("current active run");
    active.agentId = agent;
    service.active.delete(run);
    await expect(port.reconnect()).rejects.toThrow("current active run");
    service.active.set(run, active);
    expect(await port.reconnect()).toMatchObject({ status: "reconnected" });
  } finally {
    service.active.delete(run);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
