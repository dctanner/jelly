import {
  chromeRequest,
  chromeOrigin,
  chromeWebEndpoint,
  CHROME_PROTOCOL,
  CHROME_METHODS,
  CHROME_MAX_FRAME,
} from "../../src/shared/chrome-protocol";
import { observation } from "./observation";
import { chromeFailureReason, ChromeObservationError, chromeNavigationDiagnostic, CHROME_NAVIGATION_DIAGNOSTIC_REVISION } from "../../src/shared/chrome-errors";
import {
  chromeInternetDenyRegexes,
} from "../../src/shared/chrome-policy";
let port = null,
  instance = null,
  generation = crypto.randomUUID(),
  profile = null;
let pendingPair = false, pendingReady = false;
let handshakeAlarm = null;
let connecting = null, connectionEpoch = 0, optedOut = false;
let connectionError = null, retryAttempt = 0;
const RETRY_ALARM = "jelly-connect-retry", HANDSHAKE_ALARM = "jelly-connect-handshake";
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
  if (!optedOut) await chrome.alarms.create(RETRY_ALARM, {
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
  connecting = establish(explicit, epoch).catch(async () => {
    if (epoch !== connectionEpoch) return;
    connectionError = debuggerCleanup.size ? "cleanup-required" : "host-unavailable";
    await disconnect();
    await scheduleRetry();
  }).finally(() => { connecting = null; });
  return connecting;
}
async function automaticConnect() {
  try {
    await initialized;
    if (optedOut || port || connecting || disconnecting) return;
    const retry = await chrome.alarms.get(RETRY_ALARM);
    if (retry && retry.scheduledTime > Date.now()) return;
    await connect();
  } catch { connectionError = "initialization-failed"; }
}
const sessions = new Map(),
  leases = new Map();
// Cleanup obligations are not leases. These numeric IDs may only detach or
// block access, never restore tab authority after disconnect/worker recreation.
const debuggerCleanup = new Set(),
  confirmedDetached = new Set();
let cleanupWrites = Promise.resolve();
function persistCleanup() {
  const ids = [...debuggerCleanup];
  const write = cleanupWrites
    .catch(() => {})
    .then(() =>
      chrome.storage.session.set({
        debuggerCleanupVersion: 1,
        debuggerCleanup: ids,
      }),
    );
  cleanupWrites = write;
  return write;
}
async function releaseDebugger(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch (error) {
    if (!confirmedDetached.has(tabId)) {
      const target = (await chrome.debugger.getTargets()).find(
        (t) => t.tabId === tabId,
      );
      // Another debugger also makes this conservative: a generic rejection
      // alone is never accepted as proof that our old attachment is gone.
      if (target?.attached) throw error;
    }
  }
  debuggerCleanup.delete(tabId);
  confirmedDetached.delete(tabId);
  await persistCleanup();
}
async function cleanupDebuggers() {
  const outcomes = await Promise.allSettled(
    [...debuggerCleanup].map(releaseDebugger),
  );
  if (outcomes.some((r) => r.status === "rejected")) unavailable();
}
let queue = Promise.resolve(),
  queued = 0,
  ruleId = 1000;
const messageBytes = (value) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const unavailable = () => {
  throw new Error("Unavailable or revoked");
};
const initialized = (async () => {
  const stored = await chrome.storage.local.get(["profile", "connectionOptOut", "retryAttempt"]);
  optedOut = stored.connectionOptOut === true;
  retryAttempt = Number.isInteger(stored.retryAttempt) ? Math.max(0, Math.min(stored.retryAttempt, 5)) : 0;
  profile = stored.profile ?? crypto.randomUUID();
  await chrome.storage.local.set({ profile });
  const cleanup = await chrome.storage.session.get([
    "debuggerCleanupVersion",
    "debuggerCleanup",
  ]);
  if (
    cleanup.debuggerCleanup !== undefined &&
    (!Array.isArray(cleanup.debuggerCleanup) ||
      cleanup.debuggerCleanup.length > 256 ||
      !cleanup.debuggerCleanup.every(
        (id) => Number.isSafeInteger(id) && id >= 0,
      ))
  )
    unavailable();
  for (const id of cleanup.debuggerCleanup ?? []) debuggerCleanup.add(id);
  // Rules belong only to this extension. Startup reconciles cleanup, never
  // authority: detach our old debugger sessions and lift stale restrictions.
  // Numeric IDs are used only to release, never to grant access or close tabs.
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  // Older extension builds did not persist attachments. Quarantine their rule
  // targets rather than assuming an empty new lease means they are detached.
  if (cleanup.debuggerCleanupVersion !== 1)
    for (const tabId of rules.flatMap((r) => r.condition.tabIds ?? []))
      debuggerCleanup.add(tabId);
  await persistCleanup();
  await cleanupDebuggers().catch(() => {});
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: rules.map((r) => r.id),
  });
})();
function post(value) {
  if (port && messageBytes(value) <= CHROME_MAX_FRAME) port.postMessage(value);
  else unavailable();
}
function tabEvent(type, s, tab) {
  if (port && instance)
    post({ type, generation, session: s.id, run: s.run, tab: tab.cap });
}
let desktopFrozen = false;
function current(s, run, allowPaused = false) {
  if (
    !port ||
    !instance ||
    sessions.get(s.id) !== s ||
    s.run !== run ||
    (!allowPaused && (desktopFrozen || s.paused || s.idle))
  )
    unavailable();
}
function owned(s, cap) {
  const tab = s.tabs.get(cap);
  if (!tab || leases.get(tab.id) !== s.id) unavailable();
  return tab;
}
function pause(s, retain = true, reason = "requested", diagnostic) {
  // Any pause that hands control to the human preserves their working tabs.
  // Run settlement opts out explicitly; it is cleanup, not a private handoff.
  if (retain)
    for (const tab of s.tabs.values())
      if (tab.origin === "agent" && tab.mark === "temporary")
        tab.pauseRetained = true;
  if (s.pausing) return s.pausing;
  s.paused = true;
  s.pauseFailed = false;
  s.epoch = crypto.randomUUID();
  const run = s.run;
  const report = (state) => {
    if (port && instance && sessions.get(s.id) === s && s.run === run)
      post({ type: "pauseState", generation, session: s.id, run, state, reason: state === "failed" ? "cleanup_failed" : reason,
        ...(reason === "navigation_denied" && state !== "failed" && chromeNavigationDiagnostic(diagnostic)
          ? { navigationDiagnostic: chromeNavigationDiagnostic(diagnostic) } : {}),
      });
  };
  report("pausing");
  s.pausing = (async () => {
    await Promise.allSettled([...s.pending]);
    const detached = await Promise.allSettled(
      [...s.tabs.values()].map(pauseTab),
    );
    if (detached.some((result) => result.status === "rejected")) unavailable();
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
function localPause(s, retain = true, reason = "requested", diagnostic) {
  // Local revocation is immediate; errors are exposed as failed, never paused.
  void pause(s, retain, reason, diagnostic).catch(() => {});
}
let disconnecting = null;
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
    const rules = [...sessions.values()].flatMap((s) =>
      [...s.tabs.values()].flatMap((t) => t.rules),
    );
    await chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: rules })
      .catch(() => {});
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
  // Reconnect never forgives an unresolved detach. Explicit retry may clean it
  // up, but no profile pairs or tab can be re-granted until that is confirmed.
  await cleanupDebuggers();
  if (epoch !== connectionEpoch || optedOut) return;
  desktopFrozen = false;
  generation = crypto.randomUUID();
  const native = chrome.runtime.connectNative("org.jelly.browser");
  port = native;
  handshakeAlarm = `${HANDSHAKE_ALARM}-${generation}`;
  void chrome.alarms.create(handshakeAlarm, { delayInMinutes: 0.5 });
  if (epoch !== connectionEpoch || port !== native) { native.disconnect(); return; }
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
    if (message.type === "pending" && message.version === CHROME_PROTOCOL &&
        message.generation === generation && typeof message.instance === "string" &&
        Array.isArray(message.capabilities) && CHROME_METHODS.every(m => message.capabilities.includes(m))) {
      if (instance || pendingPair) { void lostConnection("protocol-error"); return; }
      if (handshakeAlarm) void chrome.alarms.clear(handshakeAlarm);
      pendingPair = true;
      desktopFrozen = true;
      // Connect already reconciled debugger obligations. No instance, sessions,
      // lease or RPC authority is granted while the private desktop is active.
      void cleanupDebuggers().then(() => {
        if (port === native && pendingPair && !instance) {
          pendingReady = true;
          post({ type: "pendingReady", generation });
        }
      }).catch(() => {
        if (port === native && epoch === connectionEpoch)
          void lostConnection("cleanup-required");
      });
      return;
    }
    if (
      message.type === "paired" &&
      message.version === CHROME_PROTOCOL &&
      Array.isArray(message.capabilities) &&
      CHROME_METHODS.every((m) => message.capabilities.includes(m)) &&
      message.generation === generation &&
      typeof message.instance === "string"
    ) {
      if (instance || (pendingPair && !pendingReady)) { void lostConnection("protocol-error"); return; }
      if (handshakeAlarm) void chrome.alarms.clear(handshakeAlarm);
      retryAttempt = 0;
      void chrome.storage.local.set({ retryAttempt: 0 });
      connectionError = null;
      instance = message.instance;
      if (pendingPair) { pendingPair = false; desktopFrozen = false; }
      return;
    }
    if (
      !chromeRequest(message) ||
      message.instance !== instance ||
      message.generation !== generation ||
      messageBytes(message) > CHROME_MAX_FRAME ||
      queued >= 32
    ) {
      void lostConnection("protocol-error");
      return;
    }
    if (message.method === "freeze") {
      desktopFrozen = true; // Preempt queued begins/resumes and revoke in-flight results.
      for (const s of sessions.values()) localPause(s, true, "native_handoff");
    }
    const urgent = sessions.get(message.session);
    if (
      ["pause", "end"].includes(message.method) &&
      urgent?.run === message.run
    )
      localPause(urgent, message.method === "pause", message.method === "pause" ? "requested" : "settlement");
    queued++;
    queue = queue
      .catch(() => {})
      .then(async () => {
        if (port !== native) return;
        try {
          const result = await dispatch(message);
          if (["snapshot", "screenshot", "wait_for"].includes(message.method))
            current(sessions.get(message.session), message.run);
          if (port === native)
            post({ jsonrpc: "2.0", id: message.id, generation, result });
        } catch (error) {
          if (port === native)
            post({
              jsonrpc: "2.0",
              id: message.id,
              generation,
              error: {
                code: -32000,
                message: "Unavailable or revoked",
                ...(error instanceof ChromeObservationError ? { reason: error.reason } : {}),
              },
            });
        }
      })
      .finally(() => {
        queued--;
      });
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
async function protect(tabId, s) {
  const regexes = chromeInternetDenyRegexes(s.protected);
  if (regexes.length > 500) unavailable();
  const ids = regexes.map(() => ruleId++);
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: regexes.map((regexFilter, i) => ({
      id: ids[i],
      priority: 1,
      action: { type: "block" },
      condition: {
        tabIds: [tabId],
        regexFilter,
        isUrlFilterCaseSensitive: false,
        resourceTypes: [
          "main_frame",
          "sub_frame",
          "stylesheet",
          "script",
          "image",
          "font",
          "object",
          "xmlhttprequest",
          "ping",
          "csp_report",
          "media",
          "websocket",
          "webtransport",
          "other",
        ],
      },
    })),
  });
  return ids;
}
async function create(s, run, url) {
  checkURL(s, url);
  if (s.tabs.size >= 12) unavailable();
  const created = await chrome.tabs.create({
    url: "about:blank",
    active: false,
  });
  const tab = {
    id: created.id,
    cap: crypto.randomUUID(),
    initializing: true,
    opaqueChildren: false,
    opaqueSince: 0,
    privacyEvidenceGeneration: 0,
    mainDocumentId: null,
    attached: false,
    document: null,
    mark: "temporary",
    origin: "agent",
    refs: new Map(),
    rules: [],
  };
  try {
    current(s, run);
    if (debuggerCleanup.has(tab.id)) unavailable();
    tab.rules = await protect(tab.id, s);
    current(s, run);
    if (s.tabs.size >= 12) unavailable();
    leases.set(tab.id, s.id);
    s.tabs.set(tab.cap, tab);
    const group = await chrome.tabs.group({
      tabIds: tab.id,
      ...(s.groups.has(created.windowId)
        ? { groupId: s.groups.get(created.windowId) }
        : {}),
    });
    current(s, run);
    s.groups.set(created.windowId, group);
    await chrome.tabGroups.update(group, { title: s.name, color: s.color });
    current(s, run);
    await tracked(s, chrome.tabs.update(tab.id, { url }));
    current(s, run);
    return tab;
  } catch (e) {
    leases.delete(tab.id);
    s.tabs.delete(tab.cap);
    await chrome.tabs.remove(tab.id).catch(() => {});
    await chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: tab.rules })
      .catch(() => {});
    throw e;
  }
}
// Inherited documents are never separately observed. Rendered inherited frames
// force main-document-only text observations and still block screenshots.
function inheritedFrame(frameId, url) {
  return Number.isInteger(frameId) && frameId > 0 && /^about:(blank|srcdoc)(?:[?#]|$)/.test(String(url));
}
// A different extension's canonical child URL identifies an opaque document,
// not browser authority. Never inspect it or any child document when present.
function opaqueExtensionFrame(frameId, value) {
  if (!Number.isInteger(frameId) || frameId <= 0 || typeof value !== "string" || value.length > 2048)
    return false;
  const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(value);
  if (!match || match[1] === chrome.runtime.id || /%(?![a-fA-F0-9]{2})/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "chrome-extension:" && url.hostname === match[1] &&
      !url.username && !url.password && !url.port && url.href === value;
  } catch { return false; }
}
function checkURL(s, url) {
  chromeOrigin(
    url,
    s.protected,
  );
  if (
    typeof url !== "string" ||
    url.length > 4096
  )
    unavailable();
}
// Called only after policy rejected an event. Classification is diagnostic,
// never an admission decision; no URL components leave this function.
function navigationDestination(s, value) {
  if (typeof value !== "string") return "invalid_url";
  if (value.length > 2048) return "url_too_long";
  // Diagnostic only: do not normalize near-matches or admit this document.
  // In particular, a child frame with this exact URL is still denied.
  if (value === "chrome-error://chromewebdata/") return "chromium_error_document";
  let url;
  try { url = new URL(value); } catch { return "invalid_url"; }
  if (url.username || url.password) return "credentials";
  if (url.protocol === "about:") {
    if (url.pathname === "blank") return "inherited_blank";
    if (url.pathname === "srcdoc") return "inherited_srcdoc";
    return "about_other";
  }
  if (["data:", "blob:", "file:"].includes(url.protocol)) return url.protocol.slice(0, -1);
  // Subclasses expose neither URL components nor extension IDs. A same-host
  // error variant is NOT a canonical document and grants no exception.
  if (url.protocol === "chrome-error:")
    return url.hostname.toLowerCase() === "chromewebdata" ? "chromium_error_variant" : "chrome_error_other";
  if (url.protocol === "chrome:") return "chrome_internal";
  if (url.protocol === "chrome-extension:")
    return url.hostname === chrome.runtime.id ? "extension_self" : "extension_other";
  if (url.protocol === "devtools:") return "devtools";
  if (!["http:", "https:"].includes(url.protocol)) return "other_nonweb";
  try {
    const origin = chromeWebEndpoint(value);
    if (s.protected.some(protectedOrigin => chromeWebEndpoint(protectedOrigin) === origin))
      return "protected_origin";
  } catch { return "invalid_policy"; }
  return "unknown";
}
function navigationDenied(s, details, event) {
  localPause(s, true, "navigation_denied", {
    event,
    frame: details.frameId === 0 ? "main" : Number.isInteger(details.frameId) && details.frameId > 0 ? "child" : "unknown",
    destination: navigationDestination(s, details.url),
    revision: CHROME_NAVIGATION_DIAGNOSTIC_REVISION,
  });
}
function markOpaqueChildren(tab, timeStamp = Date.now()) {
  // Fence pending reset verification even when scope is already main-only.
  // This evidence counter is not a reference epoch: repeated guards must not
  // invalidate otherwise safe actions in an unchanged partial scope.
  tab.privacyEvidenceGeneration++;
  tab.opaqueChildren = true;
  tab.opaqueSince = Math.max(tab.opaqueSince ?? 0, Number.isFinite(timeStamp) ? timeStamp : Date.now());
}
function completeFrameTree(frames) {
  const byId = new Map();
  for (const frame of frames) {
    if (!Number.isInteger(frame.frameId) || frame.frameId < 0 || byId.has(frame.frameId)) return false;
    byId.set(frame.frameId, frame);
  }
  if (byId.get(0)?.parentFrameId !== -1) return false;
  for (const frame of frames) {
    if (frame.frameId === 0) continue;
    const seen = new Set([frame.frameId]);
    let parent = frame.parentFrameId;
    while (parent !== 0) {
      if (!Number.isInteger(parent) || parent < 0 || seen.has(parent) || !byId.has(parent)) return false;
      seen.add(parent);
      parent = byId.get(parent).parentFrameId;
    }
  }
  return true;
}
// Chrome can omit extension ancestors from getAllFrames while returning their
// HTTP descendants. An absent frame cannot prove privacy UI was removed. Only a
// verified NEW main-document commit may clear the tab's conservative latch.
function verifyMainCommit(s, tab, details) {
  const epoch = s.epoch, previous = tab.mainDocumentId;
  const privacyEvidenceGeneration = tab.privacyEvidenceGeneration;
  if (typeof details.documentId !== "string" || details.documentId === previous) return;
  void chrome.webNavigation.getAllFrames({ tabId: tab.id }).then(frames => {
    if (sessions.get(s.id) !== s || leases.get(tab.id) !== s.id ||
        s.tabs.get(tab.cap) !== tab || s.epoch !== epoch || tab.mainDocumentId !== previous ||
        tab.privacyEvidenceGeneration !== privacyEvidenceGeneration) return;
    const mains = frames?.filter(f => f.frameId === 0) ?? [];
    if (mains.length !== 1 || mains[0].documentId !== details.documentId || mains[0].url !== details.url) return;
    // Recheck policy; failed/forbidden commits never clear uncertainty.
    checkURL(s, mains[0].url);
    if (mains[0].errorOccurred !== false) return;
    if (!completeFrameTree(frames) || frames.some(f => opaqueExtensionFrame(f.frameId, f.url))) {
      markOpaqueChildren(tab);
      return;
    }
    tab.mainDocumentId = details.documentId;
    // Browser timestamps prevent a late/stale main commit from clearing a
    // privacy event that occurred later within that same document lifetime.
    if (tab.opaqueChildren && previous != null && Number.isFinite(details.timeStamp) && details.timeStamp > tab.opaqueSince) {
      tab.opaqueChildren = false;
      s.epoch = crypto.randomUUID();
    }
  }).catch(() => {}); // Unverified scope remains conservatively restricted.
}
async function documentGuard(s, run, tab, screenshot = false) {
  current(s, run);
  owned(s, tab.cap);
  const info = await chrome.tabs.get(tab.id);
  current(s, run);
  checkURL(s, info.url);
  if (info.pendingUrl) unavailable();
  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
  current(s, run);
  if (
    !frames ||
    !frames.length ||
    frames.length > 64 ||
    frames.filter(f => f.frameId === 0).length !== 1 ||
    !frames.some(f => f.frameId === 0 && f.url === info.url && typeof f.documentId === "string")
  ) {
    markOpaqueChildren(tab);
    unavailable();
  }
  // Establish the current lifetime without ever clearing its exclusion latch.
  tab.mainDocumentId ??= frames.find(f => f.frameId === 0).documentId;
  if (!completeFrameTree(frames) || frames.some(f => opaqueExtensionFrame(f.frameId, f.url)))
    markOpaqueChildren(tab);
  const opaqueChildren = tab.opaqueChildren;
  // No pixels from inherited, privileged or unaccounted children can be certified safe.
  if (screenshot && (opaqueChildren || frames.some(f => inheritedFrame(f.frameId, f.url))))
    throw new ChromeObservationError("unsupported_frame");
  const webFrames = frames.filter(f => !inheritedFrame(f.frameId, f.url) && !opaqueExtensionFrame(f.frameId, f.url));
  // Do not relax destination policy for a forbidden descendant or sibling.
  // This inspects browser metadata only, never a frame's DOM or private pixels.
  for (const frame of webFrames) checkURL(s, frame.url);
  const observed = opaqueChildren ? webFrames.filter(f => f.frameId === 0) : webFrames;
  if (observed.length > 16) unavailable();
  return {
    docs: observed.map(f => ({
      documentId: f.documentId,
      frameId: f.frameId,
      origin: new URL(f.url).origin,
    })),
    opaqueChildren,
    // Bind to the ENTIRE frame tree, including omitted documents and parent
    // relationships. Exposure can change without an included document changing.
    signature: JSON.stringify(frames.map(f => [
      f.frameId, f.parentFrameId, f.documentId,
      opaqueExtensionFrame(f.frameId, f.url) ? "opaque" : inheritedFrame(f.frameId, f.url) ? "inherited" : "web",
    ]).sort((a, b) => a[0] - b[0])),
  };
}
async function tracked(s, promise) {
  s.pending.add(promise);
  try {
    return await promise;
  } finally {
    s.pending.delete(promise);
  }
}
async function execute(s, run, tab, doc, op, args, epoch) {
  current(s, run);
  const result = await tracked(
    s,
    chrome.scripting.executeScript({
      target: { tabId: tab.id, documentIds: [doc.documentId] },
      world: "ISOLATED",
      func: observation,
      args: [op, args, doc.origin, epoch],
    }),
  );
  current(s, run);
  owned(s, tab.cap);
  if (
    s.epoch !== epoch ||
    result.length !== 1 ||
    result[0].documentId !== doc.documentId ||
    !result[0].result
  )
    unavailable();
  if (Object.hasOwn(result[0].result, "observationBlocked")) {
    const reason = chromeFailureReason(result[0].result.observationBlocked);
    if (reason) throw new ChromeObservationError(reason);
    unavailable();
  }
  return result[0].result;
}
// No DOM-element <-> Chrome frame-ID guessing: if the frame tree cannot be
// observed in full, omit every child document. The fallback flag is internal,
// never an RPC parameter. Screenshots retain the strict whole-tab guard.
async function exposure(s, run, tab, tree, epoch, screenshot) {
  const docs = tree.docs;
  const top = docs.find((doc) => doc.frameId === 0);
  if (!top) unavailable();
  const mode = screenshot ? "screenshot" : "guard";
  const main = await execute(s, run, tab, top, mode,
    screenshot ? {} : { topDocumentOnly: true }, epoch);
  const scopes = new Map([[top.documentId, main.shadowScope ?? ""]]);
  let shadowRootsOmitted = main.shadowRootsOmitted === true;
  // A frame inside an omitted host cannot be mapped safely to a Chrome frame
  // ID. As with hidden frames, omit ALL child documents, not guessed subsets.
  if (tree.opaqueChildren || main.framesOmitted === true || shadowRootsOmitted)
    return { docs: [top], topOnly: true, shadowRootsOmitted, shadowScope: JSON.stringify([...scopes]) };
  for (const doc of docs) {
    if (doc === top) continue;
    try {
      const child = await execute(s, run, tab, doc, mode, {}, epoch);
      scopes.set(doc.documentId, child.shadowScope ?? "");
      if (child.shadowRootsOmitted === true) shadowRootsOmitted = true;
    } catch (error) {
      if (!screenshot && error instanceof ChromeObservationError && error.reason === "unsupported_frame")
        return { docs: [top], topOnly: true, shadowRootsOmitted, shadowScope: JSON.stringify([...scopes]) };
      throw error;
    }
  }
  return { docs: shadowRootsOmitted ? [top] : docs, topOnly: shadowRootsOmitted,
    shadowRootsOmitted, shadowScope: JSON.stringify([...scopes]) };
}
async function script(s, run, tab, op, args) {
  const tree = await documentGuard(s, run, tab, op === "screenshot"), epoch = s.epoch;
  const scope = await exposure(s, run, tab, tree, epoch, op === "screenshot");
  const { docs, topOnly } = scope;
  const signature = tree.signature;
  const referenceScope = signature + (topOnly ? ":main-only" : ":all") + scope.shadowScope;
  const exact = ["click", "fill", "select", "key"].includes(op);
  if (exact && tab.document !== referenceScope) unavailable();
  let result;
  if (op === "snapshot") {
    tab.refs.clear();
    const frames = [];
    for (const doc of docs) {
      const observed = await execute(s, run, tab, doc, op,
        topOnly ? { topDocumentOnly: true } : {}, epoch);
      for (const el of observed.elements) tab.refs.set(el.ref, doc.documentId);
      frames.push({ frame: doc.frameId, ...observed });
    }
    result = {
      ready: frames.every((f) => f.ready),
      text: frames
        .map((f) => `[Frame ${f.frame}] ${f.text}`)
        .join("\n")
        .slice(0, 24000),
      elements: frames.flatMap((f) => f.elements).slice(0, 300),
      frames: frames.map((f) => ({ frame: f.frame, viewport: f.viewport })),
      ...(topOnly ? { framesOmitted: true, frameNotice: "Only the main document is included; all child frames are omitted because the frame tree is not fully observable." } : {}),
      ...(scope.shadowRootsOmitted ? { shadowRootsOmitted: true, shadowNotice: "Author shadow hosts and their subtrees are omitted; only light-DOM content outside them is included. Child frames are omitted too. Absence of text cannot be established for the whole page." } : {}),
      truncated:
        frames.some((f) => f.truncated) ||
        frames.reduce((n, f) => n + f.text.length, 0) > 24000,
    };
    tab.document = referenceScope;
  } else if (op === "screenshot") result = { ok: true };
  else {
    const doc = exact
      ? docs.find((d) => d.documentId === tab.refs.get(args.ref))
      : docs.find((d) => d.frameId === 0);
    if (!doc) unavailable();
    result = await execute(s, run, tab, doc, op,
      topOnly ? { ...args, topDocumentOnly: true } : args, epoch);
    if (exact) tab.refs.clear();
  }
  const after = await documentGuard(s, run, tab, op === "screenshot");
  if (s.epoch !== epoch || after.signature !== signature) unavailable();
  // Discard observations if frame visibility changes while collecting them.
  // Actions are never replayed when a post-check fails.
  const afterScope = await exposure(s, run, tab, after, epoch, op === "screenshot");
  if (afterScope.topOnly !== topOnly || afterScope.shadowScope !== scope.shadowScope ||
      afterScope.shadowRootsOmitted !== scope.shadowRootsOmitted) unavailable();
  return result;
}
async function dispatch(r) {
  const p = r.params;
  if (r.method === "freeze") {
    desktopFrozen = true;
    await Promise.all([...sessions.values()].map(s => pause(s, true, "native_handoff")));
    await cleanupDebuggers();
    return { frozen: true };
  }
  if (r.method === "unfreeze") {
    // This only removes the instance latch; individual tasks remain paused.
    desktopFrozen = false;
    return { ok: true };
  }
  if (desktopFrozen && !["pause", "end", "focus"].includes(r.method)) unavailable();
  if (r.method === "begin") {
    const retained = sessions.get(r.session);
    if (retained) {
      if (
        !retained.idle ||
        !retained.paused ||
        retained.pauseFailed ||
        JSON.stringify(retained.protected) !== JSON.stringify(p.protected)
      )
        unavailable();
      retained.run = r.run;
      retained.idle = false;
      retained.epoch = crypto.randomUUID();
      return { ok: true, paused: true, tabs: [...retained.tabs.keys()] };
    }
    if (
      sessions.size >= 8 ||
      !Array.isArray(p.protected) ||
      typeof p.name !== "string"
    )
      unavailable();
    sessions.set(r.session, {
      id: r.session,
      run: r.run,
      paused: false,
      pauseFailed: false,
      idle: false,
      pending: new Set(),
      epoch: crypto.randomUUID(),
      tabs: new Map(),
      groups: new Map(),
      protected: p.protected,
      agentName: p.name.slice(0, 55),
      name: `🔎 Jelly · ${p.name.slice(0, 55)} · Browse`,
      color: [
        "blue",
        "red",
        "yellow",
        "green",
        "pink",
        "purple",
        "cyan",
        "orange",
      ][
        Array.from(p.agent ?? r.session).reduce(
          (n, c) => (n * 31 + c.charCodeAt(0)) >>> 0,
          0,
        ) % 8
      ],
    });
    return { ok: true };
  }
  const s = sessions.get(r.session);
  if (!s) unavailable();
  current(s, r.run, ["end", "pause", "resume", "focus"].includes(r.method));
  if (r.method === "name") {
    s.name = `🔎 Jelly · ${s.agentName} · ${p.name}`;
    for (const groupId of s.groups.values()) {
      current(s, r.run);
      await chrome.tabGroups
        .update(groupId, { title: s.name, color: s.color })
        .catch(() => {});
    }
    return { ok: true };
  }
  if (r.method === "pause") {
    await pause(s, true);
    return { ok: true };
  }
  if (r.method === "resume") {
    await s.pausing;
    current(s, r.run, true);
    if (desktopFrozen || s.idle || s.pauseFailed) unavailable();
    s.epoch = crypto.randomUUID();
    for (const tab of s.tabs.values()) tab.pauseRetained = false;
    s.paused = false;
    return { ok: true };
  }
  if (r.method === "end") {
    await pause(s, false, "settlement");
    s.idle = true;
    for (const tab of [...s.tabs.values()]) {
      if (
        !p.discard &&
        (tab.mark === "handoff" || tab.pauseRetained) &&
        tab.origin === "agent"
      )
        continue;
      s.tabs.delete(tab.cap);
      leases.delete(tab.id);
      if (
        tab.mark === "temporary" &&
        tab.origin === "agent" &&
        !tab.pauseRetained
      )
        await chrome.tabs.remove(tab.id).catch(() => {});
      // User tabs are always released, never closed or regrouped.
      await chrome.declarativeNetRequest
        .updateSessionRules({ removeRuleIds: tab.rules })
        .catch(() => {});
    }
    if (!s.tabs.size) sessions.delete(s.id);
    return { ok: true, retained: [...s.tabs.keys()] };
  }
  if (r.method === "tabs") {
    if (p.operation === "list")
      return { tabs: [...s.tabs.keys()].map((pageId) => ({ pageId })) };
    if (p.operation === "new") {
      const tab = await tracked(s, create(s, r.run, p.url));
      return { pageId: tab.cap };
    }
    const tab = owned(s, p.pageId);
    if (p.operation === "select") {
      s.epoch = crypto.randomUUID();
      tab.document = null;
      return { pageId: tab.cap };
    }
    if (p.operation === "close") {
      s.epoch = crypto.randomUUID();
      await pauseTab(tab);
      current(s, r.run);
      s.tabs.delete(tab.cap);
      leases.delete(tab.id);
      if (tab.origin === "agent") await tracked(s, chrome.tabs.remove(tab.id));
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: tab.rules,
      });
      return { ok: true };
    }
    unavailable();
  }
  if (r.method === "open" && !p.tab) {
    const tab = await tracked(s, create(s, r.run, p.url));
    return { pageId: tab.cap };
  }
  const tab = owned(s, p.tab);
  if (r.method === "focus") {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update((await chrome.tabs.get(tab.id)).windowId, {
      focused: true,
    });
    return { ok: true };
  }
  if (r.method === "mark") {
    if (
      !["temporary", "deliverable", "handoff"].includes(p.mark) ||
      (tab.origin === "user" && p.mark === "handoff")
    )
      unavailable();
    tab.mark = p.mark;
    return { ok: true };
  }
  if (r.method === "open") {
    checkURL(s, p.url);
    s.epoch = crypto.randomUUID();
    tab.document = null;
    await tracked(s, chrome.tabs.update(tab.id, { url: p.url }));
    current(s, r.run);
    return { pageId: tab.cap };
  }
  if (r.method === "screenshot") {
    await script(s, r.run, tab, "screenshot", {});
    current(s, r.run);
    if (!tab.attached) {
      if (debuggerCleanup.size >= 256) unavailable();
      confirmedDetached.delete(tab.id);
      debuggerCleanup.add(tab.id);
      // Persist before attach: worker loss at any later point leaves a cleanup
      // obligation, including an indeterminate attach result.
      await persistCleanup();
      current(s, r.run);
      tab.attaching = chrome.debugger
        .attach({ tabId: tab.id }, "1.3")
        .then(() => {
          tab.attached = true;
        });
      try {
        await tab.attaching;
      } catch {
        await pause(s, true, "debugger_attach_failed");
        unavailable();
      } finally {
        tab.attaching = null;
      }
    }
    current(s, r.run);
    const doc = await documentGuard(s, r.run, tab, true),
      epoch = s.epoch;
    const image = await tracked(
      s,
      chrome.debugger.sendCommand({ tabId: tab.id }, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      }),
    );
    current(s, r.run);
    const after = await documentGuard(s, r.run, tab, true);
    await script(s, r.run, tab, "screenshot", {});
    if (
      doc.signature !== after.signature ||
      epoch !== s.epoch ||
      typeof image.data !== "string" ||
      image.data.length > 650000
    )
      unavailable();
    return { image: image.data };
  }
  if (r.method === "snapshot") {
    s.epoch = crypto.randomUUID();
    return script(s, r.run, tab, "snapshot", {});
  }
  if (r.method === "wait_for") {
    const deadline = Date.now() + (p.timeoutMs ?? 5000);
    do {
      current(s, r.run);
      const result = await script(s, r.run, tab, "snapshot", {});
      if (
        (p.condition === "ready" && result.ready) ||
        (p.condition === "text" && result.text.includes(p.text)) ||
        (p.condition === "text_absent" &&
          !result.text.includes(p.text) &&
          !result.truncated &&
          !result.framesOmitted &&
          !result.shadowRootsOmitted)
      )
        return { ok: true };
      if (Date.now() >= deadline) return { ok: false, timedOut: true };
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (true);
  }
  if (["click", "fill", "select", "key"].includes(r.method)) {
    if (
      typeof p.ref !== "string" ||
      (r.method === "fill" &&
        (typeof p.text !== "string" || p.text.length > 24000))
    )
      unavailable();
    return script(s, r.run, tab, r.method, {
      ref: p.ref,
      ...(r.method === "fill" ? { text: p.text } : {}),
      ...(r.method === "select" ? { value: p.value } : {}),
      ...(r.method === "key" ? { key: p.key } : {}),
    });
  }
  if (r.method === "scroll") {
    if (
      ![p.x ?? 0, p.y].every(
        (n) =>
          typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 10000,
      )
    )
      unavailable();
    return script(s, r.run, tab, "scroll", { x: p.x ?? 0, y: p.y });
  }
  unavailable();
}
async function pauseTab(tab) {
  tab.document = null;
  tab.refs?.clear();
  await tab.attaching?.catch(() => {});
  if (tab.attached || debuggerCleanup.has(tab.id)) {
    tab.detaching = true;
    try {
      // Preserve the attachment flag if detach or cleanup persistence fails.
      await releaseDebugger(tab.id);
      tab.attached = false;
    } finally {
      tab.detaching = false;
    }
  }
}
chrome.debugger.onDetach.addListener((source) => {
  if (debuggerCleanup.has(source.tabId)) confirmedDetached.add(source.tabId);
  const s = sessions.get(leases.get(source.tabId));
  if (s) {
    const tab = [...s.tabs.values()].find((t) => t.id === source.tabId);
    if (tab?.attached) {
      tab.attached = false; // This event confirms this extension was detached.
      if (!tab.detaching) localPause(s, true, "debugger_detached");
    }
  }
});
chrome.webNavigation.onCommitted.addListener((details) => {
  const s = sessions.get(leases.get(details.tabId));
  if (s) {
    const tab = [...s.tabs.values()].find((t) => t.id === details.tabId);
    if (
      tab?.initializing &&
      details.frameId === 0 &&
      details.url === "about:blank"
    )
      return;
    // Even unobserved helper changes revoke refs, not session authority.
    s.epoch = crypto.randomUUID();
    if (opaqueExtensionFrame(details.frameId, details.url)) {
      if (tab) markOpaqueChildren(tab, details.timeStamp);
      return;
    }
    if (inheritedFrame(details.frameId, details.url)) return;
    if (tab) tab.initializing = false;
    try {
      checkURL(s, details.url);
      if (tab && details.frameId === 0) verifyMainCommit(s, tab, details);
    } catch {
      navigationDenied(s, details, "committed");
    }
  }
});
for (const [event, kind] of [
  [chrome.webNavigation.onHistoryStateUpdated, "history"],
  [chrome.webNavigation.onReferenceFragmentUpdated, "fragment"],
])
  event.addListener((details) => {
    const s = sessions.get(leases.get(details.tabId));
    if (s) {
      s.epoch = crypto.randomUUID();
      // Same inherited-child boundary as commits. History/fragment changes in
      // an unobserved helper are not forbidden top-level destinations.
      if (opaqueExtensionFrame(details.frameId, details.url)) {
        const tab = [...s.tabs.values()].find(t => t.id === details.tabId);
        if (tab) markOpaqueChildren(tab, details.timeStamp);
        return;
      }
      if (inheritedFrame(details.frameId, details.url)) return;
      try {
        checkURL(s, details.url);
      } catch {
        navigationDenied(s, details, kind);
      }
    }
  });
