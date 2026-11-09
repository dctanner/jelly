import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { CHROME_PROTOCOL, CHROME_METHODS } from "../src/shared/chrome-protocol";
const built = await Bun.build({ entrypoints: ["extensions/chrome/worker.js"], target: "browser", format: "iife" });
const source = await built.outputs[0]!.text();
// Drain the worker's asynchronous startup chain instead of assuming a fixed
// number of microtasks across Bun versions and bundle shapes.
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function event() {
  const listeners: Function[] = [];
  return { addListener: (fn: Function) => listeners.push(fn), fire: (...args: any[]) => listeners.forEach(fn => fn(...args)) };
}
interface FakeTab { id: number; windowId: number; url: string; title: string; active: boolean; groupId: number; lastAccessed: number; pinned: boolean }
/** Minimal in-memory Chrome: windows, tabs, groups and a debugger. */
function fakeBrowser() {
  let nextTab = 100, nextGroup = 1;
  const tabs = new Map<number, FakeTab>();
  const windows = new Map<number, { id: number; type: string; focused: boolean }>([[1, { id: 1, type: "normal", focused: true }]]);
  const groups = new Map<number, { title?: string; color?: string }>();
  const attachedTabs = new Set<number>();
  const commands: { target: any; method: string; params: any }[] = [];
  const handlers = new Map<string, (target: any, params: any) => any>();
  const calls: string[] = [];
  const add = (props: Partial<FakeTab> = {}) => {
    const tab: FakeTab = { id: nextTab++, windowId: 1, url: "about:blank", title: "", active: false, groupId: -1, lastAccessed: Date.now(), pinned: false, ...props };
    tabs.set(tab.id, tab);
    return tab;
  };
  const get = (id: number) => { const t = tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}.`); return { ...t }; };
  const debuggerApi = {
    onDetach: event(), onEvent: event(),
    attach: async ({ tabId }: any) => {
      calls.push(`attach:${tabId}`);
      get(tabId);
      await sleep(5);
      if (attachedTabs.has(tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
      attachedTabs.add(tabId);
    },
    detach: async ({ tabId }: any) => {
      calls.push(`detach:${tabId}`);
      if (!attachedTabs.delete(tabId)) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
    },
    getTargets: async () => [...tabs.values()].map(t => ({ tabId: t.id, attached: attachedTabs.has(t.id) })),
    sendCommand: async (target: any, method: string, params: any) => {
      if (!attachedTabs.has(target.tabId)) throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`);
      commands.push({ target, method, params });
      const handler = handlers.get(method);
      return handler ? handler(target, params) : {};
    },
  };
  const chrome: any = {
    debugger: debuggerApi,
    tabs: {
      onRemoved: event(), onReplaced: event(),
      create: async ({ windowId, url, active }: any) => add({ windowId, url, active }),
      get: async (id: number) => get(id),
      update: async (id: number, props: any) => { const t = get(id); Object.assign(tabs.get(id)!, props.url ? { url: props.url } : {}, props.active ? { active: true } : {}); return { ...t, ...props }; },
      remove: async (id: number) => { get(id); tabs.delete(id); attachedTabs.delete(id); chrome.tabs.onRemoved.fire(id, {}); },
      query: async () => [...tabs.values()].map(t => ({ ...t })),
      group: async ({ groupId, tabIds, createProperties }: any) => {
        const id = groupId ?? nextGroup++;
        if (groupId !== undefined && !groups.has(groupId)) throw new Error("No group with id");
        if (groupId === undefined) groups.set(id, {});
        void createProperties;
        for (const tabId of [tabIds].flat()) tabs.get(tabId)!.groupId = id;
        return id;
      },
      ungroup: async (id: number) => { tabs.get(id)!.groupId = -1; },
    },
    tabGroups: { onRemoved: event(), update: async (id: number, props: any) => Object.assign(groups.get(id)!, props) },
    windows: {
      get: async (id: number) => windows.get(id),
      getLastFocused: async () => [...windows.values()].find(w => w.focused),
      getAll: async () => [...windows.values()],
      create: async () => { const w = { id: windows.size + 1, type: "normal", focused: false }; windows.set(w.id, w); return { ...w, tabs: [add({ windowId: w.id })] }; },
      update: async (id: number, props: any) => Object.assign(windows.get(id)!, props),
    },
    webNavigation: { onCreatedNavigationTarget: event() },
    cookies: { getAll: async (filter: any) => [{ name: "sid", value: "v", domain: filter.domain }] },
    bookmarks: {}, history: {}, downloads: {}, sessions: {}, topSites: {},
  };
  return { chrome, tabs, groups, windows, attachedTabs, commands, handlers, calls, add };
}
async function fixture(local: Record<string, any> = {}, session: Record<string, any> = {}, initialization?: Promise<void>) {
  const ports: any[] = [], alarms = new Map<string, any>();
  const storage = (data: any) => ({ get: async () => { if (data === local) await initialization; return { ...data }; }, set: async (value: any) => { Object.assign(data, value); } });
  const browser = fakeBrowser();
  const chrome: any = {
    ...browser.chrome,
    storage: { local: storage(local), session: storage(session) },
    alarms: { onAlarm: event(), create: async (name: string, options: any) => { alarms.set(name, { name, scheduledTime: Date.now() + (options.delayInMinutes ?? options.periodInMinutes) * 60000, periodInMinutes: options.periodInMinutes }); }, get: async (name: string) => alarms.get(name), clear: async (name: string) => alarms.delete(name) },
    runtime: { id: "fixture", getURL: (path: string) => `chrome-extension://fixture/${path}`, onMessage: event(), onStartup: event(), onInstalled: event(), connectNative: () => {
      const port = { onMessage: event(), onDisconnect: event(), messages: [] as any[], postMessage(value: any) { this.messages.push(JSON.parse(JSON.stringify(value))); }, disconnect() {} };
      ports.push(port); return port;
    } },
  };
  runInNewContext(source, { chrome, crypto, TextEncoder, URL, setTimeout, clearTimeout, console, Date });
  await tick();
  const rpc = (action: string, sender = "chrome-extension://fixture/popup.html") => new Promise<any>(resolve => chrome.runtime.onMessage.fire({ action }, { id: "fixture", url: sender }, resolve));
  const paired = (port = ports.at(-1), type = "paired", version = CHROME_PROTOCOL) => port.onMessage.fire({ type, version, capabilities: CHROME_METHODS, generation: port.messages[0].generation, instance: "fixture" });
  const alarm = async (name: string) => { if (!alarms.get(name)?.periodInMinutes) alarms.delete(name); chrome.alarms.onAlarm.fire({ name }); await tick(); };
  return { chrome, browser, ports, alarms, local, session, rpc, paired, alarm };
}
/** A paired fixture with request/response helpers. */
async function relay() {
  const f = await fixture();
  f.paired();
  const port = f.ports[0];
  const send = (method: string, params: object = {}, routing: { session?: string; run?: string } = {}) => {
    const id = crypto.randomUUID();
    port.onMessage.fire({ jsonrpc: "2.0", id, instance: "fixture", generation: port.messages[0].generation, session: routing.session ?? "s", run: routing.run ?? "r", method, params });
    return id;
  };
  const response = async (id: string, timeout = 3000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = port.messages.find((m: any) => m.id === id);
      if (found) return found;
      await sleep(1);
    }
    throw new Error("No fixture response");
  };
  const call = async (method: string, params: object = {}, routing?: { session?: string; run?: string }) => response(send(method, params, routing));
  const ok = async (method: string, params: object = {}, routing?: { session?: string; run?: string }) => {
    const r = await call(method, params, routing);
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
  };
  const notifications = (type: string) => port.messages.filter((m: any) => m.type === type);
  return { ...f, port, send, response, call, ok, notifications };
}

