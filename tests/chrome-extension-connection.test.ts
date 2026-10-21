import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { CHROME_PROTOCOL, CHROME_METHODS } from "../src/shared/chrome-protocol";
const built = await Bun.build({ entrypoints: ["extensions/chrome/worker.js"], target: "browser", format: "iife" });
const source = await built.outputs[0]!.text();
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
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
  runInNewContext(source, { chrome, crypto, TextEncoder, URL, setTimeout, clearTimeout, console });
  await tick();
  const rpc = (action: string, sender = "chrome-extension://fixture/popup.html") => new Promise<any>(resolve => chrome.runtime.onMessage.fire({ action, session: "anything", tab: 1 }, { id: "fixture", url: sender }, resolve));
  const paired = (port = ports.at(-1), type = "paired") => port.onMessage.fire({ type, version: CHROME_PROTOCOL, capabilities: CHROME_METHODS, generation: port.messages[0].generation, instance: "fixture" });
  const alarm = async (name: string) => { alarms.delete(name); chrome.alarms.onAlarm.fire({ name }); await tick(); };
  return { chrome, ports, alarms, local, rpc, paired, alarm };
}
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

test("v7 automatic connection refuses v6 pairing without fallback", async () => {
  const f = await fixture();
  expect(f.ports[0].messages[0].version).toBe(7);
  f.ports[0].onMessage.fire({ type: "paired", version: 6, capabilities: CHROME_METHODS,
    generation: f.ports[0].messages[0].generation, instance: "old-server" });
  await tick();
  expect(await f.rpc("status")).toMatchObject({ connected: false, connectionError: "protocol-error", sessions: [] });
  await f.alarm("jelly-connect-retry");
  expect(f.ports[1].messages[0].version).toBe(7);
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
