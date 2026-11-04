import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { CHROME_PROTOCOL, CHROME_METHODS, chromeParams } from "../src/shared/chrome-protocol";
const built = await Bun.build({ entrypoints: ["extensions/chrome/worker.js"], target: "browser", format: "iife" });
const source = await built.outputs[0]!.text();
// Drain the worker's asynchronous startup chain instead of assuming a fixed
// number of microtasks across Bun versions and bundle shapes.
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function event() {
  const listeners: Function[] = [];
  return { addListener: (fn: Function) => listeners.push(fn), fire: (...args: any[]) => listeners.forEach(fn => fn(...args)) };
}
async function fixture(local: Record<string, any> = {}, session: Record<string, any> = {}, initialization?: Promise<void>) {
  const ports: any[] = [], alarms = new Map<string, any>();
  const storage = (data: any) => ({ get: async () => { if (data === local) await initialization; return { ...data }; }, set: async (value: any) => { Object.assign(data, value); } });
  const chrome: any = {
    storage: { local: storage(local), session: storage(session) },
    alarms: { onAlarm: event(), create: async (name: string, options: any) => { alarms.set(name, { name, scheduledTime: Date.now() + options.delayInMinutes * 60000 }); }, get: async (name: string) => alarms.get(name), clear: async (name: string) => alarms.delete(name) },
    runtime: { id: "fixture", getURL: (path: string) => `chrome-extension://fixture/${path}`, onMessage: event(), onStartup: event(), onInstalled: event(), connectNative: () => {
      const port = { onMessage: event(), onDisconnect: event(), messages: [] as any[], postMessage(value: any) { this.messages.push(value); }, disconnect() {} };
      ports.push(port); return port;
    } },
    debugger: { onDetach: event(), detach: async () => {}, getTargets: async () => [] },
    declarativeNetRequest: { getSessionRules: async () => [], updateSessionRules: async () => {} },
    tabs: { onUpdated: event(), onRemoved: event(), onReplaced: event(), query: () => { throw new Error("Candidates must not be enumerated"); } },
    tabGroups: { onRemoved: event() },
    webNavigation: { onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event(), onCommitted: event(), onCreatedNavigationTarget: event() },
  };
  let frozenTime: number | undefined;
  class FixtureDate extends Date { static now() { return frozenTime ?? Date.now(); } }
  runInNewContext(source, { chrome, crypto, TextEncoder, URL, setTimeout, clearTimeout, console, Date: FixtureDate });
  await tick();
  const rpc = (action: string, sender = "chrome-extension://fixture/popup.html") => new Promise<any>(resolve => chrome.runtime.onMessage.fire({ action, session: "anything", tab: 1 }, { id: "fixture", url: sender }, resolve));
  const paired = (port = ports.at(-1), type = "paired") => port.onMessage.fire({ type, version: CHROME_PROTOCOL, capabilities: CHROME_METHODS, generation: port.messages[0].generation, instance: "fixture" });
  const alarm = async (name: string) => { alarms.delete(name); chrome.alarms.onAlarm.fire({ name }); await tick(); };
  return { chrome, ports, alarms, local, rpc, paired, alarm, freezeClock: (now: number) => { frozenTime = now; } };
}
test("observation refusal envelopes become safe RPC errors, not successful guards", async () => {
  const f = await fixture();
  f.paired();
  const url = "https://fixture.example/";
  Object.assign(f.chrome.tabs, {
    create: async () => ({ id: 1, windowId: 1 }), group: async () => 1,
    update: async () => ({}), get: async () => ({ id: 1, url }),
  });
  f.chrome.tabGroups.update = async () => ({});
  f.chrome.webNavigation.getAllFrames = async () => [{ frameId: 0, parentFrameId: -1, documentId: "doc", url }];
  let calls = 0, blocked: unknown = "unsupported_frame";
  f.chrome.scripting = { executeScript: async () => {
    calls++;
    if (blocked === "throw") throw new Error("PRIVATE underlying exception");
    if (blocked === null) return [{ documentId: "doc", result: { ok: true, ready: true, text: "Safe", elements: [], viewport: {}, truncated: false } }];
    return [{ documentId: "doc", result: { observationBlocked: blocked, text: "PRIVATE page text" } }];
  } };
  const port = f.ports[0];
  const call = async (method: string, params: object) => {
    const id = crypto.randomUUID();
    port.onMessage.fire({ jsonrpc: "2.0", id, instance: "fixture", generation: port.messages[0].generation, session: "s", run: "r", method, params });
    for (let i = 0; i < 100; i++) {
      const response = port.messages.find((m: any) => m.id === id);
      if (response) return response;
      await tick();
    }
    throw new Error("No fixture response");
  };
  expect((await call("begin", { name: "Fixture", protected: [] })).result).toEqual({ ok: true });
  const tab = (await call("open", { url })).result.pageId;
  for (const reason of ["unsupported_frame", "shadow_root", "secret_field", "PRIVATE", "throw"]) {
    blocked = reason;
    const before = calls;
    const response = await call("snapshot", { tab });
    expect(response.result).toBeUndefined();
    expect(response.error).toBeDefined();
    expect(JSON.stringify(response)).not.toContain("PRIVATE");
    if (["unsupported_frame", "shadow_root", "secret_field"].includes(reason)) expect(response.error.reason).toBe(reason);
    else expect(response.error.reason).toBeUndefined();
    expect(calls).toBe(before + 1); // refusal stops before any content observation/retry
    expect(port.messages.some((m: any) => m.type === "pauseState")).toBe(false);
  }
  blocked = null;
  expect((await call("snapshot", { tab })).result.text).toContain("Safe");
  // A distinct real policy event still revokes authority, with a fixed cause.
  f.chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, url: "chrome://settings/PRIVATE" });
  await tick();
  expect(port.messages.filter((m: any) => m.type === "pauseState").map((m: any) => m.reason)).toContain("navigation_denied");
  expect((await call("snapshot", { tab })).error).toBeDefined();
  expect(JSON.stringify(port.messages)).not.toContain("PRIVATE");
});