test("begin, createTab, attach and cdp relay results as-is; tabs are grouped in the background", async () => {
  const f = await relay();
  expect(await f.ok("begin", { name: "Research", agent: "agent-a" })).toEqual({ ok: true, tabs: [], paused: false });
  f.browser.handlers.set("Runtime.evaluate", (_t, p) => ({ result: { type: "number", value: p.expression === "1+1" ? 2 : 0 } }));
  const { tab } = await f.ok("createTab", { url: "https://example.com/" });
  expect(tab).toMatchObject({ windowId: 1, active: false, origin: "agent", mark: null, url: "https://example.com/" });
  const groupId = f.browser.tabs.get(tab.id)!.groupId;
  expect(f.browser.groups.get(groupId)).toMatchObject({ title: "🔎 Research" });
  await f.ok("name", { name: "Comparing prices" });
  expect(f.browser.groups.get(groupId)!.title).toBe("🔎 Comparing prices");
  expect(await f.ok("cdp", { tabId: tab.id, method: "Runtime.evaluate", params: { expression: "1+1" } })).toEqual({ result: { type: "number", value: 2 } });
  expect(f.browser.attachedTabs.has(tab.id)).toBe(true); // auto-attached
  expect(await f.ok("attach", { tabId: tab.id })).toEqual({ ok: true }); // idempotent
  expect(f.browser.calls.filter(c => c === `attach:${tab.id}`)).toHaveLength(1);
  expect(f.session.debuggerCleanup).toEqual([tab.id]); // persisted before attach
  expect((await f.ok("listTabs")).tabs.map((t: any) => t.id)).toEqual([tab.id]);
  await f.ok("detach", { tabId: tab.id });
  expect(f.browser.attachedTabs.has(tab.id)).toBe(false);
  expect(f.session.debuggerCleanup).toEqual([]);
  // A second session's tab lands in its own group.
  await f.ok("begin", { name: "Other" }, { session: "s2" });
  const other = (await f.ok("createTab", {}, { session: "s2" })).tab;
  expect(f.browser.tabs.get(other.id)!.groupId).not.toBe(groupId);
  expect((await f.call("cdp", { tabId: other.id, method: "Page.enable" })).error.message).toContain("not part of this browser session");
});

