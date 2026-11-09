import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./fixtures/app";
import { interventionTools } from "../src/server/agent-tools";
import type { BrowserRecoveryResult } from "../src/shared/browser-recovery";
import type { ChromePauseReason } from "../src/shared/chrome-errors";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(ttlMs = 10000) {
  const dir = mkdtempSync(join(tmpdir(), "jelly-browser-recovery-"));
  const app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0, interventionTtlMs: ttlMs });
  const agent = app.store.agents()[0]!.id;
  const run = app.store.createRun(agent, crypto.randomUUID(), "Recovery fixture", "api", "model").id;
  const active = { agentId: agent, cancelled: false, done: Promise.resolve() };
  (app.service as any).active.set(run, active);
  const chrome = app.service.chrome, profile = crypto.randomUUID();
  let generation = crypto.randomUUID(), connected = true, admission = true;
  const calls: { session: string; run: string; method: string; params: Record<string, unknown> }[] = [];
  let nextTab = 1;
  // Minimal v9 extension peer.
  const v9 = (method: string): any =>
    method === "begin" ? { ok: true, tabs: [] }
    : method === "end" ? { ok: true, retained: [] }
    : method === "createTab" ? { tab: { id: nextTab++, title: "", url: "about:blank", windowId: 1, active: true, origin: "agent", mark: null } }
    : method === "listTabs" ? { tabs: [] }
    : { ok: true };
  let handle = async (method: string): Promise<any> => v9(method);
  chrome.bridge.profiles = () => connected ? [{ id: profile, generation, connected: true }] : [];
  chrome.bridge.canReconnect = (p, g) => admission && connected && p === profile && g === generation;
  chrome.bridge.call = async (_p, _g, session, authorityRun, method, params) => {
    calls.push({ session, run: authorityRun, method, params });
    return handle(method);
  };
  const scoped = (app.service as any).scopedBrowser(agent, run, { chromeProfile: profile }, "Fixture");
  const browser = scoped.get(agent);
  await browser.engine.execute("tabs.new", {});
  const session = calls[0]!.session;
  const pause = (reason: ChromePauseReason = "cleanup_failed") =>
    chrome.bridge.onPauseState(profile, generation, session, run, "paused", reason);
  pause();
  const tools = interventionTools(scoped, app.service.interventions, agent, run, dir);
  const tool = tools.find(t => t.name === "request_browser_recovery")!;
  const updates: BrowserRecoveryResult[] = [];
  const request = (signal?: AbortSignal) => tool.execute("recovery", {}, signal, value => updates.push(JSON.parse((value.content[0] as any).text)), {} as any)
    .then(value => JSON.parse((value.content[0] as any).text) as BrowserRecoveryResult);
  const cards = () => app.service.interventions.list().filter(i => i.kind === "browser_recovery");
  return {
    app, chrome, agent, run, profile, session, scoped, browser, tools, tool, updates, calls, active, request, cards, pause, v9,
    set handle(value: typeof handle) { handle = value; },
    set connected(value: boolean) { connected = value; },
    set admission(value: boolean) { admission = value; },
    lose() { chrome.bridge.onLoss(profile); generation = crypto.randomUUID(); },
    changePairing() { generation = crypto.randomUUID(); },
    async close() { (app.service as any).active.delete(run); await app.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("automatic recovery retires the exact connected session with no human card, drains ACK, preserves pin and never replays", async () => {
  const f = await fixture();
  try {
    const otherId = f.app.service.createAgent({ name: "Other", instructions: "Fixture", color: "#b5bafc" }).id;
    const other = f.app.service.browsers.forRun(otherId, "other-run", { chromeProfile: f.profile }, "Other").get(otherId);
    await other.engine.execute("tabs.new", {});
    const otherState = f.chrome.state(otherId).task;
    const entered = gate<void>(), ack = gate<any>();
    f.handle = async method => {
      if (method === "end") {
        // Own settlement events do not invalidate the in-progress retirement.
        f.chrome.bridge.onPauseState(f.profile, (f.chrome as any).tasks.get(f.agent).generation, f.session, f.run, "pausing", "settlement");
        entered.resolve(); return ack.promise;
      }
      return f.v9(method);
    };
    const done = f.request();
    await entered.promise;
    expect(f.cards()).toHaveLength(0);
    await expect(f.browser.engine.execute("tabs.list", {})).rejects.toThrow("authority expired");
    ack.resolve({ ok: true, retained: [] });
    expect(await done).toMatchObject({ status: "approved_closed", disposition: "closed_connected_session" });
    expect(f.updates.map(u => u.status)).toEqual(["requested"]);
    expect(f.chrome.state(f.agent).task).toBeNull();
    expect(f.chrome.state(otherId).task).toEqual(otherState);
    expect(f.app.service.browsers.target(f.agent)).toBe("chrome");
    expect(f.calls.filter(c => c.method === "end")).toEqual([{ session: f.session, run: f.run, method: "end", params: { discard: true } }]);
    expect(f.calls.filter(c => c.method === "createTab")).toHaveLength(2);
    const fresh = f.scoped.get(f.agent);
    await fresh.engine.execute("tabs.new", {});
    expect(f.calls.at(-1)!.session).not.toBe(f.session);
    expect(f.chrome.state(f.agent).task!.profile).toBe(f.profile);
    await expect(f.browser.engine.execute("tabs.list", {})).rejects.toThrow("authority expired");
  } finally { await f.close(); }
});

test("automatic lost retirement needs freshly paired same profile; never calls old tabs", async () => {
  const f = await fixture();
  try {
    f.lose();
    const count = f.calls.length;
    const result = await f.request();
    expect(result).toMatchObject({ status: "approved_closed", disposition: "retired_lost_session" });
    expect(result.message).toContain("Old tabs may remain");
    expect(f.calls).toHaveLength(count);
    expect(f.chrome.state(f.agent).task).toBeNull();
  } finally { await f.close(); }
});

test("recovery accepts no arguments and healthy sessions are not retired", async () => {
  const f = await fixture();
  try {
    expect(f.tools.map(t => t.name).filter(n => /recovery/.test(n))).toEqual(["request_browser_recovery"]);
    expect(f.tool.parameters).toMatchObject({ properties: {}, additionalProperties: false });
    const forged = await f.tool.execute("forged", { approve: true } as any, undefined, undefined, {} as any);
    expect(JSON.parse((forged.content[0] as any).text).status).toBe("rejected");
    const task = (f.chrome as any).tasks.get(f.agent);
    task.paused = false; task.pauseState = "active";
    expect((await f.request()).status).toBe("rejected");
    expect(f.calls.some(c => c.method === "end")).toBe(false);
    expect(f.cards()).toHaveLength(0);
  } finally { await f.close(); }
});

for (const cause of ["new-pause", "cancel", "pairing", "bad-ack", "cleanup-failure"] as const) {
  test(`retirement race ${cause} retains blocked authority and cannot refresh the port`, async () => {
    const f = await fixture();
    const ack = gate<any>(), entered = gate<void>();
    try {
      f.handle = async method => { if (method === "end") { entered.resolve(); return ack.promise; } return {}; };
      const controller = new AbortController(), done = f.request(controller.signal);
      await entered.promise;
      if (cause === "new-pause") f.pause("requested");
      if (cause === "cancel") controller.abort();
      if (cause === "pairing") f.changePairing();
      if (cause === "cleanup-failure") f.pause("cleanup_failed");
      ack.resolve(cause === "bad-ack" ? { ok: true } : { ok: true, retained: [] });
      expect((await done).status).toBe(cause === "cancel" ? "cancelled" : "failed");
      expect(f.chrome.state(f.agent).task).not.toBeNull();
      expect(f.scoped.get(f.agent)).toBe(f.browser);
      await expect(f.browser.engine.execute("tabs.list", {})).rejects.toThrow();
      // Failed retirement is retryable automatically; no operator repair needed.
      if (cause !== "pairing") {
        f.handle = async method => f.v9(method);
        if (cause === "new-pause" || cause === "cleanup-failure") await Bun.sleep(0);
        expect((await f.request()).status).toBe("approved_closed");
        expect(f.chrome.state(f.agent).task).toBeNull();
      }
    } finally { ack.resolve({ ok: true, retained: [] }); await f.close(); }
  });
}

test("retirement fences and drains accepted work before ending the session", async () => {
  const f = await fixture();
  const ack = gate<any>(), entered = gate<void>();
  try {
    const task = (f.chrome as any).tasks.get(f.agent);
    task.paused = false; task.pauseState = "active";
    f.handle = async method => { if (method === "listTabs") { entered.resolve(); return ack.promise; } return f.v9(method); };
    const work = f.browser.engine.execute("tabs.list", {});
    await entered.promise;
    f.pause();
    const done = f.request();
    const queued = f.browser.engine.execute("tabs.new", {}).catch((e: Error) => e.message);
    expect(f.calls.some(c => c.method === "end")).toBe(false);
    ack.resolve({ tabs: [] });
    await work;
    expect(await queued).toContain("authority expired");
    expect((await done).status).toBe("approved_closed");
    expect(f.calls.filter(c => c.method === "createTab")).toHaveLength(1);
  } finally { ack.resolve({}); await f.close(); }
});

test("real handoffs are rejected while advisory human use alone is not a privacy lock", async () => {
  for (const boundary of ["native", "login", "advisory", "revoked", "disconnected"] as const) {
    const f = await fixture();
    try {
      if (boundary === "native") await f.chrome.pauseForNativeHandoff();
      if (boundary === "login") (f.chrome as any).tasks.get(f.agent).handoff = "real-login-request";
      if (boundary === "advisory") f.chrome.setHumanDesktop(true);
      if (boundary === "revoked") f.admission = false;
      if (boundary === "disconnected") f.connected = false;
      const result = await f.request();
      if (boundary === "advisory") {
        expect(result.status).toBe("approved_closed");
        expect(f.chrome.humanState()).toBe(true);
      } else {
        expect(result.status).toBe("rejected");
        expect(f.calls.some(c => c.method === "end")).toBe(false);
      }
    } finally { await f.close(); }
  }
});

for (const cause of ["cancel", "new-pause", "settlement"] as const) {
  test(`change during active-work drain (${cause}) sends no recovery end and leaves task blocked`, async () => {
    const f = await fixture();
    const drained = gate<any>(), entered = gate<void>();
    try {
      const task = (f.chrome as any).tasks.get(f.agent);
      task.paused = false; task.pauseState = "active";
      f.handle = async method => {
        if (method === "listTabs") { entered.resolve(); return drained.promise; }
        return f.v9(method);
      };
      const work = f.browser.engine.execute("tabs.list", {});
      await entered.promise;
      f.pause();
      const controller = new AbortController(), done = f.request(controller.signal);
      let settling: Promise<void> | undefined;
      if (cause === "cancel") controller.abort();
      if (cause === "new-pause") f.pause("cleanup_failed");
      if (cause === "settlement") settling = f.chrome.settle(f.agent, f.run);
      expect(f.calls.some(c => c.method === "end")).toBe(false);
      drained.resolve({ tabs: [] });
      await work;
      await settling;
      expect((await done).status).toBe(cause === "cancel" ? "cancelled" : "failed");
      expect(f.calls.some(c => c.method === "end" && c.params.discard)).toBe(false);
      expect(f.chrome.state(f.agent).task).not.toBeNull();
      await expect(f.browser.engine.execute("tabs.list", {})).rejects.toThrow();
    } finally { drained.resolve({}); await f.close(); }
  });
}

test("a settled paused session binds its previous cleanup run, not the next requesting run", async () => {
  const f = await fixture();
  try {
    await f.chrome.settle(f.agent, f.run);
    const nextRun = "next-run";
    const browser = f.app.service.browsers.forRun(f.agent, nextRun, { chromeProfile: f.profile }, "Next").get(f.agent);
    const recovery = browser.prepareRecovery!();
    expect(recovery.binding).toMatchObject({ run: nextRun, authorityRun: f.run });
    f.pause("cleanup_failed");
    expect(() => recovery.check()).toThrow("stale");
    recovery.release();
    const next = browser.prepareRecovery!();
    expect((await next.close(new AbortController().signal)).status).toBe("approved_closed");
    expect(f.calls.at(-1)).toMatchObject({ session: f.session, run: f.run, method: "end", params: { discard: true } });
    next.release();
  } finally { await f.close(); }
});

test("cancelled requesting run cannot allocate after automatic retirement", async () => {
  const f = await fixture();
  try {
    expect((await f.request()).status).toBe("approved_closed");
    f.active.cancelled = true;
    expect(() => f.scoped.get(f.agent)).toThrow("current active run");
    expect(f.chrome.state(f.agent).task).toBeNull();
  } finally { await f.close(); }
});

for (const cause of ["cancelled", "ended", "foreign"] as const) {
  test(`failed replacement allocation cannot bypass ${cause} requesting authority on retry`, async () => {
    const f = await fixture();
    try {
      expect((await f.request()).status).toBe("approved_closed");
      f.connected = false;
      expect(() => f.scoped.get(f.agent)).toThrow();
      expect(f.chrome.state(f.agent).task).toBeNull();
      f.connected = true;
      if (cause === "cancelled") f.active.cancelled = true;
      if (cause === "ended") (f.app.service as any).active.delete(f.run);
      if (cause === "foreign") f.active.agentId = "another-agent";
      const count = f.calls.length;
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => f.scoped.get(f.agent)).toThrow("current active run");
        expect(f.chrome.state(f.agent).task).toBeNull();
        expect(f.calls).toHaveLength(count);
      }
    } finally { await f.close(); }
  });
}

test("request ownership cannot substitute another agent or run's browser port", async () => {
  const f = await fixture();
  try {
    for (const [agent, run] of [["foreign", f.run], [f.agent, "foreign"]]) {
      expect((await f.app.service.interventions.recoverBrowser(agent!, run!, f.browser)).status).toBe("rejected");
    }
    expect(f.calls.some(c => c.method === "end")).toBe(false);
    expect(f.chrome.state(f.agent).task).not.toBeNull();
  } finally { await f.close(); }
});
