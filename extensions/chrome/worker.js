// Jelly Connected Chrome worker (protocol v9): a thin CDP relay plus tab,
// lease and tab-group management. All observation/action logic lives on the
// Jelly server. Requests are handled concurrently; per-tab attach/detach and
// per-session lifecycle operations are serialised.
import {
  chromeEnvelope,
  chromeParamsError,
  CHROME_PROTOCOL,
  CHROME_METHODS,
  CHROME_MAX_FRAME,
  CHROME_CDP_TIMEOUT,
  CHROME_CDP_BATCH_TIMEOUT,
} from "../../src/shared/chrome-protocol";

let port = null,
  instance = null,
  generation = crypto.randomUUID(),
  profile = null;
let pendingPair = false, pendingReady = false;
let handshakeAlarm = null;
let connecting = null, connectionEpoch = 0, optedOut = false;
let connectionError = null, retryAttempt = 0;
let desktopFrozen = false;
let disconnecting = null;
const RETRY_ALARM = "jelly-connect-retry",
  HANDSHAKE_ALARM = "jelly-connect-handshake",
  DEADMAN_ALARM = "jelly-debugger-deadman";
const GROUP_COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const PAUSE_DRAIN_LIMIT = 15000;

const sessions = new Map(); // session id -> session
const leases = new Map(); // tab id -> session id
const attached = new Set(); // tab ids this worker attached the debugger to
// Persisted cleanup obligations: every tab we may have attached to. After a
// worker restart these are detached; they never restore a lease.
const debuggerCleanup = new Set();
const tabLocks = new Map();