test("requests run concurrently: a slow CDP command does not block others; per-tab attach is serialised", async () => {
  const f = await relay();
  await f.ok("begin", { name: "Task" });
  const a = (await f.ok("createTab")).tab.id, b = (await f.ok("createTab")).tab.id;
  let release!: () => void;
  f.browser.handlers.set("Runtime.awaitPromise", () => new Promise(resolve => { release = () => resolve({ slow: true }); }));
  const slow = f.send("cdp", { tabId: a, method: "Runtime.awaitPromise", timeoutMs: 5000 });
  // Concurrent first calls on one tab attach once.
  const results = await Promise.all([1, 2, 3].map(() => f.ok("cdp", { tabId: b, method: "Page.enable" })));
  expect(results).toEqual([{}, {}, {}]);
  expect(f.browser.calls.filter(c => c === `attach:${b}`)).toHaveLength(1);
  expect(await f.ok("listTabs")).toMatchObject({ tabs: [{ id: a }, { id: b }] });
  expect(f.port.messages.some((m: any) => m.id === slow)).toBe(false);
  release();
  expect((await f.response(slow)).result).toEqual({ slow: true });
});

test("CDP timeouts reject without detaching; cdpBatch runs in order and stops at the first failure", async () => {
  const f = await relay();
  await f.ok("begin", { name: "Task" });
  const tabId = (await f.ok("createTab")).tab.id;
  f.browser.handlers.set("Page.navigate", () => new Promise(() => {}));
  const timedOut = await f.call("cdp", { tabId, method: "Page.navigate", params: { url: "https://slow.example" }, timeoutMs: 30 });
  expect(timedOut.error).toEqual({ code: -32000, message: 'Timed out running CDP command "Page.navigate" after 30ms.' });
  expect(f.browser.attachedTabs.has(tabId)).toBe(true);
  f.browser.handlers.set("Input.dispatchKeyEvent", (_t, p) => ({ key: p.key }));
  const keys = [..."hello"].map(key => ({ method: "Input.dispatchKeyEvent", params: { type: "keyDown", key } }));
  expect(await f.ok("cdpBatch", { tabId, commands: keys })).toEqual({ results: [..."hello"].map(key => ({ key })) });
  expect(f.browser.commands.filter(c => c.method === "Input.dispatchKeyEvent").map(c => c.params.key).join("")).toBe("hello");
  f.browser.handlers.set("DOM.focus", () => { throw new Error('{"code":-32000,"message":"Element is not focusable"}'); });
  const before = f.browser.commands.length;
  const failed = await f.call("cdpBatch", { tabId, commands: [{ method: "Input.dispatchKeyEvent", params: { key: "a" } }, { method: "DOM.focus" }, { method: "Input.dispatchKeyEvent", params: { key: "b" } }] });
  expect(failed.error.message).toBe('Command 1 "DOM.focus" failed: {"code":-32000,"message":"Element is not focusable"}');
  expect(f.browser.commands.slice(before).map(c => c.method)).toEqual(["Input.dispatchKeyEvent", "DOM.focus"]);
  const batchTimeout = await f.call("cdpBatch", { tabId, commands: [{ method: "Page.enable" }, { method: "Page.navigate" }], timeoutMs: 30 });
  expect(batchTimeout.error.message).toContain('Timed out running CDP batch at command 1 "Page.navigate" after 30ms');
  // Invalid params get a specific error and the connection survives.
  expect((await f.call("cdp", { tabId, method: "nope" })).error.message).toContain("CDP method name");
  expect((await f.call("snapshot", { tab: "cap" })).error.message).toContain('Unknown Chrome method "snapshot"');
  expect(await f.rpc("status")).toMatchObject({ connected: true });
});