test("unobservable frame trees restrict text and exact actions to main document without inspecting hidden children", async () => {
  expect(chromeParams("snapshot", { tab: "cap", topDocumentOnly: true })).toBe(false);
  const f = await fixture();
  f.paired();
  const url = "https://fixture.example/";
  Object.assign(f.chrome.tabs, {
    create: async () => ({ id: 1, windowId: 1 }), group: async () => 1,
    update: async () => ({}), get: async () => ({ id: 1, url }),
  });
  f.chrome.tabGroups.update = async () => ({});
  // Deliberately put the child first: the guard must start at the main document.
  f.chrome.webNavigation.getAllFrames = async () => [
    { frameId: 1, parentFrameId: 0, documentId: "child", url }, { frameId: 0, parentFrameId: -1, documentId: "main", url },
  ];
  let hidden = true, nested = false, secret = false, hideDuringSnapshot = false;
  const calls: { doc: string; op: string }[] = [];
  f.chrome.scripting = { executeScript: async ({ target, args }: any) => {
    const doc = target.documentIds[0], [op, options] = args;
    calls.push({ doc, op });
    let result: any;
    if (secret) result = { observationBlocked: "secret_field" };
    else if ((hidden && doc === "main") || (nested && doc === "child")) {
      if (op === "screenshot" || !options.topDocumentOnly) result = { observationBlocked: "unsupported_frame" };
      else result = { ok: true, framesOmitted: true };
    } else result = { ok: true, framesOmitted: false };
    if (op === "snapshot" && !result.observationBlocked) {
      result = { ready: true, text: doc === "main" ? "Main inbox" : "CHILD_SENTINEL", elements: [{ ref: `${doc}-ref`, tag: "button", type: "", label: doc }], viewport: {}, truncated: false };
      if (hideDuringSnapshot) hidden = true;
    }
    return [{ documentId: doc, result }];
  } };
  const port = f.ports[0];
  const call = async (method: string, params: object) => {
    const id = crypto.randomUUID();
    port.onMessage.fire({ jsonrpc: "2.0", id, instance: "fixture", generation: port.messages[0].generation, session: "s", run: "r", method, params });
    for (let i = 0; i < 100; i++) {
      const response = port.messages.find((m: any) => m.id === id);
      if (response) return response;
      await tick();
    }
    throw new Error("No fixture response");
  };
  await call("begin", { name: "Fixture", protected: [] });
  const tab = (await call("open", { url })).result.pageId;
  const mainOnly = await call("snapshot", { tab });
  expect(mainOnly.result.framesOmitted).toBe(true);
  expect(mainOnly.result.frames.map((x: any) => x.frame)).toEqual([0]);
  expect(JSON.stringify(mainOnly)).not.toContain("CHILD_SENTINEL");
  expect(calls.every(c => c.doc === "main")).toBe(true);
  expect((await call("click", { tab, ref: "main-ref" })).result).toEqual({ ok: true, framesOmitted: true });
  expect((await call("screenshot", { tab })).error.reason).toBe("unsupported_frame");
  expect((await call("wait_for", { tab, condition: "text_absent", text: "CHILD_SENTINEL", timeoutMs: 0 })).result).toEqual({ ok: false, timedOut: true });

  hidden = false;
  const full = await call("snapshot", { tab });
  expect(full.result.frames).toHaveLength(2);
  expect(full.result.text).toContain("CHILD_SENTINEL");
  calls.length = 0;
  hidden = true;
  expect((await call("click", { tab, ref: "child-ref" })).error).toBeDefined();
  expect(calls.some(c => c.op === "click")).toBe(false);
  expect(calls.every(c => c.doc === "main")).toBe(true);

  hidden = false; nested = true;
  calls.length = 0;
  const nestedResult = await call("snapshot", { tab });
  expect(nestedResult.result.framesOmitted).toBe(true);
  expect(calls.some(c => c.doc === "child" && c.op === "snapshot")).toBe(false);

  nested = false; hideDuringSnapshot = true;
  expect((await call("snapshot", { tab })).error).toBeDefined(); // discard changing exposure
  hideDuringSnapshot = false; secret = true;
  expect((await call("snapshot", { tab })).error.reason).toBe("secret_field");
});