const fail = (message) => {
  throw new Error(message);
};
function errorMessage(error) {
  if (typeof error === "string") return error;
  if (typeof error?.message === "string") return error.message;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

// Only bounded categories reach the popup, never native error text or host paths.
function nativeFailure(message) {
  if (message === "Specified native messaging host not found.") return "host-missing";
  if (message === "Access to the specified native messaging host is forbidden.") return "host-forbidden";
  return "host-unavailable";
}
async function scheduleRetry() {
  if (optedOut || debuggerCleanup.size) return;
  retryAttempt = Math.min(retryAttempt + 1, 5);
  await chrome.storage.local.set({ retryAttempt });
  if (!optedOut)
    await chrome.alarms.create(RETRY_ALARM, {
      delayInMinutes: Math.min(0.5 * 2 ** (retryAttempt - 1), 5),
    });
}
async function lostConnection(error) {
  connectionError = error;
  await disconnect();
  if (debuggerCleanup.size) connectionError = "cleanup-required";
  await scheduleRetry();
}
function connect(explicit = false) {
  if (connecting) return connecting;
  const epoch = connectionEpoch;
  connecting = establish(explicit, epoch)
    .catch(async () => {
      if (epoch !== connectionEpoch) return;
      connectionError = debuggerCleanup.size ? "cleanup-required" : "host-unavailable";
      await disconnect();
      await scheduleRetry();
    })
    .finally(() => {
      connecting = null;
    });
  return connecting;
}
async function automaticConnect() {
  try {
    await initialized;
    if (optedOut || port || connecting || disconnecting) return;
    const retry = await chrome.alarms.get(RETRY_ALARM);
    if (retry && retry.scheduledTime > Date.now()) return;
    await connect();
  } catch {
    connectionError = "initialization-failed";
  }
}

// ---- Debugger cleanup persistence and per-tab serialisation ----
let cleanupWrites = Promise.resolve();
function persistCleanup() {
  const ids = [...debuggerCleanup];
  const write = cleanupWrites
    .catch(() => {})
    .then(() => chrome.storage.session.set({ debuggerCleanupVersion: 2, debuggerCleanup: ids }));
  cleanupWrites = write;
  return write;
}
function withTabLock(tabId, fn) {
  const previous = tabLocks.get(tabId) ?? Promise.resolve();
  const result = previous.then(fn);
  const tail = result.catch(() => {});
  tabLocks.set(tabId, tail);
  void tail.then(() => {
    if (tabLocks.get(tabId) === tail) tabLocks.delete(tabId);
  });
  return result;
}
const notAttached = (message) => /not attached|No tab with given id|No target with given id/i.test(message);
async function releaseDebugger(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch (error) {
    if (!notAttached(errorMessage(error))) {
      const target = (await chrome.debugger.getTargets()).find((t) => t.tabId === tabId);
      if (target?.attached) throw error;
    }
  }
  attached.delete(tabId);
  if (debuggerCleanup.delete(tabId)) await persistCleanup();
}
function detachTab(tabId) {
  return withTabLock(tabId, async () => {
    if (attached.has(tabId) || debuggerCleanup.has(tabId)) await releaseDebugger(tabId);
  });
}
async function cleanupDebuggers() {
  const outcomes = await Promise.allSettled([...debuggerCleanup].map(detachTab));
  if (outcomes.some((r) => r.status === "rejected")) fail("Debugger cleanup failed.");
}
// Codex-style dead-man switch: if Jelly is not connected, no debugger of ours
// may linger (the "started debugging this browser" banner disappears).
async function deadman() {
  if (port && instance) return;
  const targets = await chrome.debugger.getTargets().catch(() => []);
  const ids = new Set([
    ...attached,
    ...debuggerCleanup,
    ...targets.filter((t) => t.attached && Number.isSafeInteger(t.tabId)).map((t) => t.tabId),
  ]);
  await Promise.allSettled(
    [...ids].map((tabId) =>
      withTabLock(tabId, () => releaseDebugger(tabId)).catch(() => {}),
    ),
  );
}

const initialized = (async () => {
  const stored = await chrome.storage.local.get(["profile", "connectionOptOut", "retryAttempt"]);
  optedOut = stored.connectionOptOut === true;
  retryAttempt = Number.isInteger(stored.retryAttempt) ? Math.max(0, Math.min(stored.retryAttempt, 5)) : 0;
  profile = stored.profile ?? crypto.randomUUID();
  await chrome.storage.local.set({ profile });
  const cleanup = await chrome.storage.session.get(["debuggerCleanup"]);
  if (Array.isArray(cleanup.debuggerCleanup))
    for (const id of cleanup.debuggerCleanup) if (Number.isSafeInteger(id) && id >= 0) debuggerCleanup.add(id);
  await persistCleanup();
  await cleanupDebuggers().catch(() => {});
  if (!(await chrome.alarms.get(DEADMAN_ALARM)))
    await chrome.alarms.create(DEADMAN_ALARM, { periodInMinutes: 0.5 });
})();

// ---- Messaging ----
function post(value) {
  if (!port) fail("Chrome extension is not connected to Jelly.");
  const json = JSON.stringify(value);
  if (json.length * 3 > CHROME_MAX_FRAME) {
    const bytes = new TextEncoder().encode(json).byteLength;
    if (bytes > CHROME_MAX_FRAME)
      fail(`Chrome message too large (${bytes} bytes; limit ${CHROME_MAX_FRAME}).`);
  }
  port.postMessage(value);
}
function notify(s, type, payload) {
  if (!port || !instance) return;
  try {
    post({ type, generation, session: s.id, run: s.run, ...payload });
  } catch {} // Oversized notifications are dropped; responses carry their own errors.
}

// ---- Sessions ----
const groupTitle = (name) => (name.startsWith("🔎") ? name : `🔎 ${name}`);
function check(s, run, allowPaused = false) {
  if (!port || !instance) fail("Chrome extension is not connected to Jelly.");
  if (!s || sessions.get(s.id) !== s) fail("Browser session is not active; call begin first.");
  if (s.run !== run) fail("Browser session run is stale; a newer run has begun.");
  if (allowPaused) return;
  if (desktopFrozen) fail("Chrome automation is frozen for a native desktop handoff.");
  if (s.idle) fail("Browser session turn has ended; call begin first.");
  if (s.paused) fail("Browser session is paused.");
}
function usable(s, run) {
  try {
    check(s, run);
    return true;
  } catch {
    return false;
  }
}
function sessionTab(s, tabId) {
  const tab = s.tabs.get(tabId);
  if (!tab || leases.get(tabId) !== s.id) fail(`Tab ${tabId} is not part of this browser session.`);
  return tab;
}
function lifecycle(s, fn) {
  const next = s.queue.then(fn);
  s.queue = next.catch(() => {});
  return next;
}
async function tracked(s, promise) {
  s.pending.add(promise);
  try {
    return await promise;
  } finally {
    s.pending.delete(promise);
  }
}
function pause(s, retain = true, reason = "requested") {
  // A pause that hands control to the human preserves their working tabs at
  // turn end. Settlement opts out explicitly; it is cleanup, not a handoff.
  if (retain)
    for (const tab of s.tabs.values()) if (tab.origin === "agent" && !tab.mark) tab.pauseRetained = true;
  s.paused = true;
  if (s.pausing) return s.pausing;
  s.pauseFailed = false;
  const run = s.run;
  const report = (state) => {
    if (port && instance && sessions.get(s.id) === s && s.run === run)
      try {
        post({ type: "pauseState", generation, session: s.id, run, state, reason: state === "failed" ? "cleanup_failed" : reason });
      } catch {}
  };
  report("pausing");
  s.pausing = (async () => {
    const release = () => Promise.allSettled([...s.tabs.keys()].map(detachTab));
    await release(); // In-flight CDP commands fail fast once detached.
    let timer;
    await Promise.race([
      Promise.allSettled([...s.pending]),
      new Promise((resolve) => (timer = setTimeout(resolve, PAUSE_DRAIN_LIMIT))),
    ]);
    clearTimeout(timer);
    const outcomes = await release(); // Catch attaches that raced the first pass.
    if (outcomes.some((r) => r.status === "rejected")) fail("Debugger cleanup failed.");
    report("paused");
  })()
    .catch((error) => {
      s.pauseFailed = true;
      report("failed");
      throw error;
    })
    .finally(() => {
      s.pausing = null;
    });
  return s.pausing;
}
function disconnect() {
  ++connectionEpoch;
  if (handshakeAlarm) void chrome.alarms.clear(handshakeAlarm);
  if (disconnecting) return disconnecting;
  const old = port;
  port = null;
  instance = null;
  pendingPair = false;
  pendingReady = false;
  for (const s of sessions.values()) s.paused = true;
  disconnecting = (async () => {
    await Promise.allSettled([...sessions.values()].map((s) => pause(s)));
    sessions.clear();
    leases.clear();
    old?.disconnect();
  })().finally(() => {
    disconnecting = null;
  });
  return disconnecting;
}
async function establish(explicit, epoch) {
  await initialized;
  await disconnecting;
  if (epoch !== connectionEpoch || port || (optedOut && !explicit)) return;
  if (explicit) {
    optedOut = false;
    await chrome.storage.local.set({ connectionOptOut: false });
  }
  if (epoch !== connectionEpoch || optedOut) return;
  connectionError = null;
  await chrome.alarms.clear(RETRY_ALARM);
  // Unresolved old debugger attachments must be released before pairing.
  await cleanupDebuggers();
  if (epoch !== connectionEpoch || optedOut) return;
  desktopFrozen = false;
  generation = crypto.randomUUID();
  const native = chrome.runtime.connectNative("org.jelly.browser");
  port = native;
  handshakeAlarm = `${HANDSHAKE_ALARM}-${generation}`;
  void chrome.alarms.create(handshakeAlarm, { delayInMinutes: 0.5 });
  if (epoch !== connectionEpoch || port !== native) {
    native.disconnect();
    return;
  }
  native.onDisconnect.addListener(() => {
    const error = nativeFailure(chrome.runtime.lastError?.message);
    if (port === native) void lostConnection(error);
  });
  native.onMessage.addListener((message) => {
    if (port !== native || epoch !== connectionEpoch) return;
    if (!message || typeof message !== "object") {
      void lostConnection("protocol-error");
      return;
    }
    if (message.type === "reconnectRequired" && message.generation === generation) {
      optedOut = true;
      connectionError = "reconnect-required";
      void chrome.storage.local.set({ connectionOptOut: true });
      void chrome.alarms.clear(RETRY_ALARM);
      void disconnect();
      return;
    }
    const compatible =
      message.version === CHROME_PROTOCOL &&
      message.generation === generation &&
      typeof message.instance === "string" &&
      Array.isArray(message.capabilities) &&
      CHROME_METHODS.every((m) => message.capabilities.includes(m));
    if (message.type === "pending" && compatible) {
      if (instance || pendingPair) {
        void lostConnection("protocol-error");
        return;
      }
      if (handshakeAlarm) void chrome.alarms.clear(handshakeAlarm);
      pendingPair = true;
      desktopFrozen = true;
      // No sessions or RPC authority while the private desktop is active.
      void cleanupDebuggers()
        .then(() => {
          if (port === native && pendingPair && !instance) {
            pendingReady = true;
            post({ type: "pendingReady", generation });
          }
        })
        .catch(() => {
          if (port === native && epoch === connectionEpoch) void lostConnection("cleanup-required");
        });
      return;
    }
    if (message.type === "paired" && compatible) {
      if (instance || (pendingPair && !pendingReady)) {
        void lostConnection("protocol-error");
        return;
      }
      if (handshakeAlarm) void chrome.alarms.clear(handshakeAlarm);
      retryAttempt = 0;
      void chrome.storage.local.set({ retryAttempt: 0 });
      connectionError = null;
      instance = message.instance;
      if (pendingPair) {
        pendingPair = false;
        desktopFrozen = false;
      }
      return;
    }
    if (!chromeEnvelope(message) || !instance || message.instance !== instance || message.generation !== generation) {
      void lostConnection("protocol-error");
      return;
    }
    preempt(message);
    void handle(native, message);
  });
  native.postMessage({
    type: "hello",
    explicitReconnect: explicit === true,
    version: CHROME_PROTOCOL,
    capabilities: CHROME_METHODS,
    profile,
    generation,
  });
}
// Revocations take effect on receipt, ahead of any queued lifecycle work.
function preempt(r) {
  if (r.method === "freeze") {
    desktopFrozen = true;
    for (const s of sessions.values()) void pause(s, true, "native_handoff").catch(() => {});
    return;
  }
  const s = sessions.get(r.session);
  if (s && s.run === r.run && (r.method === "pause" || r.method === "end"))
    void pause(s, r.method === "pause", r.method === "pause" ? "requested" : "settlement").catch(() => {});
}
async function handle(native, r) {
  let reply;
  try {
    const problem = CHROME_METHODS.includes(r.method)
      ? chromeParamsError(r.method, r.params)
      : `Unknown Chrome method "${r.method}".`;
    if (problem) fail(problem);
    const result = await dispatch(r);
    reply = { jsonrpc: "2.0", id: r.id, generation, result: result === undefined ? null : result };
  } catch (error) {
    reply = { jsonrpc: "2.0", id: r.id, generation, error: { code: -32000, message: errorMessage(error) || "Chrome request failed." } };
  }
  if (port !== native) return;
  try {
    post(reply);
  } catch (error) {
    try {
      post({ jsonrpc: "2.0", id: r.id, generation, error: { code: -32000, message: errorMessage(error) } });
    } catch {}
  }
}

// ---- Tabs ----
async function tabInfo(tab) {
  const t = await chrome.tabs.get(tab.id);
  return {
    id: tab.id,
    title: t.title ?? "",
    url: t.url || t.pendingUrl || "",
    ...(t.pendingUrl && t.pendingUrl !== t.url ? { pendingUrl: t.pendingUrl } : {}),
    windowId: t.windowId,
    active: !!t.active,
    origin: tab.origin,
    mark: tab.mark,
  };
}
function groupTab(s, tabId, windowId) {
  const work = s.grouping.then(async () => {
    let groupId = s.groups.get(windowId);
    if (groupId !== undefined) {
      try {
        await chrome.tabs.group({ groupId, tabIds: [tabId] });
        return;
      } catch {
        s.groups.delete(windowId);
      }
    }
    groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
    s.groups.set(windowId, groupId);
    await chrome.tabGroups.update(groupId, { title: s.name, color: s.color });
  });
  s.grouping = work.catch(() => {});
  return work;
}
async function preferredWindow(s) {
  for (const id of [...s.tabs.keys()].reverse()) {
    try {
      const t = await chrome.tabs.get(id);
      const w = await chrome.windows.get(t.windowId);
      if (w.type === "normal") return w.id;
    } catch {}
  }
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (w?.id !== undefined && w.type === "normal") return w.id;
  } catch {}
  const all = await chrome.windows.getAll({ windowTypes: ["normal"] });
  return all.find((w) => w.focused)?.id ?? all[0]?.id ?? null;
}
function lease(s, tabId, origin) {
  const tab = { id: tabId, origin, mark: null, pauseRetained: false };
  leases.set(tabId, s.id);
  s.tabs.set(tabId, tab);
  return tab;
}
function unlease(s, tabId) {
  s.tabs.delete(tabId);
  if (leases.get(tabId) === s.id) leases.delete(tabId);
}
async function createTab(s, run, url) {
  check(s, run);
  const windowId = await preferredWindow(s);
  check(s, run);
  let created;
  if (windowId === null) {
    // Never steal focus: the new window opens unfocused.
    const win = await chrome.windows.create({ focused: false, type: "normal", url: "about:blank" });
    created = win.tabs?.[0] ?? (await chrome.tabs.query({ windowId: win.id }))[0];
  } else created = await chrome.tabs.create({ active: false, url: "about:blank", windowId });
  if (created?.id === undefined) fail("Chrome did not return the created tab.");
  const tab = lease(s, created.id, "agent");
  try {
    check(s, run);
    await groupTab(s, tab.id, created.windowId);
    check(s, run);
    if (url) await chrome.tabs.update(tab.id, { url });
    check(s, run);
    return { tab: await tabInfo(tab) };
  } catch (error) {
    unlease(s, tab.id);
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw error;
  }
}
async function claimTab(s, run, tabId) {
  check(s, run);
  const owner = leases.get(tabId);
  if (owner === s.id) return { tab: await tabInfo(sessionTab(s, tabId)) };
  if (owner !== undefined) fail(`Tab ${tabId} is part of another browser session.`);
  await chrome.tabs.get(tabId);
  check(s, run);
  if (leases.has(tabId)) fail(`Tab ${tabId} is part of another browser session.`);
  // User tabs are leased in place: never moved into the agent group.
  return { tab: await tabInfo(lease(s, tabId, "user")) };
}
async function closeTab(s, tabId) {
  sessionTab(s, tabId);
  await detachTab(tabId).catch(() => {});
  unlease(s, tabId);
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    if (!/No tab with id/i.test(errorMessage(error))) throw error;
  }
  return { ok: true };
}
async function userTabs(s) {
  const all = await chrome.tabs.query({ windowType: "normal" });
  return {
    tabs: all
      .filter((t) => t.id !== undefined && (!leases.has(t.id) || leases.get(t.id) === s.id))
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
      .map((t) => ({
        id: t.id,
        title: t.title ?? "",
        url: t.url || t.pendingUrl || "",
        windowId: t.windowId,
        active: !!t.active,
        lastAccessed: t.lastAccessed ?? null,
        groupId: t.groupId ?? -1,
        pinned: !!t.pinned,
      })),
  };
}