test("a stale own attachment ('Another debugger') is treated as attached; an unseen detach re-attaches once", async () => {
  const f = await relay();
  await f.ok("begin", { name: "Task" });
  const tabId = (await f.ok("createTab")).tab.id;
  await f.ok("attach", { tabId });
  // Simulate lost state: our attachment persists, but the worker's set forgets it.
  f.browser.chrome.debugger.onDetach.fire({ tabId }, "target_closed");
  expect(f.notifications("cdpDetach").at(-1)).toMatchObject({ tabId, reason: "target_closed", session: "s", run: "r" });
  f.session.debuggerCleanup = [tabId];
  // Another debugger error for a tab no longer recorded as ours is a real error.
  const foreign = await f.call("attach", { tabId });
  expect(foreign.error.message).toContain("Another debugger");
  f.browser.attachedTabs.delete(tabId);
  expect(await f.ok("cdp", { tabId, method: "Page.enable" })).toEqual({});
  // Debugger dropped without onDetach: re-attach and retry once.
  f.browser.attachedTabs.delete(tabId);
  expect(await f.ok("cdp", { tabId, method: "Page.enable" })).toEqual({});
  expect(f.browser.attachedTabs.has(tabId)).toBe(true);
});

test("CDP events (including child sessions) are forwarded for leased tabs only", async () => {
  const f = await relay();
  await f.ok("begin", { name: "Task" });
  const tabId = (await f.ok("createTab")).tab.id;
  const stranger = f.browser.add();
  f.browser.chrome.debugger.onEvent.fire({ tabId }, "Page.loadEventFired", { timestamp: 1 });
  f.browser.chrome.debugger.onEvent.fire({ tabId, sessionId: "child-1" }, "Runtime.consoleAPICalled", { type: "log" });
  f.browser.chrome.debugger.onEvent.fire({ tabId: stranger.id }, "Page.loadEventFired", {});
  const events = f.notifications("cdpEvent");
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ session: "s", run: "r", tabId, method: "Page.loadEventFired", params: { timestamp: 1 } });
  expect(events[0]).not.toHaveProperty("sessionId");
  expect(events[1]).toMatchObject({ tabId, sessionId: "child-1", method: "Runtime.consoleAPICalled" });
});

