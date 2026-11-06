import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./fixtures/app";
import { interventionTools } from "../src/server/agent-tools";
import type { BrowserRecoveryResult } from "../src/shared/browser-recovery";

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
  let handle = async (method: string): Promise<any> => method === "end" ? { ok: true, retained: [] } : method === "open" ? { pageId: crypto.randomUUID() } : { ok: true };
  chrome.bridge.profiles = () => connected ? [{ id: profile, generation, connected: true }] : [];
  chrome.bridge.canReconnect = (p, g) => admission && connected && p === profile && g === generation;
  chrome.bridge.call = async (_p, _g, session, authorityRun, method, params) => {
    calls.push({ session, run: authorityRun, method, params });
    return handle(method);
  };
  const scoped = (app.service as any).scopedBrowser(agent, run, { chromeProfile: profile }, "Fixture");
  const browser = scoped.get(agent);
  await browser.action("open", { url: "https://example.com" });
  const session = calls[0]!.session;
  const pause = (reason: "navigation_denied" | "cleanup_failed" | "native_handoff" = "navigation_denied") =>
    chrome.bridge.onPauseState(profile, generation, session, run, "paused", reason);
  pause();
  const tools = interventionTools(scoped, app.service.interventions, agent, run, dir);
  const tool = tools.find(t => t.name === "request_browser_recovery")!;
  const updates: BrowserRecoveryResult[] = [];
  const request = (signal?: AbortSignal) => tool.execute("recovery", {}, signal, value => updates.push(JSON.parse((value.content[0] as any).text)), {} as any)
    .then(value => JSON.parse((value.content[0] as any).text) as BrowserRecoveryResult);
  const item = () => app.service.interventions.list().find(i => i.kind === "browser_recovery" && ["pending", "executing"].includes(i.status))!;
  const bootstrap = await fetch(`${app.server.url.origin}/api/control-session`);
  const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
  const { csrf } = await bootstrap.json() as { csrf: string };
  const headers = { cookie, "x-jelly-csrf": csrf, "content-type": "application/json" };
  const confirm = (id = item().id, binding = item().payload.binding, extraHeaders = headers) => fetch(`${app.server.url.origin}/api/interventions/${id}/confirm-browser-recovery`, {
    method: "POST", headers: extraHeaders, body: JSON.stringify({ binding }),
  });
  return {
    app, chrome, agent, run, profile, session, scoped, browser, tools, tool, updates, calls, active, request, item, confirm, headers, pause,
    set handle(value: typeof handle) { handle = value; },
    set connected(value: boolean) { connected = value; },
    set admission(value: boolean) { admission = value; },
    lose() { chrome.bridge.onLoss(profile); generation = crypto.randomUUID(); },
    changePairing() { generation = crypto.randomUUID(); },
    async close() { (app.service as any).active.delete(run); await app.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("human confirmation retires exact active connected session, drains ACK, preserves pin and never replays", async () => {
  const f = await fixture();
  try {
    const otherId = f.app.service.createAgent({ name: "Other", instructions: "Fixture", color: "#b5bafc" }).id;
    const other = f.app.service.browsers.forRun(otherId, "other-run", { chromeProfile: f.profile }, "Other").get(otherId);
    await other.action("open", { url: "https://example.com/other" });
    const otherState = f.chrome.state(otherId).task;
    const done = f.request();
    expect(f.updates.map(u => u.status)).toEqual(["requested", "awaiting_human"]);
    expect(f.calls.filter(c => c.method === "end")).toHaveLength(0);
    const before = f.item();
    expect(before.agentId).toBe(f.agent);
    expect(before.payload).not.toHaveProperty("url");
    const entered = gate<void>(), ack = gate<any>();
    f.handle = async method => {
      if (method === "end") {
        // Own settlement events do not invalidate their exact confirmation.
        const b = before.payload.binding as any;
        f.chrome.bridge.onPauseState(f.profile, b.generation, f.session, f.run, "pausing", "settlement");
        entered.resolve(); return ack.promise;
      }
      return { ok: true, pageId: "fresh-tab" };
    };
    const confirmed = f.confirm();
    await entered.promise;
    expect(f.app.store.intervention(before.id)?.status).toBe("executing");
    expect(f.chrome.state(f.agent).task).not.toBeNull();
    await expect(f.browser.action("snapshot")).rejects.toThrow("authority expired");
    expect((await f.confirm(before.id, before.payload.binding)).status).toBe(409);
    ack.resolve({ ok: true, retained: [] });
    expect((await confirmed).status).toBe(200);
    expect(await done).toMatchObject({ status: "approved_closed", disposition: "closed_connected_session" });
    expect(f.chrome.state(f.agent).task).toBeNull();
    expect(f.chrome.state(otherId).task).toEqual(otherState);
    expect(f.app.service.browsers.target(f.agent)).toBe("chrome");
    expect(f.calls.filter(c => c.method === "end")).toEqual([{ session: f.session, run: f.run, method: "end", params: { discard: true } }]);
    expect(f.calls.filter(c => c.method === "open")).toHaveLength(2);
    const fresh = f.scoped.get(f.agent);
    await fresh.action("open", { url: "https://example.com/fresh" });
    expect(f.calls.at(-1)!.session).not.toBe(f.session);
    expect(f.chrome.state(f.agent).task!.profile).toBe(f.profile);
    await expect(f.browser.action("snapshot")).rejects.toThrow("authority expired");
    expect((await f.confirm(before.id, before.payload.binding)).status).toBe(409);
  } finally { await f.close(); }
});

test("human-confirmed lost retirement needs freshly paired cleanup-cleared same profile; never calls old tabs", async () => {
  const f = await fixture();
  try {
    f.lose();
    const done = f.request(), request = f.item();
    expect((request.payload.binding as any).generation).not.toBe((request.payload.binding as any).pairedGeneration);
    const count = f.calls.length;
    expect((await f.confirm()).status).toBe(200);
    const result = await done;
    expect(result).toMatchObject({ status: "approved_closed", disposition: "retired_lost_session" });
    expect(result.message).toContain("Old tabs may remain");
    expect(f.calls).toHaveLength(count);
    expect(f.chrome.state(f.agent).task).toBeNull();
  } finally { await f.close(); }
});

test("no tool-based self approval or ordinary approve route; operator cookie and CSRF remain mandatory", async () => {
  const f = await fixture();
  try {
    expect(f.tools.map(t => t.name).filter(n => /recovery/.test(n))).toEqual(["request_browser_recovery"]);
    expect(f.tool.parameters).toMatchObject({ properties: {}, additionalProperties: false });
    const forged = await f.tool.execute("forged", { approve: true } as any, undefined, undefined, {} as any);
    expect(JSON.parse((forged.content[0] as any).text).status).toBe("rejected");
    expect(f.item()).toBeUndefined();
    const done = f.request(), item = f.item();
    expect((await f.confirm(item.id, item.payload.binding, {} as any)).status).toBe(401);
    expect((await f.confirm(item.id, item.payload.binding, { ...f.headers, "x-jelly-csrf": "bad" })).status).toBe(403);
    expect((await f.confirm(item.id, item.payload.binding, { ...f.headers, origin: "https://foreign.example" } as any)).status).toBe(403);
    const approve = await fetch(`${f.app.server.url.origin}/api/interventions/${item.id}/approve`, { method: "POST", headers: f.headers, body: JSON.stringify({ password: "" }) });
    expect(approve.status).toBe(400);
    expect(f.chrome.state(f.agent).task).not.toBeNull();
    f.app.service.interventions.deny(item.id);
    expect((await done).status).toBe("rejected");
    expect(f.calls.some(c => c.method === "end")).toBe(false);
  } finally { await f.close(); }
});

for (const key of ["agent", "run", "authorityRun", "session", "profile", "generation", "pairedGeneration", "revision", "pauseState", "lost"]) {
  test(`confirmation refuses mismatched displayed ${key}`, async () => {
    const f = await fixture();
    try {
      const done = f.request(), item = f.item();
      expect((await f.confirm(item.id, { ...(item.payload.binding as object), [key]: "wrong" })).status).toBe(409);
      f.app.service.interventions.deny(item.id);
      expect((await done).status).toBe("rejected");
      expect(f.calls.some(c => c.method === "end")).toBe(false);
    } finally { await f.close(); }
  });
}

for (const cause of ["pause", "pairing", "revoked", "disconnect", "cancelled-run", "foreign-run", "settlement", "native"] as const) {
  test(`awaiting request becomes stale after ${cause}, without closure`, async () => {
    const f = await fixture();
    try {
      const done = f.request(), item = f.item();
      if (cause === "pause") f.pause("cleanup_failed");
      if (cause === "pairing") f.changePairing();
      if (cause === "revoked") f.admission = false;
      if (cause === "disconnect") f.connected = false;
      if (cause === "cancelled-run") f.active.cancelled = true;
      if (cause === "foreign-run") f.active.agentId = "foreign";
      if (cause === "settlement") await f.chrome.settle(f.agent, f.run);
      if (cause === "native") await f.chrome.pauseForNativeHandoff();
      const count = f.calls.length;
      expect((await done).status).toBe("stale");
      expect((await f.confirm(item.id, item.payload.binding)).status).toBe(409);
      expect(f.calls).toHaveLength(count);
    } finally { await f.close(); }
  });
}

test("pending cancellation, expiry and duplicate requests never imply approval", async () => {
  for (const cause of ["cancel", "expiry", "duplicate"] as const) {
    const f = await fixture(cause === "expiry" ? 40 : 10000);
    try {
      const controller = new AbortController(), done = f.request(controller.signal);
      if (cause === "duplicate") {
        expect((await f.request()).status).toBe("rejected");
        controller.abort();
      }
      if (cause === "cancel") controller.abort();
      expect((await done).status).toBe(cause === "expiry" ? "stale" : "cancelled");
      expect(f.calls.some(c => c.method === "end")).toBe(false);
    } finally { await f.close(); }
  }
});

for (const cause of ["new-pause", "cancel", "pairing", "bad-ack", "cleanup-failure"] as const) {
  test(`confirmation race ${cause} retains blocked authority and cannot refresh the port`, async () => {
    const f = await fixture();
    const ack = gate<any>(), entered = gate<void>();
    try {
      const controller = new AbortController(), done = f.request(controller.signal);
      f.handle = async method => { if (method === "end") { entered.resolve(); return ack.promise; } return {}; };
      const confirmation = f.confirm();
      await entered.promise;
      if (cause === "new-pause") f.pause("navigation_denied");
      if (cause === "cancel") controller.abort();
      if (cause === "pairing") f.changePairing();
      if (cause === "cleanup-failure") f.pause("cleanup_failed");
      ack.resolve(cause === "bad-ack" ? { ok: true } : { ok: true, retained: [] });
      await confirmation;
      expect((await done).status).toBe(cause === "cancel" ? "cancelled" : "failed");
      expect(f.chrome.state(f.agent).task).not.toBeNull();
      expect(f.scoped.get(f.agent)).toBe(f.browser);
      await expect(f.browser.action("snapshot")).rejects.toThrow("authority expired");
    } finally { ack.resolve({ ok: true, retained: [] }); await f.close(); }
  });
}

test("approval fences and drains accepted work without waiting on its own requesting tool", async () => {
  const f = await fixture();
  const ack = gate<any>(), entered = gate<void>();
  try {
    // A transport-loss error can leave an already admitted browser call draining.
    const task = (f.chrome as any).tasks.get(f.agent);
    task.paused = false; task.pauseState = "active";
    f.handle = async method => { if (method === "snapshot") { entered.resolve(); return ack.promise; } return { ok: true, retained: [] }; };
    const work = f.browser.action("snapshot");
    await entered.promise;
    f.pause();
    const done = f.request();
    const confirmation = f.confirm();
    for (let i = 0; i < 100 && f.item()?.status !== "executing"; i++) await Bun.sleep(2);
    expect(f.item().status).toBe("executing");
    const queued = f.browser.action("open", { url: "https://example.com/no-replay" }).catch((e: Error) => e.message);
    expect(f.calls.some(c => c.method === "end")).toBe(false);
    ack.resolve({ text: "old observation" });
    await work;
    await confirmation;
    expect(await queued).toContain("authority expired");
    expect((await done).status).toBe("approved_closed");
    expect(f.calls.filter(c => c.method === "open")).toHaveLength(1);
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
      const done = f.request();
      if (boundary === "advisory") {
        expect((await f.confirm()).status).toBe(200);
        expect((await done).status).toBe("approved_closed");
        expect(f.chrome.humanState()).toBe(true);
      } else {
        expect((await done).status).toBe("rejected");
        expect(f.item()).toBeUndefined();
        expect(f.calls.some(c => c.method === "end")).toBe(false);
      }
    } finally { await f.close(); }
  }
});

test("restart interrupts persisted pending recovery; no confirmation continuation is reconstructed", async () => {
  const f = await fixture();
  try {
    const done = f.request(), item = f.item();
    // Store restart reconciliation is the production path; no agent/session state is restored.
    f.app.store.recover();
    expect(f.app.store.intervention(item.id)?.status).toBe("interrupted");
    expect((await f.confirm(item.id, item.payload.binding)).status).toBe(409);
    await f.app.service.interventions.close();
    expect((await done).status).toBe("cancelled");
  } finally { await f.close(); }
});

for (const cause of ["cancel", "new-pause", "settlement"] as const) {
  test(`change during active-work drain (${cause}) sends no recovery end and leaves task blocked`, async () => {
    const f = await fixture();
    const drained = gate<any>(), entered = gate<void>();
    try {
      const task = (f.chrome as any).tasks.get(f.agent);
      task.paused = false; task.pauseState = "active";
      f.handle = async method => {
        if (method === "snapshot") { entered.resolve(); return drained.promise; }
        return { ok: true, retained: [] };
      };
      const work = f.browser.action("snapshot");
      await entered.promise;
      f.pause();
      const controller = new AbortController(), done = f.request(controller.signal);
      const confirmation = f.confirm();
      for (let i = 0; i < 100 && f.item()?.status !== "executing"; i++) await Bun.sleep(2);
      expect(f.item().status).toBe("executing");
      let settling: Promise<void> | undefined;
      if (cause === "cancel") controller.abort();
      if (cause === "new-pause") f.pause("cleanup_failed");
      if (cause === "settlement") settling = f.chrome.settle(f.agent, f.run);
      expect(f.calls.some(c => c.method === "end")).toBe(false);
      drained.resolve({ text: "old" });
      await work;
      await confirmation;
      await settling;
      expect((await done).status).toBe(cause === "cancel" ? "cancelled" : "failed");
      // Settlement may send its normal end, never recovery's discard request.
      expect(f.calls.some(c => c.method === "end" && c.params.discard)).toBe(false);
      expect(f.chrome.state(f.agent).task).not.toBeNull();
      await expect(f.browser.action("snapshot")).rejects.toThrow("authority expired");
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
    // An event for the still-existing extension authority must stale the card.
    f.pause("cleanup_failed");
    expect(() => recovery.check()).toThrow("stale");
    recovery.release();
    const next = browser.prepareRecovery!();
    expect((await next.close(new AbortController().signal)).status).toBe("approved_closed");
    expect(f.calls.at(-1)).toMatchObject({ session: f.session, run: f.run, method: "end", params: { discard: true } });
    next.release();
  } finally { await f.close(); }
});

test("cancelled requesting run cannot allocate after successful human retirement", async () => {
  const f = await fixture();
  try {
    const done = f.request();
    await f.confirm();
    expect((await done).status).toBe("approved_closed");
    f.active.cancelled = true;
    expect(() => f.scoped.get(f.agent)).toThrow("current active run");
    expect(f.chrome.state(f.agent).task).toBeNull();
  } finally { await f.close(); }
});

for (const cause of ["cancelled", "ended", "foreign"] as const) {
  test(`failed replacement allocation cannot bypass ${cause} requesting authority on retry`, async () => {
    const f = await fixture();
    try {
      const done = f.request();
      expect((await f.confirm()).status).toBe(200);
      expect((await done).status).toBe("approved_closed");
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

test("fresh service cannot confirm persisted interrupted requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-recovery-restart-"));
  let app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
  try {
    const agent = app.store.agents()[0]!.id;
    const run = app.store.createRun(agent, crypto.randomUUID(), "Fixture", "api", "model");
    const old = app.store.createIntervention("browser_recovery", agent, run.id, { binding: { session: "old" } }, new Date(Date.now() + 60000).toISOString());
    await app.close();
    app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
    expect(app.store.intervention(old.id)?.status).toBe("interrupted");
    expect(() => app.service.interventions.confirmBrowserRecovery(old.id, old.payload.binding)).toThrow("no longer");
    expect(app.service.chrome.state(agent).task).toBeNull();
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("request ownership cannot substitute another agent or run's browser port", async () => {
  const f = await fixture();
  try {
    for (const [agent, run] of [["foreign", f.run], [f.agent, "foreign"]]) {
      expect((await f.app.service.interventions.recoverBrowser(agent!, run!, f.browser)).status).toBe("rejected");
      expect(f.item()).toBeUndefined();
    }
    const done = f.request();
    f.app.service.interventions.deny(f.item().id);
    expect((await done).status).toBe("rejected");
  } finally { await f.close(); }
});