async function navigationFixture() {
  const f = await fixture();
  f.paired();
  const url = "https://auth.fixture.example/login";
  Object.assign(f.chrome.tabs, {
    create: async () => ({ id: 1, windowId: 1 }), group: async () => 1,
    update: async () => ({}), get: async () => ({ id: 1, url }),
  });
  f.chrome.tabGroups.update = async () => ({});
  f.chrome.webNavigation.getAllFrames = async () => [
    { frameId: 0, parentFrameId: -1, documentId: "main", url },
    { frameId: 1, parentFrameId: 0, documentId: "helper", url: "about:blank" },
  ];
  let observedEpoch: unknown;
  const injected: string[] = [];
  f.chrome.scripting = { executeScript: async ({ target, args }: any) => {
    const [op, , , epoch] = args;
    injected.push(target.documentIds[0]);
    let result: any = { ok: true, framesOmitted: true };
    if (op === "snapshot") {
      observedEpoch = epoch;
      result = { ready: true, text: "Auth fixture", elements: [{ ref: "outside-ref", tag: "button", label: "Continue" }], viewport: {}, truncated: false };
    }
    if (op === "click" && observedEpoch !== epoch) result = { observationBlocked: "stale_reference" };
    return [{ documentId: "main", result }];
  } };
  const port = f.ports[0];
  const call = async (method: string, params: object = {}) => {
    const id = crypto.randomUUID();
    port.onMessage.fire({ jsonrpc: "2.0", id, instance: "fixture", generation: port.messages[0].generation, session: "s", run: "r", method, params });
    for (let i = 0; i < 100; i++) {
      const response = port.messages.find((m: any) => m.id === id);
      if (response) return response;
      await tick();
    }
    throw new Error("No fixture response");
  };
  await call("begin", { name: "Auth fixture", protected: ["http://localhost:3100"] });
  const tab = (await call("open", { url })).result.pageId;
  f.chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, url });
  return { ...f, port, call, tab, injected };
}

test("late inherited auth child commits/history/fragments remain unobservable without pausing", async () => {
  for (const event of ["onHistoryStateUpdated", "onReferenceFragmentUpdated", "onCommitted"]) {
    for (const url of ["about:blank#PRIVATE", "about:srcdoc#PRIVATE"]) {
      const f = await navigationFixture();
      expect((await f.call("snapshot", { tab: f.tab })).result.text).toContain("Auth fixture");
      f.chrome.webNavigation[event].fire({ tabId: 1, frameId: 1, url });
      await tick();
      expect(f.port.messages.filter((m: any) => m.type === "pauseState")).toEqual([]);
      expect((await f.call("click", { tab: f.tab, ref: "outside-ref" })).error.reason).toBe("stale_reference");
      expect((await f.call("snapshot", { tab: f.tab })).result).toMatchObject({ framesOmitted: true });
      expect(f.injected.every(doc => doc === "main")).toBe(true);
      expect((await f.call("screenshot", { tab: f.tab })).error.reason).toBe("unsupported_frame");
      expect(JSON.stringify(f.port.messages)).not.toContain("PRIVATE");
    }
  }
});

test("navigation exceptions never admit main inherited documents or forbidden child destinations", async () => {
  const events = [
    ["onCommitted", "committed"], ["onHistoryStateUpdated", "history"], ["onReferenceFragmentUpdated", "fragment"],
  ];
  const destinations = [
    ["about:blank#PRIVATE", "inherited_blank", [0]],
    ["about:srcdoc#PRIVATE", "inherited_srcdoc", [0]],
    ["http://LOCALHOST.:3100/control?token=PRIVATE", "protected_origin", [0, 1]],
    ["https://user:PRIVATE@auth.fixture.example/", "credentials", [0, 1]],
    ["data:text/html,PRIVATE", "data", [0, 1]],
    ["blob:https://auth.fixture.example/PRIVATE", "blob", [0, 1]],
    ["chrome://settings/PRIVATE", "chrome_internal", [0, 1]],
    ["about:blank-not-inherited#PRIVATE", "about_other", [0, 1]],
    ["https://auth.fixture.example/?PRIVATE=" + "x".repeat(2048), "url_too_long", [0, 1]],
    ["PRIVATE invalid URL", "invalid_url", [0, 1]],
  ] as const;
  for (const [event, kind] of events) {
    for (const [url, destination, frameIds] of destinations) {
      for (const frameId of frameIds) {
        const f = await navigationFixture();
        f.chrome.webNavigation[event!].fire({ tabId: 1, frameId, url });
        await tick();
        const pauses = f.port.messages.filter((m: any) => m.type === "pauseState");
        expect(pauses.length).toBeGreaterThan(0);
        for (const pause of pauses) expect(pause).toMatchObject({
          reason: "navigation_denied",
          navigationDiagnostic: { event: kind, frame: frameId === 0 ? "main" : "child", destination },
        });
        expect((await f.call("snapshot", { tab: f.tab })).error).toBeDefined();
        expect(JSON.stringify(f.port.messages)).not.toContain("PRIVATE");
      }
    }
  }
});