test("popups from leased tabs are auto-leased into the group; user tabs can be listed and claimed", async () => {
  const f = await relay();
  await f.ok("begin", { name: "Task" });
  const opener = (await f.ok("createTab")).tab.id;
  const popup = f.browser.add({ url: "https://popup.example/" });
  f.browser.chrome.webNavigation.onCreatedNavigationTarget.fire({ sourceTabId: opener, tabId: popup.id, url: popup.url });
  for (let i = 0; i < 50 && !f.notifications("tabAdded").length; i++) await sleep(2);
  expect(f.notifications("tabAdded")[0]).toMatchObject({ session: "s", run: "r", tab: { id: popup.id, origin: "agent", url: "https://popup.example/" } });
  expect(f.browser.tabs.get(popup.id)!.groupId).toBe(f.browser.tabs.get(opener)!.groupId);
  const personal = f.browser.add({ url: "https://mail.example/", title: "Mail", lastAccessed: Date.now() + 1000 });
  await f.ok("begin", { name: "Other" }, { session: "s2" });
  const theirs = (await f.ok("createTab", {}, { session: "s2" })).tab.id;
  const { tabs } = await f.ok("userTabs");
  expect(tabs[0]).toMatchObject({ id: personal.id, title: "Mail", groupId: -1, pinned: false });
  expect(tabs.map((t: any) => t.id)).not.toContain(theirs);
  expect(tabs.map((t: any) => t.id)).toContain(opener);
  expect((await f.call("claimTab", { tabId: theirs })).error.message).toContain("another browser session");
  expect((await f.ok("claimTab", { tabId: personal.id })).tab).toMatchObject({ id: personal.id, origin: "user", mark: null });
  expect(f.browser.tabs.get(personal.id)!.groupId).toBe(-1); // never regrouped
  expect(await f.ok("cdp", { tabId: personal.id, method: "Page.enable" })).toEqual({});
  // Human closes a tab.
  await f.browser.chrome.tabs.remove(popup.id);
  expect(f.notifications("tabRemoved").at(-1)).toMatchObject({ tabId: popup.id, session: "s" });
});

test("turn end closes unmarked agent tabs, releases user tabs, ungroups deliverables and retains handoffs", async () => {
  const f = await relay();
  await f.ok("begin", { name: "Task" });
  const scratch = (await f.ok("createTab")).tab.id;
  const deliverable = (await f.ok("createTab")).tab.id;
  const handoff = (await f.ok("createTab")).tab.id;
  const user = f.browser.add().id;
  await f.ok("claimTab", { tabId: user });
  await f.ok("markTab", { tabId: deliverable, mark: "deliverable" });
  await f.ok("markTab", { tabId: handoff, mark: "handoff" });
  for (const tabId of [scratch, deliverable, handoff, user]) await f.ok("attach", { tabId });
  expect(await f.ok("end")).toEqual({ ok: true, retained: [handoff] });
  expect(f.browser.tabs.has(scratch)).toBe(false);
  expect(f.browser.tabs.get(deliverable)!.groupId).toBe(-1);
  expect(f.browser.tabs.has(user)).toBe(true);
  expect(f.browser.attachedTabs.size).toBe(0);
  expect(f.notifications("pauseState").map((m: any) => [m.state, m.reason])).toEqual([["pausing", "settlement"], ["paused", "settlement"]]);
  expect((await f.call("cdp", { tabId: handoff, method: "Page.enable" })).error.message).toContain("turn has ended");
  expect(await f.ok("begin", { name: "Task" }, { run: "r2" })).toEqual({ ok: true, tabs: [handoff], paused: false });
  expect(await f.ok("cdp", { tabId: handoff, method: "Page.enable" }, { run: "r2" })).toEqual({});
  expect((await f.call("cdp", { tabId: handoff, method: "Page.enable" })).error.message).toContain("stale");
  // Discard releases handoffs instead of retaining them.
  await f.ok("markTab", { tabId: handoff, mark: "handoff" }, { run: "r2" });
  expect(await f.ok("end", { discard: true }, { run: "r2" })).toEqual({ ok: true, retained: [] });
  expect(f.browser.tabs.has(handoff)).toBe(true);
  expect(await f.ok("begin", { name: "Task" }, { run: "r3" })).toEqual({ ok: true, tabs: [], paused: false });
});