// ---- Debugger relay ----
function attachTab(s, run, tabId) {
  return withTabLock(tabId, async () => {
    check(s, run);
    sessionTab(s, tabId);
    if (attached.has(tabId)) return;
    const ours = debuggerCleanup.has(tabId);
    if (!ours) {
      // Persist before attaching: worker loss at any later point leaves a
      // cleanup obligation, including an indeterminate attach result.
      debuggerCleanup.add(tabId);
      await persistCleanup();
    }
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (error) {
      // Our own earlier attachment (e.g. a lost onDetach) is still usable.
      if (!(ours && /Another debugger/i.test(errorMessage(error)))) {
        if (!ours && debuggerCleanup.delete(tabId)) await persistCleanup().catch(() => {});
        throw error;
      }
    }
    attached.add(tabId);
    if (!usable(s, run) || leases.get(tabId) !== s.id) {
      await releaseDebugger(tabId).catch(() => {});
      check(s, run);
      sessionTab(s, tabId);
    }
  });
}
async function withTimeout(promise, ms, message, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(message()));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function cdpSend(s, run, tabId, sessionId, method, params) {
  sessionTab(s, tabId);
  if (!attached.has(tabId)) await attachTab(s, run, tabId);
  const target = sessionId ? { tabId, sessionId } : { tabId };
  try {
    return await chrome.debugger.sendCommand(target, method, params ?? {});
  } catch (error) {
    // A detach we did not observe yet: re-attach once (top-level session only).
    if (sessionId || !/not attached/i.test(errorMessage(error)) || !usable(s, run) || leases.get(tabId) !== s.id)
      throw error;
    attached.delete(tabId);
    await attachTab(s, run, tabId);
    return await chrome.debugger.sendCommand(target, method, params ?? {});
  }
}
async function cdp(s, run, p) {
  const ms = p.timeoutMs ?? CHROME_CDP_TIMEOUT;
  const result = await withTimeout(
    cdpSend(s, run, p.tabId, p.sessionId, p.method, p.params),
    ms,
    () => `Timed out running CDP command "${p.method}" after ${ms}ms.`,
  );
  return result === undefined ? null : result;
}
async function cdpBatch(s, run, p) {
  const ms = p.timeoutMs ?? CHROME_CDP_BATCH_TIMEOUT;
  let index = 0,
    cancelled = false;
  const results = [];
  const work = (async () => {
    for (; index < p.commands.length && !cancelled; index++) {
      const command = p.commands[index];
      try {
        const result = await cdpSend(s, run, p.tabId, p.sessionId, command.method, command.params);
        results.push(result === undefined ? null : result);
      } catch (error) {
        fail(`Command ${index} "${command.method}" failed: ${errorMessage(error)}`);
      }
    }
    return { results };
  })();
  return withTimeout(
    work,
    ms,
    () => `Timed out running CDP batch at command ${index} "${p.commands[index]?.method}" after ${ms}ms.`,
    () => {
      cancelled = true;
    },
  );
}
async function passthrough(p) {
  const api = chrome[p.namespace];
  const fn = api?.[p.method];
  if (typeof fn !== "function") fail(`chrome.${p.namespace}.${p.method} is not available.`);
  const result = await fn.apply(api, p.args);
  return result === undefined ? null : result;
}