test("internal diagnostic subclasses and worker revision never admit main or child documents", async () => {
  const cases = [
    ["chrome-error://chromewebdata/", "chromium_error_document"],
    ["CHROME-ERROR://chromewebdata/", "chromium_error_variant"],
    ["chrome-error://CHROMEWEBDATA/", "chromium_error_variant"],
    ["chrome-error://chromewebdata", "chromium_error_variant"],
    ["chrome-error://chromewebdata//", "chromium_error_variant"],
    ["chrome-error://chromewebdata/./", "chromium_error_variant"],
    ["chrome-error://chromewebdata/?PRIVATE", "chromium_error_variant"],
    ["chrome-error://chromewebdata/#PRIVATE", "chromium_error_variant"],
    ["chrome-error://chromewebdata.evil/PRIVATE", "chrome_error_other"],
    ["chrome-error://chromewebdata:123/PRIVATE", "chromium_error_variant"],
    [" chrome-error://chromewebdata/", "chromium_error_variant"],
    ["chrome-error://chromewebdata/\n", "chromium_error_variant"],
    ["chrome-error://user:PRIVATE@chromewebdata/", "credentials"],
    ["chrome://settings/PRIVATE", "chrome_internal"],
    ["chrome-extension://fixture/PRIVATE", "extension_self"],
    ["chrome-extension://other-fixture/PRIVATE", "extension_other"],
    ["devtools://devtools/PRIVATE", "devtools"],
    ["chrome://user:PRIVATE@settings/", "credentials"],
    ["chrome-extension://user:PRIVATE@fixture/", "credentials"],
    ["chrome-extension://user:PRIVATE@other-fixture/", "credentials"],
    ["devtools://user:PRIVATE@devtools/", "credentials"],
    ["chrome-error://[PRIVATE", "invalid_url"],
    ["chrome://[PRIVATE", "invalid_url"],
    ["chrome-extension://[PRIVATE", "invalid_url"],
    ["devtools://[PRIVATE", "invalid_url"],
    ["http://localhost:3100/PRIVATE", "protected_origin"],
  ];
  for (const [url, destination] of cases) {
    for (const frameId of [0, 1]) {
      const f = await navigationFixture();
      f.chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId, url });
      await tick();
      const pauses = f.port.messages.filter((m: any) => m.type === "pauseState");
      expect(pauses.length).toBeGreaterThan(0);
      for (const pause of pauses) expect(pause).toMatchObject({
        reason: "navigation_denied",
        navigationDiagnostic: { event: "committed", frame: frameId === 0 ? "main" : "child", destination, revision: "internal_v2" },
      });
      expect((await f.call("snapshot", { tab: f.tab })).error).toBeDefined();
      expect(f.injected).toEqual([]);
      expect(JSON.stringify(f.port.messages)).not.toContain("PRIVATE");
      expect(JSON.stringify(f.port.messages)).not.toContain("chrome-error:");
      expect(JSON.stringify(f.port.messages)).not.toContain("other-fixture");
    }
  }
});

const opaqueFixtureId = "a".repeat(32);
const jellyFixtureId = "b".repeat(32);
const opaqueFixtureURL = `chrome-extension://${opaqueFixtureId}/helper.html`;

async function opaqueFrameFixture() {
  const f = await navigationFixture();
  f.chrome.runtime.id = jellyFixtureId;
  const main = { frameId: 0, parentFrameId: -1, documentId: "main", url: "https://auth.fixture.example/login", errorOccurred: false };
  const sibling = { frameId: 1, parentFrameId: 0, documentId: "sibling", url: "https://auth.fixture.example/sibling" };
  let frames = [main, sibling];
  let secret = false, changeDuringSnapshot = false;
  const epochs = new Map<string, unknown>();
  f.chrome.webNavigation.getAllFrames = async () => frames.map(f => ({ ...f }));
  f.chrome.scripting.executeScript = async ({ target, args }: any) => {
    const doc = target.documentIds[0], [op, , , epoch] = args;
    const isMain = frames.some(frame => frame.frameId === 0 && frame.documentId === doc);
    f.injected.push(`${doc}:${op}`);
    let result: any = { ok: true, framesOmitted: false };
    if (secret && isMain) result = { observationBlocked: "secret_field" };
    else if (op === "snapshot") {
      epochs.set(doc, epoch);
      result = { ready: true, text: isMain ? "Main auth page" : "PRIVATE_CHILD_SENTINEL", elements: [{ ref: `${doc}-ref`, tag: "button", label: doc }], viewport: {}, truncated: false };
      if (changeDuringSnapshot && isMain) frames = frames.map(frame => frame.frameId === 3 ? { ...frame, documentId: "changed-descendant" } : frame);
    } else if (op === "click" && epochs.get(doc) !== epoch) result = { observationBlocked: "stale_reference" };
    return [{ documentId: doc, result }];
  };
  const opaqueTree = () => [main, sibling,
    { frameId: 2, parentFrameId: 0, documentId: "opaque", url: opaqueFixtureURL },
    { frameId: 3, parentFrameId: 2, documentId: "nested", url: "https://auth.fixture.example/nested" },
    { frameId: 4, parentFrameId: 3, documentId: "deep", url: "https://auth.fixture.example/deep" },
  ];
  return { ...f, opaqueTree,
    frames: (value: typeof frames) => { frames = value; },
    secret: () => { secret = true; },
    changeDuringSnapshot: () => { changeDuringSnapshot = true; },
  };
}