test("pause detaches debuggers and refuses work until resume; human-paused tabs survive turn end", async () => {
  const f = await relay();
  await f.ok("begin", { name: "Task" });
  const tabId = (await f.ok("createTab")).tab.id;
  await f.ok("cdp", { tabId, method: "Page.enable" });
  expect(await f.ok("pause")).toEqual({ ok: true });
  expect(f.browser.attachedTabs.has(tabId)).toBe(false);
  expect(f.notifications("pauseState").map((m: any) => m.state)).toEqual(["pausing", "paused"]);
  expect((await f.call("cdp", { tabId, method: "Page.enable" })).error.message).toBe("Browser session is paused.");
  expect((await f.ok("listTabs")).tabs).toHaveLength(1);
  expect(await f.ok("resume")).toEqual({ ok: true });
  expect(await f.ok("cdp", { tabId, method: "Page.enable" })).toEqual({});
  await f.ok("pause");
  expect(await f.ok("end")).toEqual({ ok: true, retained: [tabId] }); // pause-retained
  expect(f.browser.tabs.has(tabId)).toBe(true);
  // freeze pauses every session for the native handoff; unfreeze lifts only the latch.
  await f.ok("begin", { name: "Task" }, { run: "r2" });
  await f.ok("cdp", { tabId, method: "Page.enable" }, { run: "r2" });
  expect(await f.ok("freeze")).toEqual({ frozen: true });
  expect(f.browser.attachedTabs.size).toBe(0);
  expect(f.notifications("pauseState").at(-1)).toMatchObject({ state: "paused", reason: "native_handoff" });
  expect((await f.call("createTab", {}, { run: "r2" })).error.message).toContain("frozen");
  await f.ok("unfreeze");
  expect((await f.call("cdp", { tabId, method: "Page.enable" }, { run: "r2" })).error.message).toBe("Browser session is paused.");
  await f.ok("resume", {}, { run: "r2" });
  expect(await f.ok("cdp", { tabId, method: "Page.enable" }, { run: "r2" })).toEqual({});
});

test("chrome passthrough calls chrome.<namespace>.<method>; showTab/closeTab manage leased tabs", async () => {
  const f = await relay();
  await f.ok("begin", { name: "Task" });
  expect(await f.ok("chrome", { namespace: "cookies", method: "getAll", args: [{ domain: "example.com" }] })).toEqual([{ name: "sid", value: "v", domain: "example.com" }]);
  expect((await f.call("chrome", { namespace: "bookmarks", method: "search", args: [] })).error.message).toBe("chrome.bookmarks.search is not available.");
  const tabId = (await f.ok("createTab")).tab.id;
  await f.ok("showTab", { tabId });
  expect(f.browser.tabs.get(tabId)!.active).toBe(true);
  await f.ok("attach", { tabId });
  await f.ok("closeTab", { tabId });
  expect(f.browser.tabs.has(tabId)).toBe(false);
  expect(f.browser.attachedTabs.has(tabId)).toBe(false);
  expect((await f.ok("listTabs")).tabs).toEqual([]);
});