// ---- Dispatch ----
function begin(r) {
  const p = r.params;
  let s = sessions.get(r.session);
  if (!s) {
    s = {
      id: r.session,
      run: r.run,
      name: groupTitle(p.name),
      color: GROUP_COLORS[Array.from(p.agent ?? r.session).reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0) % GROUP_COLORS.length],
      paused: false,
      pausing: null,
      pauseFailed: false,
      idle: false,
      tabs: new Map(),
      groups: new Map(),
      queue: Promise.resolve(),
      grouping: Promise.resolve(),
      pending: new Set(),
    };
    sessions.set(s.id, s);
    return { ok: true, tabs: [], paused: false };
  }
  return lifecycle(s, async () => {
    await s.pausing?.catch(() => {});
    if (sessions.get(s.id) !== s) fail("Browser session was cleared; call begin again.");
    if (s.pauseFailed) fail("Debugger cleanup failed for this browser session; end it before beginning again.");
    s.run = r.run;
    s.idle = false;
    // Marks are turn-scoped. Re-lease retained handoff tabs that still exist.
    for (const tab of [...s.tabs.values()]) {
      tab.mark = null;
      try {
        await chrome.tabs.get(tab.id);
      } catch {
        unlease(s, tab.id);
      }
    }
    return { ok: true, tabs: [...s.tabs.keys()], paused: s.paused };
  });
}
async function end(s, run, p) {
  check(s, run, true);
  await pause(s, false, "settlement");
  s.idle = true;
  const retained = [];
  const ours = new Set(s.groups.values());
  for (const tab of [...s.tabs.values()]) {
    const kind =
      tab.mark === "handoff" || tab.pauseRetained
        ? p.discard ? "release" : "handoff"
        : tab.mark === "deliverable" ? "deliverable"
        : tab.origin === "agent" ? "close" : "release";
    if (kind === "handoff") {
      tab.mark = null;
      tab.pauseRetained = false;
      retained.push(tab.id);
      continue;
    }
    unlease(s, tab.id);
    if (kind === "close") await chrome.tabs.remove(tab.id).catch(() => {});
    if (kind === "deliverable") {
      const info = await chrome.tabs.get(tab.id).catch(() => null);
      if (info && ours.has(info.groupId)) await chrome.tabs.ungroup(tab.id).catch(() => {});
    }
  }
  s.paused = false;
  if (!s.tabs.size) sessions.delete(s.id);
  return { ok: true, retained };
}
async function dispatch(r) {
  const p = r.params;
  if (r.method === "freeze") {
    desktopFrozen = true;
    await Promise.allSettled([...sessions.values()].map((s) => pause(s, true, "native_handoff")));
    await cleanupDebuggers();
    return { frozen: true };
  }
  if (r.method === "unfreeze") {
    // Only lifts the instance latch; individual sessions stay paused.
    desktopFrozen = false;
    return { ok: true };
  }
  if (desktopFrozen && !["pause", "end", "listTabs", "showTab"].includes(r.method))
    fail("Chrome automation is frozen for a native desktop handoff.");
  if (r.method === "begin") return begin(r);
  const s = sessions.get(r.session);
  if (r.method === "end") {
    if (!s) return { ok: true, retained: [] };
    return lifecycle(s, () => end(s, r.run, p));
  }
  if (r.method === "pause") {
    if (!s) return { ok: true };
    check(s, r.run, true);
    return lifecycle(s, async () => {
      await pause(s, true, "requested");
      return { ok: true };
    });
  }
  check(s, r.run, ["resume", "listTabs", "showTab", "markTab"].includes(r.method));
  switch (r.method) {
    case "resume":
      return lifecycle(s, async () => {
        await s.pausing?.catch(() => {});
        check(s, r.run, true);
        if (desktopFrozen) fail("Chrome automation is frozen for a native desktop handoff.");
        if (s.idle) fail("Browser session turn has ended; call begin first.");
        if (s.pauseFailed) fail("Debugger cleanup failed for this browser session; it cannot resume.");
        for (const tab of s.tabs.values()) tab.pauseRetained = false;
        s.paused = false;
        return { ok: true };
      });
    case "name":
      return lifecycle(s, async () => {
        s.name = groupTitle(p.name);
        for (const [windowId, groupId] of s.groups)
          await chrome.tabGroups.update(groupId, { title: s.name, color: s.color }).catch(() => s.groups.delete(windowId));
        return { ok: true };
      });
    case "createTab":
      return lifecycle(s, () => createTab(s, r.run, p.url));
    case "claimTab":
      return lifecycle(s, () => claimTab(s, r.run, p.tabId));
    case "markTab":
      sessionTab(s, p.tabId).mark = p.mark;
      return { ok: true };
  }
  return tracked(
    s,
    (async () => {
      switch (r.method) {
        case "closeTab":
          return closeTab(s, p.tabId);
        case "listTabs": {
          const tabs = await Promise.allSettled([...s.tabs.values()].map(tabInfo));
          return { tabs: tabs.filter((t) => t.status === "fulfilled").map((t) => t.value) };
        }
        case "userTabs":
          return userTabs(s);
        case "showTab": {
          sessionTab(s, p.tabId);
          const t = await chrome.tabs.update(p.tabId, { active: true });
          await chrome.windows.update(t.windowId, { focused: true });
          return { ok: true };
        }
        case "attach":
          await attachTab(s, r.run, p.tabId);
          return { ok: true };
        case "detach":
          sessionTab(s, p.tabId);
          await detachTab(p.tabId);
          return { ok: true };
        case "cdp":
          return cdp(s, r.run, p);
        case "cdpBatch":
          return cdpBatch(s, r.run, p);
        case "chrome":
          return passthrough(p);
      }
      fail(`Unsupported Chrome method "${r.method}".`);
    })(),
  );
}