test("other-extension children are opaque across navigation events; no child or descendant is injected", async () => {
  for (const event of ["onCommitted", "onHistoryStateUpdated", "onReferenceFragmentUpdated"]) {
    const f = await opaqueFrameFixture();
    const before = (await f.call("snapshot", { tab: f.tab })).result;
    expect(before.elements.some((e: any) => e.ref === "sibling-ref")).toBe(true);
    f.frames(f.opaqueTree());
    f.chrome.webNavigation[event].fire({ tabId: 1, frameId: 2, url: opaqueFixtureURL });
    await tick();
    expect(f.port.messages.some((m: any) => m.type === "pauseState")).toBe(false);
    f.injected.length = 0;
    expect((await f.call("click", { tab: f.tab, ref: "sibling-ref" })).error).toBeDefined();
    expect(f.injected.some(doc => doc.endsWith(":click"))).toBe(false);
    const partial = (await f.call("snapshot", { tab: f.tab })).result;
    expect(partial.framesOmitted).toBe(true);
    expect(partial.frames).toHaveLength(1);
    expect(partial.elements.map((e: any) => e.ref)).toEqual(["main-ref"]);
    expect(JSON.stringify(partial)).not.toContain("PRIVATE_CHILD_SENTINEL");
    expect((await f.call("click", { tab: f.tab, ref: "main-ref" })).result.ok).toBe(true);
    expect((await f.call("wait_for", { tab: f.tab, condition: "text_absent", text: "PRIVATE_CHILD_SENTINEL", timeoutMs: 0 })).result).toEqual({ ok: false, timedOut: true });
    expect((await f.call("screenshot", { tab: f.tab })).error.reason).toBe("unsupported_frame");
    expect(f.injected.every(doc => doc.startsWith("main:"))).toBe(true);
    f.secret();
    expect((await f.call("snapshot", { tab: f.tab })).error.reason).toBe("secret_field");
  }
});

test("opaque frame exposure binds omitted document identities and parent topology, including postchecks", async () => {
  for (const change of ["document", "parent", "remove", "postcheck"]) {
    const f = await opaqueFrameFixture();
    f.frames(f.opaqueTree());
    await f.call("snapshot", { tab: f.tab });
    f.injected.length = 0;
    if (change === "postcheck") {
      f.changeDuringSnapshot();
      expect((await f.call("snapshot", { tab: f.tab })).error).toBeDefined();
    } else {
      const frames = f.opaqueTree();
      if (change === "document") frames[3]!.documentId = "new-nested";
      if (change === "parent") frames[3]!.parentFrameId = 1;
      if (change === "remove") frames.splice(2);
      f.frames(frames); // Deliberately no event: metadata changes must suffice.
      expect((await f.call("click", { tab: f.tab, ref: "main-ref" })).error).toBeDefined();
      expect(f.injected.some(doc => doc.endsWith(":click"))).toBe(false);
    }
    if (change !== "remove") expect(f.injected.every(doc => doc.startsWith("main:"))).toBe(true);
  }
});

test("missing extension ancestors, orphaned, cyclic and malformed metadata never expose child DOM", async () => {
  for (const shape of ["missing-extension", "orphan", "cycle", "duplicate", "missing-parent", "invalid-parent"]) {
    const f = await opaqueFrameFixture();
    const frames = f.opaqueTree().filter(frame => frame.frameId !== 2).map(frame => ({ ...frame }));
    if (shape !== "missing-extension") frames[2]!.parentFrameId = 1;
    if (shape === "orphan") frames[1]!.parentFrameId = 99;
    if (shape === "cycle") { frames[1]!.parentFrameId = 3; frames[2]!.parentFrameId = 1; }
    if (shape === "duplicate") frames.push({ ...frames[1]! });
    if (shape === "missing-parent") delete (frames[1] as any).parentFrameId;
    if (shape === "invalid-parent") (frames[1] as any).parentFrameId = "0";
    f.frames(frames); // No event/latch available: metadata gaps alone must suffice.
    const partial = (await f.call("snapshot", { tab: f.tab })).result;
    expect(partial.framesOmitted).toBe(true);
    expect(partial.frames).toHaveLength(1);
    expect(f.injected.every(doc => doc.startsWith("main:"))).toBe(true);
    expect((await f.call("screenshot", { tab: f.tab })).error.reason).toBe("unsupported_frame");
    // Every uncertain guard records evidence, but must not break main actions.
    expect((await f.call("click", { tab: f.tab, ref: "main-ref" })).result.ok).toBe(true);
    f.frames(f.opaqueTree().slice(0, 2)); // No commit; a complete-looking tree proves no removal.
    for (let i = 0; i < 3; i++) {
      const retained = (await f.call("snapshot", { tab: f.tab })).result;
      expect(retained.framesOmitted).toBe(true);
      expect(retained.elements.map((e: any) => e.ref)).toEqual(["main-ref"]);
      expect(JSON.stringify(retained)).not.toContain("PRIVATE_CHILD_SENTINEL");
      expect((await f.call("click", { tab: f.tab, ref: "main-ref" })).result.ok).toBe(true);
    }
    expect(f.injected.every(doc => doc.startsWith("main:"))).toBe(true);
    expect((await f.call("screenshot", { tab: f.tab })).error.reason).toBe("unsupported_frame");
    expect((await f.call("wait_for", { tab: f.tab, condition: "text_absent", text: "PRIVATE_CHILD_SENTINEL", timeoutMs: 0 })).result.ok).toBe(false);
  }
});