test("losing the native port detaches debuggers; the dead-man alarm detaches strays", async () => {
  const f = await relay();
  await f.ok("begin", { name: "Task" });
  const tabId = (await f.ok("createTab")).tab.id;
  await f.ok("attach", { tabId });
  expect(f.alarms.get("jelly-debugger-deadman")?.periodInMinutes).toBe(0.5);
  await f.alarm("jelly-debugger-deadman"); // connected: no-op
  expect(f.browser.attachedTabs.has(tabId)).toBe(true);
  f.port.onDisconnect.fire();
  for (let i = 0; i < 50 && f.browser.attachedTabs.size; i++) await sleep(2);
  expect(f.browser.attachedTabs.size).toBe(0);
  expect((await f.rpc("status")).sessions).toEqual([]);
  f.browser.attachedTabs.add(tabId); // a stray attachment
  await f.alarm("jelly-debugger-deadman");
  for (let i = 0; i < 50 && f.browser.attachedTabs.size; i++) await sleep(2);
  expect(f.browser.attachedTabs.size).toBe(0);
});

test("auto-connect without popup is single flight, pending and opaque errors are visible", async () => {
  const f = await fixture();
  expect(f.ports).toHaveLength(1);
  expect((await f.rpc("status")).connecting).toBe(true);
  f.chrome.runtime.onStartup.fire(); f.chrome.runtime.onInstalled.fire();
  await Promise.all([f.rpc("connect"), f.rpc("status")]);
  expect(f.ports).toHaveLength(1);
  f.paired(undefined, "pending"); await tick();
  expect(await f.rpc("status")).toMatchObject({ pending: true, connected: false });
  expect(f.ports[0].messages.at(-1).type).toBe("pendingReady");
  f.paired();
  expect((await f.rpc("status")).connected).toBe(true);
  f.chrome.runtime.lastError = { message: "/secret/path token=PRIVATE" };
  f.ports[0].onDisconnect.fire(); await tick();
  const status = await f.rpc("status");
  expect(status.connectionError).toBe("host-unavailable");
  expect(JSON.stringify(status)).not.toContain("PRIVATE");
  expect(f.alarms.has("jelly-connect-retry")).toBe(true);
  await f.alarm("jelly-connect-retry");
  expect(f.ports).toHaveLength(2);
  f.paired(f.ports[0]);
  expect((await f.rpc("status")).connected).toBe(false);
  f.paired();
  expect((await f.rpc("status")).sessions).toEqual([]);
});
test("Disconnect persists across recreation; legacy fragment/status never reconnect; unknown actions rejected", async () => {
  const f = await fixture();
  await f.rpc("disconnect");
  expect(f.local.connectionOptOut).toBe(true);
  const next = await fixture(f.local);
  expect(next.ports).toHaveLength(0);
  expect((await next.rpc("status", "chrome-extension://fixture/popup.html#connect")).optedOut).toBe(true);
  expect(await next.rpc("grant")).toEqual({ error: "Unavailable" });
  next.chrome.runtime.onMessage.fire({ action: "connect" }, { id: "fixture", url: "https://example.com" }, () => { throw new Error("Untrusted RPC answered"); });
  await tick(); expect(next.ports).toHaveLength(0);
  await next.rpc("connect");
  expect(next.ports[0].messages[0].explicitReconnect).toBe(true);
  next.ports[0].onDisconnect.fire(); await tick();
  await next.alarm("jelly-connect-retry");
  expect(next.ports[1].messages[0].explicitReconnect).toBe(false);
});
test("missing host, handshake deadline and server opt-out are bounded and visible", async () => {
  const f = await fixture();
  await f.alarm([...f.alarms.keys()].find(name => name.startsWith("jelly-connect-handshake"))!);
  expect((await f.rpc("status")).connectionError).toBe("handshake-timeout");
  await f.alarm("jelly-connect-retry");
  f.chrome.runtime.lastError = { message: "Specified native messaging host not found." };
  f.ports.at(-1).onDisconnect.fire(); await tick();
  expect((await f.rpc("status")).connectionError).toBe("host-missing");
  await f.alarm("jelly-connect-retry");
  const port = f.ports.at(-1);
  port.onMessage.fire({ type: "reconnectRequired", generation: port.messages[0].generation }); await tick();
  expect(f.local.connectionOptOut).toBe(true);
  expect(f.alarms.has("jelly-connect-retry")).toBe(false);
});