chrome.tabGroups.onRemoved.addListener((group) => {
  for (const s of sessions.values())
    for (const [windowId, groupId] of s.groups)
      if (groupId === group.id) s.groups.delete(windowId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (debuggerCleanup.delete(tabId)) void persistCleanup().catch(() => {});
  confirmedDetached.delete(tabId);
  const s = sessions.get(leases.get(tabId));
  if (s) {
    s.epoch = crypto.randomUUID();
    for (const [cap, tab] of s.tabs)
      if (tab.id === tabId) {
        s.tabs.delete(cap);
        if (port && instance)
          post({
            type: "tabRemoved",
            generation,
            session: s.id,
            run: s.run,
            tab: cap,
          });
        void chrome.declarativeNetRequest
          .updateSessionRules({
            removeRuleIds: tab.rules,
          })
          .catch(() => {});
      }
    leases.delete(tabId);
    if (s.idle && !s.tabs.size) sessions.delete(s.id);
  }
});
chrome.tabs.onReplaced.addListener((_added, removed) => {
  const s = sessions.get(leases.get(removed));
  if (!s) return;
  for (const [cap, tab] of s.tabs)
    if (tab.id === removed) {
      s.tabs.delete(cap);
      leases.delete(removed);
      tabEvent("tabRemoved", s, tab);
      void chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: tab.rules,
      });
    }
  if (s.idle && !s.tabs.size) sessions.delete(s.id);
  else localPause(s, true, "tab_replaced"); // Never transfer authority using a replacement's numeric ID.
});
async function adopt(s, run, id, origin) {
  current(s, run);
  if (leases.has(id) || debuggerCleanup.has(id) || s.tabs.size >= 12)
    unavailable();
  // Reserve before the first await so competing user grants/popups cannot race.
  leases.set(id, s.id);
  const tab = {
    id,
    cap: crypto.randomUUID(),
    origin,
    mark: "temporary",
    rules: [],
    refs: new Map(),
    attached: false,
    document: null,
    // Adoption may miss events that preceded leasing. No child exposure until
    // a later verified main-document commit establishes a new lifetime.
    opaqueChildren: true,
    opaqueSince: Date.now(),
    privacyEvidenceGeneration: 0,
    mainDocumentId: null,
  };
  s.tabs.set(tab.cap, tab); // Count reserved adoptions before asynchronous policy work.
  try {
    tab.rules = await protect(id, s);
    current(s, run);
    let info = await chrome.tabs.get(id);
    if (origin === "agent")
      for (
        let i = 0;
        i < 20 && (!info.url || info.url === "about:blank");
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        current(s, run);
        info = await chrome.tabs.get(id);
      }
    checkURL(s, info.url);
    if (info.pendingUrl) checkURL(s, info.pendingUrl);
    current(s, run);
    owned(s, tab.cap);
    // Never change a user tab's group. Popups are agent-created task tabs.
    if (origin === "agent") {
      const group = await chrome.tabs.group({
        tabIds: id,
        ...(s.groups.has(info.windowId)
          ? { groupId: s.groups.get(info.windowId) }
          : {}),
      });
      s.groups.set(info.windowId, group);
      await chrome.tabGroups.update(group, { title: s.name, color: s.color });
      current(s, run);
    }
    tabEvent("tabAdded", s, tab);
    return tab;
  } catch (error) {
    leases.delete(id);
    s.tabs.delete(tab.cap);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: tab.rules,
    });
    throw error;
  }
}
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  const s = sessions.get(leases.get(details.sourceTabId));
  if (!s) return;
  // Chrome may begin popup networking before this event. This is access policy,
  // not a SOCKS-equivalent egress boundary. Never observe before protect+check.
  try {
    current(s, s.run);
    checkURL(s, details.url);
  } catch {
    localPause(s, true, "popup_denied");
    return;
  }
  void tracked(s, adopt(s, s.run, details.tabId, "agent")).catch(() =>
    localPause(s, true, "popup_denied"),
  );
});
// Only packaged popup pages may issue local controls. No content-script RPC.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    ![
      chrome.runtime.getURL("popup.html"),
      chrome.runtime.getURL("popup.html") + "#connect",
    ].includes(sender.url)
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
    } else if (message.action !== "status") unavailable();
    return {
      profile,
      instance,
      connected: !!instance,
      pending: pendingPair,
      unresolvedDebuggerCleanup: [...debuggerCleanup].filter(
        (id) => !leases.has(id),
      ).length,
      connecting: !!connecting || (!!port && !instance && !pendingPair),
      optedOut,
      connectionError,
      sessions: [...sessions.values()].map((s) => ({
        id: s.id,
        name: s.name,
        paused: s.paused && !s.pausing && !s.pauseFailed,
        pausing: !!s.pausing,
        failed: !!s.pauseFailed,
        tabs: s.tabs.size,
      })),
    };
  })().then(respond, () => respond({ error: "Unavailable" }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) {
    void automaticConnect();
  } else if (alarm.name === handshakeAlarm && port && !instance && !pendingPair) {
    void lostConnection("handshake-timeout");
  }
});
chrome.runtime.onStartup.addListener(() => void automaticConnect());
chrome.runtime.onInstalled.addListener(() => void automaticConnect());
// Module evaluation also covers extension reload and MV3 worker recreation.
void automaticConnect();