test("opaque event latch survives metadata absence, removal, history and open until a verified NEW main document", async () => {
  const f = await opaqueFrameFixture();
  await f.call("snapshot", { tab: f.tab });
  f.chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId: 2, url: opaqueFixtureURL });
  await tick();
  // Chrome omits the ancestor, and later removal has no reliable event. Neither
  // a complete-looking tree nor a repeat main commit can prove a new lifetime.
  for (const event of ["onCommitted", "onHistoryStateUpdated", "onReferenceFragmentUpdated"]) {
    f.chrome.webNavigation[event].fire({ tabId: 1, frameId: 0, documentId: "main", url: "https://auth.fixture.example/login" });
    await tick();
    expect((await f.call("snapshot", { tab: f.tab })).result.framesOmitted).toBe(true);
  }
  await f.call("open", { tab: f.tab, url: "https://auth.fixture.example/login" });
  expect((await f.call("snapshot", { tab: f.tab })).result.framesOmitted).toBe(true);
  const frames = f.opaqueTree().slice(0, 2);
  frames[0]!.documentId = "next-main";
  f.frames(frames);
  f.chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, documentId: "stale-main", url: frames[0]!.url });
  await tick();
  expect((await f.call("snapshot", { tab: f.tab })).result.framesOmitted).toBe(true);
  // Even an event matching current metadata cannot clear a later privacy event.
  f.chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, documentId: "next-main", url: frames[0]!.url, timeStamp: 0 });
  await tick();
  expect((await f.call("snapshot", { tab: f.tab })).result.framesOmitted).toBe(true);
  frames[0]!.documentId = "reset-main";
  (frames[0] as any).errorOccurred = true;
  f.chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, documentId: "reset-main", url: frames[0]!.url, timeStamp: Date.now() + 10000 });
  await tick();
  expect((await f.call("snapshot", { tab: f.tab })).result.framesOmitted).toBe(true);
  (frames[0] as any).errorOccurred = false;
  f.chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, documentId: "reset-main", url: frames[0]!.url, timeStamp: Date.now() + 10000 });
  await tick();
  const reset = (await f.call("snapshot", { tab: f.tab })).result;
  expect(reset.framesOmitted).toBeUndefined();
  expect(reset.frames).toHaveLength(2);
});

test("intervening events fence an asynchronous main-document verification", async () => {
  const f = await opaqueFrameFixture();
  await f.call("snapshot", { tab: f.tab });
  f.chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId: 2, url: opaqueFixtureURL });
  const frames = f.opaqueTree().slice(0, 2);
  frames[0]!.documentId = "next-main";
  f.frames(frames);
  const original = f.chrome.webNavigation.getAllFrames;
  let resolve!: (value: unknown) => void;
  f.chrome.webNavigation.getAllFrames = () => new Promise(r => { resolve = r; });
  f.chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, documentId: "next-main", url: frames[0]!.url, timeStamp: Date.now() + 10000 });
  f.chrome.webNavigation.onReferenceFragmentUpdated.fire({ tabId: 1, frameId: 0, url: frames[0]!.url });
  resolve(frames);
  f.chrome.webNavigation.getAllFrames = original;
  await tick();
  expect((await f.call("snapshot", { tab: f.tab })).result.framesOmitted).toBe(true);
});

test("unusable frame metadata also latches uncertainty after a refused observation", async () => {
  for (const shape of ["empty", "missing-main", "duplicate-main", "missing-document"]) {
    const f = await opaqueFrameFixture();
    await f.call("snapshot", { tab: f.tab });
    const clean = f.opaqueTree().slice(0, 2).map(frame => ({ ...frame }));
    const bad = clean.map(frame => ({ ...frame }));
    if (shape === "empty") bad.splice(0);
    if (shape === "missing-main") bad.shift();
    if (shape === "duplicate-main") bad.push({ ...bad[0]! });
    if (shape === "missing-document") delete (bad[0] as any).documentId;
    f.frames(bad);
    expect((await f.call("snapshot", { tab: f.tab })).error).toBeDefined();
    f.frames(clean);
    f.injected.length = 0;
    const partial = (await f.call("snapshot", { tab: f.tab })).result;
    expect(partial.framesOmitted).toBe(true);
    expect(partial.elements.map((e: any) => e.ref)).toEqual(["main-ref"]);
    expect(JSON.stringify(partial)).not.toContain("PRIVATE_CHILD_SENTINEL");
    expect(f.injected.every(doc => doc.startsWith("main:"))).toBe(true);
  }
});