test("Disconnect fences connect awaiting initialization, and stale handshake alarms cannot revoke a new epoch", async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({}, {}, ready);
  const disconnect = f.rpc("disconnect");
  release(); await disconnect; await tick();
  expect(f.ports).toHaveLength(0);
  await f.rpc("connect");
  const oldAlarm = [...f.alarms.keys()].find(name => name.startsWith("jelly-connect-handshake"))!;
  await f.rpc("disconnect");
  await f.rpc("connect");
  await f.alarm(oldAlarm);
  expect((await f.rpc("status")).connecting).toBe(true);
  f.paired();
  expect((await f.rpc("status")).connected).toBe(true);
});
test("persisted debugger obligations are detached at startup; unresolved ones block automatic pairing", async () => {
  // Resolvable: detached on worker start, then pairing proceeds.
  let release!: () => void;
  let ready = new Promise<void>(resolve => { release = resolve; });
  const clean = await fixture({}, { debuggerCleanup: [7] }, ready);
  clean.browser.attachedTabs.add(7);
  clean.browser.tabs.set(7, { id: 7, windowId: 1, url: "", title: "", active: false, groupId: -1, lastAccessed: 0, pinned: false });
  release(); await sleep(20);
  expect(clean.browser.attachedTabs.has(7)).toBe(false);
  expect(clean.session.debuggerCleanup).toEqual([]);
  expect(clean.ports).toHaveLength(1);
  // Unresolvable: detach fails while the target still reports attached.
  ready = new Promise<void>(resolve => { release = resolve; });
  const blocked = await fixture({}, { debuggerCleanup: [7] }, ready);
  blocked.chrome.debugger.detach = async () => { throw new Error("fixture detach failed"); };
  blocked.chrome.debugger.getTargets = async () => [{ tabId: 7, attached: true }];
  release(); await sleep(20);
  expect(blocked.ports).toHaveLength(0);
  const status = await blocked.rpc("status");
  expect(status).toMatchObject({ connectionError: "cleanup-required", unresolvedDebuggerCleanup: 1, sessions: [] });
  expect(blocked.alarms.has("jelly-connect-retry")).toBe(false);
  blocked.chrome.debugger.getTargets = async () => [];
  await blocked.rpc("connect");
  expect(blocked.ports).toHaveLength(1);
});

test("v9 automatic connection refuses v8 pairing without fallback", async () => {
  const f = await fixture();
  expect(f.ports[0].messages[0].version).toBe(9);
  f.paired(f.ports[0], "paired", 8);
  await tick();
  expect(await f.rpc("status")).toMatchObject({ connected: false, connectionError: "protocol-error", sessions: [] });
  await f.alarm("jelly-connect-retry");
  expect(f.ports[1].messages[0].version).toBe(9);
});
test("pending private pairing loss never publishes or reclaims sessions; old pending handback is fenced", async () => {
  const f = await fixture();
  f.paired(undefined, "pending"); await tick();
  f.ports[0].onDisconnect.fire(); await tick();
  await f.alarm("jelly-connect-retry");
  f.paired(f.ports[0]);
  expect(await f.rpc("status")).toMatchObject({ connected: false, sessions: [] });
  f.paired(undefined, "pending"); await tick();
  expect(await f.rpc("status")).toMatchObject({ connected: false, pending: true, sessions: [] });
  f.paired();
  expect(await f.rpc("status")).toMatchObject({ connected: true, sessions: [] });
});
test("requests with a stale instance or generation drop the connection", async () => {
  const f = await relay();
  f.port.onMessage.fire({ jsonrpc: "2.0", id: "x", instance: "other", generation: f.port.messages[0].generation, session: "s", run: "r", method: "listTabs", params: {} });
  await tick(); await tick();
  expect(await f.rpc("status")).toMatchObject({ connected: false, connectionError: "protocol-error" });
});