// ---- Browser events ----
chrome.debugger.onEvent.addListener((source, method, params) => {
  const s = sessions.get(leases.get(source.tabId));
  if (!s) return;
  notify(s, "cdpEvent", {
    tabId: source.tabId,
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    method,
    params: params ?? {},
  });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (!Number.isSafeInteger(source.tabId)) return;
  attached.delete(source.tabId);
  if (debuggerCleanup.delete(source.tabId)) void persistCleanup().catch(() => {});
  // The session is NOT paused; the engine re-attaches lazily on its next call.
  const s = sessions.get(leases.get(source.tabId));
  if (s) notify(s, "cdpDetach", { tabId: source.tabId, reason: String(reason ?? "unknown") });
});
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  // Popups / target=_blank from a leased tab join the session as agent tabs.
  const s = sessions.get(leases.get(details.sourceTabId));
  if (!s || leases.has(details.tabId) || !usable(s, s.run)) return;
  const tab = lease(s, details.tabId, "agent");
  void (async () => {
    try {
      const t = await chrome.tabs.get(tab.id);
      await groupTab(s, tab.id, t.windowId);
    } catch {} // Popup windows cannot be grouped; the lease still applies.
    if (s.tabs.get(tab.id) !== tab) return;
    try {
      notify(s, "tabAdded", { tab: await tabInfo(tab) });
    } catch {}
  })();
});
chrome.tabGroups.onRemoved.addListener((group) => {
  for (const s of sessions.values())
    for (const [windowId, groupId] of s.groups) if (groupId === group.id) s.groups.delete(windowId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  const wasAttached = attached.delete(tabId);
  if (debuggerCleanup.delete(tabId)) void persistCleanup().catch(() => {});
  const s = sessions.get(leases.get(tabId));
  if (!s) return;
  unlease(s, tabId);
  // Chrome may report the removal before debugger.onDetach; the lease is gone
  // by then, so report the detach here.
  if (wasAttached) notify(s, "cdpDetach", { tabId, reason: "target_closed" });
  notify(s, "tabRemoved", { tabId });
  if (s.idle && !s.tabs.size) sessions.delete(s.id);
});
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  // Prerender/instant swaps: the lease follows the visible tab.
  attached.delete(removedTabId);
  if (debuggerCleanup.delete(removedTabId)) void persistCleanup().catch(() => {});
  const s = sessions.get(leases.get(removedTabId));
  if (!s) return;
  const old = s.tabs.get(removedTabId);
  unlease(s, removedTabId);
  notify(s, "tabRemoved", { tabId: removedTabId });
  if (!old || leases.has(addedTabId)) return;
  const tab = lease(s, addedTabId, old.origin);
  tab.mark = old.mark;
  tab.pauseRetained = old.pauseRetained;
  void tabInfo(tab)
    .then((info) => notify(s, "tabAdded", { tab: info }))
    .catch(() => {});
});