test("new metadata privacy evidence fences pending verification without invalidating safe main actions", async () => {
  for (const operation of ["snapshot", "click"]) {
    for (const evidenceKind of ["opaque", "missing-parent", "unusable", "clock-skew"]) {
      const f = await opaqueFrameFixture();
      // Browser event time is current, never future. A lagging worker clock
      // makes timestamp checks insufficient: evidence ordering must fence reset.
      if (evidenceKind === "clock-skew") f.freezeClock(Date.now() - 100);
      await f.call("snapshot", { tab: f.tab });
      f.chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId: 2, url: opaqueFixtureURL, timeStamp: Date.now() - 1000 });
      await tick();
      const clean = f.opaqueTree().slice(0, 2).map(frame => ({ ...frame }));
      clean[0]!.documentId = "next-main";
      f.frames(clean);
      const original = f.chrome.webNavigation.getAllFrames;
      let resolve!: (value: unknown) => void;
      f.chrome.webNavigation.getAllFrames = () => new Promise(r => { resolve = r; });
      f.chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, documentId: "next-main", url: clean[0]!.url, timeStamp: Date.now() });
      await tick(); // A later metadata observation, with no browser event or future timestamp.
      const evidence = evidenceKind === "unusable" ? [] : f.opaqueTree()
        .filter(frame => evidenceKind !== "missing-parent" || frame.frameId !== 2)
        .map(frame => ({ ...frame, ...(frame.frameId === 0 ? { documentId: "next-main" } : {}) }));
      f.frames(evidence);
      f.chrome.webNavigation.getAllFrames = original;
      f.injected.length = 0;
      const during = await f.call(operation, { tab: f.tab, ...(operation === "click" ? { ref: "main-ref" } : {}) });
      if (operation === "click" || evidenceKind === "unusable") expect(during.error).toBeDefined();
      else expect(during.result.framesOmitted).toBe(true);
      expect(f.injected.some(doc => doc.endsWith(":click"))).toBe(false);
      resolve(clean); // This response predates the metadata evidence just observed.
      await tick();
      f.frames(clean);
      const after = (await f.call("snapshot", { tab: f.tab })).result;
      expect(after.framesOmitted).toBe(true);
      expect(after.elements.map((e: any) => e.ref)).toEqual(["next-main-ref"]);
      expect(JSON.stringify(after)).not.toContain("PRIVATE_CHILD_SENTINEL");
      // Stable repeated guards must not advance the action epoch/reference scope,
      // even though each opaque/incomplete observation advances privacy evidence.
      for (const frames of evidenceKind === "unusable" ? [clean] : [evidence, clean]) {
        f.frames(frames);
        for (let i = 0; i < 3; i++) {
          expect((await f.call("snapshot", { tab: f.tab })).result.framesOmitted).toBe(true);
          expect((await f.call("click", { tab: f.tab, ref: "next-main-ref" })).result.ok).toBe(true);
        }
      }
      expect((await f.call("screenshot", { tab: f.tab })).error.reason).toBe("unsupported_frame");
      expect((await f.call("wait_for", { tab: f.tab, condition: "text_absent", text: "PRIVATE_CHILD_SENTINEL", timeoutMs: 0 })).result.ok).toBe(false);
      expect(f.injected.every(doc => doc.startsWith("next-main:"))).toBe(true);
      // A genuinely later, clean new-document commit can still reset scope.
      await new Promise(resolve => setTimeout(resolve, 5));
      clean[0]!.documentId = "reset-main";
      f.frames(clean);
      f.chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, documentId: "reset-main", url: clean[0]!.url, timeStamp: Date.now() });
      await tick();
      const reset = (await f.call("snapshot", { tab: f.tab })).result;
      expect(reset.framesOmitted).toBeUndefined();
      expect(reset.frames).toHaveLength(2);
      expect(reset.elements.some((e: any) => e.ref === "sibling-ref")).toBe(true);
    }
  }
});

test("adopted popup starts with conservative child uncertainty without relaxing adoption authority", async () => {
  const f = await opaqueFrameFixture();
  f.chrome.webNavigation.onCreatedNavigationTarget.fire({ sourceTabId: 1, tabId: 2, url: "https://auth.fixture.example/login" });
  for (let i = 0; i < 20 && !f.port.messages.some((m: any) => m.type === "tabAdded"); i++) await tick();
  const popup = f.port.messages.find((m: any) => m.type === "tabAdded").tab;
  const partial = (await f.call("snapshot", { tab: popup })).result;
  expect(partial.framesOmitted).toBe(true);
  expect(partial.frames).toHaveLength(1);
  expect(f.injected.every(doc => doc.startsWith("main:"))).toBe(true);
  expect((await f.call("screenshot", { tab: popup })).error.reason).toBe("unsupported_frame");
  // A genuine protected popup attempt still pauses; uncertainty is not consent.
  f.chrome.webNavigation.onCreatedNavigationTarget.fire({ sourceTabId: 2, tabId: 3, url: "http://localhost:3100/PRIVATE" });
  await tick();
  expect(f.port.messages.some((m: any) => m.type === "pauseState" && m.reason === "popup_denied")).toBe(true);
});

test("opaque exclusion requires a canonical other-extension child URL; all sensitive boundaries stay denied", async () => {
  for (const suffix of ["/", "/helper.html?fixture=1#section", "/encoded%20path.html"]) {
    const f = await opaqueFrameFixture();
    f.chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId: 2, url: `chrome-extension://${opaqueFixtureId}${suffix}` });
    await tick();
    expect(f.port.messages.some((m: any) => m.type === "pauseState")).toBe(false);
  }
  const denied = [
    [0, opaqueFixtureURL], [-1, opaqueFixtureURL], [undefined, opaqueFixtureURL], ["2", opaqueFixtureURL], [1.5, opaqueFixtureURL],
    [2, `chrome-extension://${jellyFixtureId}/popup.html`],
    [2, `chrome-extension://${"a".repeat(31)}/helper.html`], [2, `chrome-extension://${"a".repeat(33)}/helper.html`],
    [2, `chrome-extension://${"q".repeat(32)}/helper.html`], [2, `chrome-extension://${opaqueFixtureId.toUpperCase()}/helper.html`],
    [2, `CHROME-EXTENSION://${opaqueFixtureId}/helper.html`],
    [2, `chrome-extension://user:PRIVATE@${opaqueFixtureId}/helper.html`], [2, `chrome-extension://${opaqueFixtureId}:123/helper.html`],
    [2, ` ${opaqueFixtureURL}`], [2, `${opaqueFixtureURL}\n`], [2, `chrome-extension://${opaqueFixtureId}/a/../helper.html`],
    [2, `chrome-extension://${opaqueFixtureId}/bad%zz`], [2, `${opaqueFixtureURL}?${"x".repeat(2048)}`],
    [2, "chrome://settings/PRIVATE"], [2, "chrome-error://chromewebdata/"], [2, "devtools://devtools/PRIVATE"],
    [3, "http://localhost:3100/PRIVATE"],
  ];
  for (const [frameId, url] of denied) {
    const f = await opaqueFrameFixture();
    f.frames(f.opaqueTree());
    f.chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId, parentFrameId: 2, url });
    await tick();
    expect(f.port.messages.some((m: any) => m.type === "pauseState")).toBe(true);
    expect((await f.call("snapshot", { tab: f.tab })).error).toBeDefined();
    expect(f.injected).toEqual([]);
    expect(JSON.stringify(f.port.messages)).not.toContain("PRIVATE");
  }
  const f = await opaqueFrameFixture();
  const frames = f.opaqueTree();
  frames[3]!.url = "http://localhost:3100/PRIVATE";
  f.frames(frames); // Even missing a denial event cannot expose a forbidden descendant.
  expect((await f.call("snapshot", { tab: f.tab })).error).toBeDefined();
  expect(f.injected).toEqual([]);
});

test("ordinary late HTTPS auth child events revoke refs without creating a security pause", async () => {
  for (const event of ["onCommitted", "onHistoryStateUpdated", "onReferenceFragmentUpdated"]) {
    const f = await navigationFixture();
    await f.call("snapshot", { tab: f.tab });
    f.chrome.webNavigation[event].fire({ tabId: 1, frameId: 1, url: "https://challenge.fixture.example/auth#PRIVATE" });
    await tick();
    expect(f.port.messages.some((m: any) => m.type === "pauseState")).toBe(false);
    expect((await f.call("click", { tab: f.tab, ref: "outside-ref" })).error.reason).toBe("stale_reference");
    expect((await f.call("snapshot", { tab: f.tab })).result.text).toContain("Auth fixture");
  }
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
test("Disconnect persists across recreation; legacy fragment/status never reconnect; grants rejected", async () => {
  const f = await fixture();
  await f.rpc("disconnect");
  expect(f.local.connectionOptOut).toBe(true);
  const next = await fixture(f.local);
  expect(next.ports).toHaveLength(0);
  expect((await next.rpc("status", "chrome-extension://fixture/popup.html#connect")).optedOut).toBe(true);
  expect(await next.rpc("grant")).toEqual({ error: "Unavailable" });
  expect(await next.rpc("status")).not.toHaveProperty("candidates");
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
test("unresolved old debugger obligations block automatic pairing and retry without restoring leases", async () => {
  const f = await fixture({ connectionOptOut: true }, { debuggerCleanupVersion: 1, debuggerCleanup: [7] });
  // Install a fresh cleanup-only obligation through the same persisted startup seam.
  f.chrome.debugger.detach = async () => { throw new Error("fixture detach failed"); };
  f.chrome.debugger.getTargets = async () => [{ tabId: 7, attached: true }];
  // Use a suspended initial read so the failure is present during reconciliation.
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const blocked = await fixture({}, { debuggerCleanupVersion: 1, debuggerCleanup: [7] }, ready);
  blocked.chrome.debugger.detach = f.chrome.debugger.detach;
  blocked.chrome.debugger.getTargets = f.chrome.debugger.getTargets;
  release(); await tick(); await tick();
  expect(blocked.ports).toHaveLength(0);
  const status = await blocked.rpc("status");
  expect(status).toMatchObject({ connectionError: "cleanup-required", unresolvedDebuggerCleanup: 1, sessions: [] });
  expect(blocked.alarms.has("jelly-connect-retry")).toBe(false);
  blocked.chrome.debugger.getTargets = async () => [];
  await blocked.rpc("connect");
  expect(blocked.ports).toHaveLength(1);
});

test("v8 automatic connection refuses v7 pairing without fallback", async () => {
  const f = await fixture();
  expect(f.ports[0].messages[0].version).toBe(8);
  f.ports[0].onMessage.fire({ type: "paired", version: 7, capabilities: CHROME_METHODS,
    generation: f.ports[0].messages[0].generation, instance: "old-server" });
  await tick();
  expect(await f.rpc("status")).toMatchObject({ connected: false, connectionError: "protocol-error", sessions: [] });
  await f.alarm("jelly-connect-retry");
  expect(f.ports[1].messages[0].version).toBe(8);
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