// Only packaged popup pages may issue local controls. No content-script RPC.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    ![chrome.runtime.getURL("popup.html"), chrome.runtime.getURL("popup.html") + "#connect"].includes(sender.url)
  )
    return;
  void (async () => {
    await initialized;
    if (message.action === "connect") await connect(true);
    else if (message.action === "disconnect") {
      optedOut = true;
      connectionError = null;
      const cleanup = disconnect();
      await chrome.storage.local.set({ connectionOptOut: true });
      await chrome.alarms.clear(RETRY_ALARM);
      await cleanup;
    } else if (message.action !== "status") fail("Unsupported popup action.");
    return {
      profile,
      instance,
      connected: !!instance,
      pending: pendingPair,
      unresolvedDebuggerCleanup: [...debuggerCleanup].filter((id) => !leases.has(id)).length,
      connecting: !!connecting || (!!port && !instance && !pendingPair),
      optedOut,
      connectionError,
      sessions: [...sessions.values()].map((s) => ({
        id: s.id,
        name: s.name,
        paused: s.paused && !s.pausing && !s.pauseFailed,
        pausing: !!s.pausing,
        failed: !!s.pauseFailed,
        idle: s.idle,
        tabs: s.tabs.size,
      })),
    };
  })().then(respond, () => respond({ error: "Unavailable" }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) void automaticConnect();
  else if (alarm.name === DEADMAN_ALARM) void deadman();
  else if (alarm.name === handshakeAlarm && port && !instance && !pendingPair) void lostConnection("handshake-timeout");
});
chrome.runtime.onStartup.addListener(() => void automaticConnect());
chrome.runtime.onInstalled.addListener(() => void automaticConnect());
// Module evaluation also covers extension reload and MV3 worker recreation.
void automaticConnect();
