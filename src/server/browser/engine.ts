/**
 * Codex-style browser engine (plans/codex-style-browser.md §3). Runs in the Jelly
 * server; the extension is a thin CDP relay. One engine per agent browser session.
 */
import { renderRevision, identityFor, isSettable, dialogSnapshotNodes, type AXInputNode, type AXRevision, type AXSnapshot } from "./ax-render";
import { keyEventsFor, typeTextEvents } from "./keys";
import * as page from "./page-scripts";
import { BrowserError, type BrowserHost, type ChromePort, type ChromePortEvent, type TabInfo, type UserTabInfo } from "./types";
import { PlaywrightLayer } from "./playwright";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function poll(done: () => boolean, timeoutMs: number, everyMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() >= deadline) return false;
    await sleep(everyMs);
  }
  return true;
}
const withTimeout = <T>(p: Promise<T>, ms: number, message: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });

/** Codex constants (analysis Appendix A). */
const C = {
  navDetectMs: 25,
  commitMs: 5000,
  paintMs: 5000,
  axQuietNavMs: 50,
  axQuietMs: 100,
  axQuietCapMs: 750,
  childFrameTotalMs: 1000,
  childFrameOpMs: 500,
  hitSettlePollMs: 25,
  hitSettleMs: 500,
  hitSettlePx: 0.5,
  gotoMs: 10000,
  screencastMs: 2000,
  screenshotMs: 5000,
  eventBuffer: 1000,
  maxDisplay: 100_000,
};

const PAINT_EVENTS = new Set(["firstPaint", "firstContentfulPaint", "firstImagePaint", "firstMeaningfulPaint"]);
const AX_PROPERTIES = new Set(
  "atomic autocomplete busy checked controls describedby details disabled editable errormessage expanded flowto focusable focused hasPopup invalid keyshortcuts labelledby level live modal multiline multiselectable orientation placeholder pressed radiogroup relevant required roledescription selected settable url valuemax valuemin valuetext".split(" "),
);
const NO_RELATED = new Set(["controls", "describedby", "details", "errormessage", "flowto", "labelledby"]);

export interface Target { sessionId?: string; backendNodeId?: number; frameId?: string; dialog?: "accept" | "dismiss" | "prompt" }
export interface NavState { revision: number; navigationRevision: number; loading: boolean }
export interface Dialog { id: string; type: string; message: string; defaultPrompt?: string; url?: string; promptText?: string }
export interface ChildSession { sessionId: string; targetId: string; parent?: string; type: string; ready?: Promise<void> }
export interface TabState {
  id: number;
  attached: boolean;
  attaching?: Promise<void>;
  stoppedByUser: boolean;
  sessions: Map<string, ChildSession>;
  mainFrameId?: string;
  loaderId?: string;
  url?: string;
  loading: boolean;
  committed: boolean;
  painted: boolean;
  complete: boolean;
  revision: number;
  navigationRevision: number;
  lastAXUpdate: number;
  lifecycle: Set<string>;
  pending?: NavState;
  pendingError?: Error;
  dialog?: Dialog;
  dialogWaiters: Set<(d: Dialog) => void>;
  ax?: { revision: AXRevision; targets: Map<string, Target>; documentKey: string };
  events: Array<{ sequence: number; method: string; params: unknown; sessionId?: string }>;
  sequence: number;
  eventWaiters: Set<() => void>;
  input: Promise<unknown>;
  info?: TabInfo;
}

export { BrowserError };

export class BrowserEngine {
  private tabs = new Map<number, TabState>();
  private known = new Map<number, TabInfo>();
  private unsubscribe: () => void;
  private clipboard = "";
  private dialogs = 0;
  private playwright = new PlaywrightLayer(this);
  readonly host: BrowserHost;

  constructor(readonly port: ChromePort, readonly platform: "mac" | "other" = process.platform === "darwin" ? "mac" : "other") {
    this.unsubscribe = port.onEvent((e) => this.onEvent(e));
    this.host = (op, args, signal) => this.execute(op, args, signal);
  }

  dispose() {
    this.unsubscribe();
    this.tabs.clear();
    this.known.clear();
  }

  /** Forget all tab/session state (e.g. after a fresh extension session). */
  reset() {
    this.tabs.clear();
    this.known.clear();
  }

  // ───────────────────────── events ─────────────────────────

  /** @internal */ state(tabId: number): TabState {
    let t = this.tabs.get(tabId);
    if (!t) {
      t = {
        id: tabId, attached: false, stoppedByUser: false, sessions: new Map(), loading: false, committed: true,
        painted: true, complete: true, revision: 0, navigationRevision: 0, lastAXUpdate: 0, lifecycle: new Set(),
        dialogWaiters: new Set(), events: [], sequence: 0, eventWaiters: new Set(), input: Promise.resolve(),
      };
      this.tabs.set(tabId, t);
    }
    return t;
  }

  private onEvent(e: ChromePortEvent) {
    if (e.type === "tabAdded") {
      this.known.set(e.tab.id, e.tab);
      return;
    }
    if (e.type === "tabRemoved") {
      this.known.delete(e.tabId);
      this.tabs.delete(e.tabId);
      return;
    }
    const t = this.tabs.get(e.tabId);
    if (!t) return;
    if (e.type === "cdpDetach") {
      t.attached = false;
      t.sessions.clear();
      if (e.reason === "canceled_by_user") t.stoppedByUser = true;
      return;
    }
    const { method, params, sessionId } = e;
    if (method !== "Accessibility.nodesUpdated") {
      t.events.push({ sequence: ++t.sequence, method, params, sessionId });
      if (t.events.length > C.eventBuffer) t.events.splice(0, t.events.length - C.eventBuffer);
      for (const w of t.eventWaiters) w();
    }
    if (method === "Accessibility.nodesUpdated" || method === "Accessibility.loadComplete") {
      t.lastAXUpdate = Date.now();
      return;
    }
    if (method === "Target.attachedToTarget") {
      const info = params.targetInfo;
      if (info?.type === "iframe" && params.sessionId) {
        const child: ChildSession = { sessionId: params.sessionId, targetId: info.targetId, parent: sessionId, type: info.type };
        t.sessions.set(params.sessionId, child);
        child.ready = this.initChildSession(t, child).catch(() => {});
      }
      return;
    }
    if (method === "Target.detachedFromTarget") {
      t.sessions.delete(params.sessionId);
      return;
    }
    if (sessionId) return; // remaining tracking is main-frame (root session) only
    switch (method) {
      case "Page.frameStartedLoading":
        if (!t.mainFrameId || params.frameId === t.mainFrameId) {
          t.loading = true; t.committed = false; t.painted = false; t.complete = false;
          t.revision++; t.navigationRevision++;
        }
        break;
      case "Page.frameNavigated":
        if (!params.frame?.parentId) {
          t.mainFrameId = params.frame.id;
          t.loaderId = params.frame.loaderId;
          t.url = params.frame.url;
          t.committed = true;
          t.lifecycle.clear();
          if (params.type === "BackForwardCacheRestore") { t.loading = false; t.painted = true; t.complete = true; }
          t.revision++;
        }
        break;
      case "Page.navigatedWithinDocument":
        if (params.frameId === t.mainFrameId) {
          const fragmentOnly = t.url && params.url && t.url.split("#")[0] === params.url.split("#")[0];
          t.url = params.url;
          if (!fragmentOnly) t.revision++;
        }
        break;
      case "Page.domContentEventFired":
        t.loading = false;
        break;
      case "Page.frameStoppedLoading":
        if (params.frameId === t.mainFrameId) t.loading = false;
        break;
      case "Page.loadEventFired":
        t.loading = false; t.complete = true; t.painted = true;
        break;
      case "Page.lifecycleEvent":
        if (params.frameId === t.mainFrameId) {
          if (params.loaderId === t.loaderId) t.lifecycle.add(params.name);
          if (PAINT_EVENTS.has(params.name)) t.painted = true;
          if (params.name === "load") t.complete = true;
        }
        break;
      case "Page.javascriptDialogOpening": {
        if (params.type === "beforeunload") {
          void this.cdp(t, "Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
          break;
        }
        const d: Dialog = { id: String(++this.dialogs), type: params.type, message: params.message ?? "", defaultPrompt: params.defaultPrompt, url: params.url, promptText: params.defaultPrompt ?? "" };
        t.dialog = d;
        t.revision++;
        for (const w of t.dialogWaiters) w(d);
        break;
      }
      case "Page.javascriptDialogClosed":
        t.dialog = undefined;
        t.revision++;
        break;
    }
  }

  private async initChildSession(t: TabState, child: ChildSession) {
    const opts = { sessionId: child.sessionId, timeoutMs: 2000 };
    await Promise.all([
      this.cdp(t, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, opts).catch(() => {}),
      this.cdp(t, "Accessibility.enable", {}, opts).catch(() => {}),
      this.cdp(t, "Runtime.runIfWaitingForDebugger", {}, opts).catch(() => {}),
    ]);
  }

  // ───────────────────────── CDP plumbing ─────────────────────────

  /** @internal */ async ensureAttached(t: TabState) {
    if (t.stoppedByUser) {
      t.stoppedByUser = false;
      throw new BrowserError("Browser use was stopped in Chrome (the user cancelled the debugger). Ask the user before continuing; the next call will re-attach.");
    }
    if (t.attached) return;
    if (t.attaching) return t.attaching;
    t.attaching = (async () => {
      await this.port.call("attach", { tabId: t.id });
      t.attached = true;
      t.sessions.clear();
      await Promise.all([
        this.raw(t, "Page.enable"),
        this.raw(t, "Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => {}),
        this.raw(t, "Accessibility.enable").catch(() => {}),
        this.raw(t, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {}),
        this.raw(t, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe" }] })
          .catch(() => this.raw(t, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }))
          .catch(() => {}),
      ]);
      const [{ frameTree }, probe] = await Promise.all([
        this.raw(t, "Page.getFrameTree"),
        this.evaluateValue(t, page.NAV_PROBE).catch(() => null),
      ]);
      t.mainFrameId = frameTree.frame.id;
      t.loaderId = frameTree.frame.loaderId;
      t.url = frameTree.frame.url;
      t.committed = true;
      if (probe) {
        t.loading = probe.readyState === "loading";
        t.complete = probe.readyState === "complete";
        t.painted = probe.painted || t.complete;
      }
    })().finally(() => { t.attaching = undefined; });
    return t.attaching;
  }

  private raw(t: TabState, method: string, params: Record<string, unknown> = {}, opts: { sessionId?: string; timeoutMs?: number } = {}) {
    return this.port.call("cdp", {
      tabId: t.id, method, params,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  /** CDP command with lazy attach and one re-attach retry (Codex `executeTargetCdp`). */
  /** @internal */ async cdp(t: TabState, method: string, params: Record<string, unknown> = {}, opts: { sessionId?: string; timeoutMs?: number } = {}): Promise<any> {
    await this.ensureAttached(t);
    try {
      return await this.raw(t, method, params, opts);
    } catch (error) {
      if (!/not attached|Debugger is not attached|Detached while handling|No tab with given id/i.test(String((error as Error)?.message)) || opts.sessionId) throw error;
      t.attached = false;
      await this.ensureAttached(t);
      return this.raw(t, method, params, opts);
    }
  }

  /** @internal */ async batch(t: TabState, commands: Array<{ method: string; params?: Record<string, unknown> }>, sessionId?: string) {
    if (!commands.length) return;
    await this.ensureAttached(t);
    for (let i = 0; i < commands.length; i += 2000)
      await this.port.call("cdpBatch", { tabId: t.id, commands: commands.slice(i, i + 2000), ...(sessionId ? { sessionId } : {}) });
  }

  /** @internal */ async evaluateValue(t: TabState, expression: string, sessionId?: string) {
    const r = await this.raw(t, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, { sessionId });
    if (r.exceptionDetails) throw new BrowserError(exceptionText(r.exceptionDetails));
    return r.result?.value;
  }

  /** @internal */ async callOn(t: TabState, target: Target, fn: string, argument?: unknown): Promise<any> {
    if (target.backendNodeId === undefined) throw new BrowserError("Element has no DOM node.");
    const { object } = await this.cdp(t, "DOM.resolveNode", { backendNodeId: target.backendNodeId }, { sessionId: target.sessionId });
    try {
      const r = await this.cdp(t, "Runtime.callFunctionOn", {
        objectId: object.objectId, functionDeclaration: fn, arguments: [{ value: argument ?? null }],
        returnByValue: true, awaitPromise: true, userGesture: true,
      }, { sessionId: target.sessionId });
      if (r.exceptionDetails) throw new BrowserError(exceptionText(r.exceptionDetails));
      return r.result?.value;
    } finally {
      void this.raw(t, "Runtime.releaseObject", { objectId: object.objectId }, { sessionId: target.sessionId }).catch(() => {});
    }
  }

  // ───────────────────────── tabs ─────────────────────────

  /** @internal */ tab(args: Record<string, unknown>): TabState {
    const id = Number(args.tab);
    if (!Number.isSafeInteger(id)) throw new BrowserError("A tab id is required.");
    if (!this.known.has(id) && !this.tabs.has(id))
      throw new BrowserError(`Tab ${id} is not part of this browser session. Use browser.tabs.list(), or claim a user tab with browser.user.claimTab().`);
    return this.state(id);
  }

  private remember(info: TabInfo) {
    this.known.set(info.id, info);
    this.state(info.id).info = info;
    return info;
  }

  /** @internal */ navSnapshot(t: TabState): NavState {
    return { revision: t.revision, navigationRevision: t.navigationRevision, loading: t.loading };
  }

  private async goto(t: TabState, url: string, timeoutMs = C.gotoMs) {
    await this.ensureAttached(t);
    t.pending ??= this.navSnapshot(t);
    const r = await this.cdp(t, "Page.navigate", { url });
    if (r.errorText && r.errorText !== "net::ERR_ABORTED") throw new BrowserError(`Navigation to ${url} failed: ${r.errorText}`);
    if (r.loaderId) {
      t.loading = true;
      await poll(() => t.loaderId === r.loaderId && !t.loading, timeoutMs, 25);
    }
  }

  private async history(t: TabState, delta: number) {
    const { currentIndex, entries } = await this.cdp(t, "Page.getNavigationHistory");
    const entry = entries[currentIndex + delta];
    if (!entry) throw new BrowserError(delta < 0 ? "No previous page in this tab's history." : "No next page in this tab's history.");
    t.pending ??= this.navSnapshot(t);
    await this.cdp(t, "Page.navigateToHistoryEntry", { entryId: entry.id });
    await poll(() => !t.loading && t.committed, C.gotoMs, 25);
  }

  // ───────────────────────── settle + capture (§4) ─────────────────────────

  private async settle(t: TabState) {
    const s = t.pending ?? (t.loading ? this.navSnapshot(t) : undefined);
    t.pending = undefined;
    if (!s) return { navigated: false };
    if (!t.loading) await poll(() => t.loading || t.navigationRevision !== s.navigationRevision || t.revision !== s.revision, C.navDetectMs);
    if (t.loading && !t.committed) await poll(() => t.committed || !t.loading, C.commitMs);
    const navigated = s.loading || t.navigationRevision !== s.navigationRevision;
    if (navigated) await poll(() => t.painted || t.complete || !!t.dialog, C.paintMs);
    await this.axQuiet(t, navigated ? C.axQuietNavMs : C.axQuietMs);
    return { navigated };
  }

  private async axQuiet(t: TabState, quietMs: number) {
    const start = Date.now();
    await poll(() => Date.now() - Math.max(t.lastAXUpdate, start) >= quietMs || Date.now() - start >= C.axQuietCapMs, C.axQuietCapMs + 50, 25);
  }

  private documentKey(t: TabState) {
    return `${t.mainFrameId}:${t.loaderId}`;
  }

  private async tabHeader(t: TabState) {
    let title = t.info?.title ?? "", url = t.url ?? t.info?.url ?? "";
    try {
      const { targetInfo } = await this.cdp(t, "Target.getTargetInfo", {}, { timeoutMs: 2000 });
      title = targetInfo.title; url = targetInfo.url;
    } catch {}
    if (t.info) { t.info.title = title; t.info.url = url; }
    return { title, url };
  }

  private async captureState(t: TabState, disableDiffing = false): Promise<string> {
    await this.ensureAttached(t);
    if (t.pendingError) { const e = t.pendingError; t.pendingError = undefined; throw e; }
    const { navigated } = await this.settle(t);
    let probed = !navigated;
    for (let attempt = 0; attempt < 4; attempt++) {
      const revisionBefore = t.revision;
      const key = this.documentKey(t);
      const header = await this.tabHeader(t);
      const built = t.dialog ? this.dialogSnapshot(t, header) : await this.buildSnapshot(t, header);
      if (!probed && built.snapshot.nodes.length < 100) {
        probed = true;
        const probe = await this.evaluateValue(t, page.PAGE_PROBE).catch(() => null);
        const ax = built.snapshot.nodes.length;
        if (probe && (probe.elements >= Math.max(150, 3 * ax) || (ax < 50 && probe.textLength >= 4000))) {
          await sleep(100);
          continue;
        }
      }
      if (this.documentKey(t) !== key || (t.revision !== revisionBefore && attempt < 3 && !t.dialog)) {
        await this.settle(t);
        continue;
      }
      const previous = t.ax?.revision ?? null;
      const { revision, text } = renderRevision(built.snapshot, previous, { mode: disableDiffing ? "full" : "auto", documentKey: key });
      t.ax = { revision, targets: built.targets, documentKey: key };
      let out = `Browser tab: ${t.id}, Title: ${JSON.stringify(header.title)}, URL: ${JSON.stringify(header.url)}.\n${text}`;
      if (t.dialog) out += `\n\nA JavaScript ${t.dialog.type} dialog is open. Screenshots are unavailable until it is closed; use tab.ax.click(index) on its buttons (or press Return/Escape).`;
      return out;
    }
    throw new BrowserError("Accessibility capture kept changing before it could be committed; call tab.ax.write() again.");
  }

  private dialogSnapshot(t: TabState, header: { title: string; url: string }) {
    const d = t.dialog!;
    const tab = { id: t.id, title: header.title, url: header.url };
    const dialog = { type: d.type as "alert" | "confirm" | "prompt", message: d.message, promptText: d.promptText, defaultPrompt: d.defaultPrompt, url: d.url, id: d.id };
    const nodes = dialogSnapshotNodes(tab, dialog);
    const targets = new Map<string, Target>();
    for (const n of nodes) {
      const m = /:(accept|dismiss|prompt)$/.exec(n.identity);
      if (m) targets.set(n.identity, { dialog: m[1] as Target["dialog"] });
    }
    const snapshot: AXSnapshot = { tab, nodes };
    return { snapshot, targets };
  }

  private async buildSnapshot(t: TabState, header: { title: string; url: string }) {
    const deadline = Date.now() + C.childFrameTotalMs;
    const childOpts = (sessionId: string) => ({ sessionId, timeoutMs: Math.max(50, Math.min(C.childFrameOpMs, deadline - Date.now())) });
    await Promise.all([...t.sessions.values()].map((s) => s.ready));
    // Frames per session: root session (sessionKey "") + each OOPIF session.
    const sessionKeys = ["", ...t.sessions.keys()];
    const oopifFrameIds = new Set([...t.sessions.values()].map((s) => s.targetId));
    const frameLists = await Promise.all(sessionKeys.map(async (key) => {
      try {
        const opts = key ? childOpts(key) : {};
        const { frameTree } = await this.cdp(t, "Page.getFrameTree", {}, opts);
        const out: Array<{ frameId: string; parentId?: string; sessionKey: string }> = [];
        const walk = (node: any, parentId?: string) => {
          const frameId = node.frame.id;
          if (key === "" && parentId && oopifFrameIds.has(frameId)) return; // owned by a child session
          out.push({ frameId, parentId, sessionKey: key });
          for (const c of node.childFrames ?? []) walk(c, frameId);
        };
        walk(frameTree);
        return out;
      } catch (error) {
        if (!key) throw error;
        return [];
      }
    }));
    const frames = frameLists.flat();
    const [axTrees, domMaps, owners] = await Promise.all([
      Promise.all(frames.map(async (f) => {
        try {
          const opts = f.sessionKey ? childOpts(f.sessionKey) : {};
          const { nodes } = await this.cdp(t, "Accessibility.getFullAXTree", { frameId: f.frameId }, opts);
          return nodes as any[];
        } catch (error) {
          if (!f.sessionKey && !f.parentId) throw error;
          return [] as any[];
        }
      })),
      Promise.all(sessionKeys.map(async (key) => {
        try {
          const snap = await this.cdp(t, "DOMSnapshot.captureSnapshot", { computedStyles: [], includeDOMRects: false, includePaintOrder: false }, key ? childOpts(key) : {});
          return domMetadata(snap);
        } catch { return new Map<number, DomMeta>(); }
      })),
      Promise.all(frames.map(async (f) => {
        // Owner of this frame's document: same-session parent frame, or (OOPIF root) the parent session.
        const isOopifRoot = !!f.sessionKey && !f.parentId;
        if (!f.parentId && !isOopifRoot) return null;
        const ownerSession = isOopifRoot ? t.sessions.get(f.sessionKey)?.parent ?? "" : f.sessionKey;
        try {
          const r = await this.cdp(t, "DOM.getFrameOwner", { frameId: f.frameId }, ownerSession ? childOpts(ownerSession) : { timeoutMs: C.childFrameOpMs });
          return { sessionKey: ownerSession, backendNodeId: r.backendNodeId as number };
        } catch { return null; }
      })),
    ]);
    const domBySession = new Map(sessionKeys.map((k, i) => [k, domMaps[i]!]));
    // Index frames: owner (sessionKey|backendNodeId) → frame index.
    const childrenOfOwner = new Map<string, number[]>();
    let rootFrame = -1;
    frames.forEach((f, i) => {
      const owner = owners[i];
      if (!f.sessionKey && !f.parentId) { rootFrame = i; return; }
      if (!owner) return;
      const k = `${owner.sessionKey}|${owner.backendNodeId}`;
      (childrenOfOwner.get(k) ?? childrenOfOwner.set(k, []).get(k)!).push(i);
    });
    if (rootFrame < 0) throw new BrowserError("Main frame accessibility tree unavailable.");
    const out: AXInputNode[] = [];
    const targets = new Map<string, Target>();
    const visitedFrames = new Set<number>();
    const emit = (fi: number, parentIndex: number, depth: number) => {
      if (visitedFrames.has(fi) || depth > 16) return;
      visitedFrames.add(fi);
      const f = frames[fi]!;
      const list = axTrees[fi]!;
      if (!list.length) return;
      const byId = new Map<string, any>(list.map((n) => [n.nodeId, n]));
      const root = list.find((n) => !n.parentId || !byId.has(n.parentId)) ?? list[0];
      const dom = domBySession.get(f.sessionKey) ?? new Map();
      const walk = (node: any, parent: number) => {
        let index = parent;
        const backend: number | undefined = node.backendDOMNodeId;
        const isRoot = node === root;
        if (!node.ignored || isRoot) {
          const identity = `${t.id}|${f.sessionKey}|${backend ?? `ax:${f.frameId}:${node.nodeId}`}`;
          out.push(normalise(node, parent, identity, backend !== undefined ? dom.get(backend) : undefined));
          index = out.length - 1;
          targets.set(identity, { sessionId: f.sessionKey || undefined, backendNodeId: backend, frameId: f.frameId });
        }
        for (const id of node.childIds ?? []) {
          const child = byId.get(id);
          if (child) walk(child, index);
        }
        if (backend !== undefined)
          for (const child of childrenOfOwner.get(`${f.sessionKey}|${backend}`) ?? []) emit(child, index, depth + 1);
      };
      walk(root, parentIndex);
    };
    emit(rootFrame, -1, 0);
    const snapshot: AXSnapshot = { tab: { id: t.id, title: header.title, url: header.url }, nodes: out };
    return { snapshot, targets };
  }

  private resolveElement(t: TabState, index: unknown): Target & { index: number } {
    const id = Number(index);
    if (!Number.isSafeInteger(id)) throw new BrowserError("An accessibility element index (number) is required.");
    if (!t.ax) throw new BrowserError(`Accessibility element ${id} is stale or missing. Call tab.ax.write() first.`);
    const identity = identityFor(t.ax.revision, id);
    const target = identity ? t.ax.targets.get(identity) : undefined;
    if (!target) throw new BrowserError(`Accessibility element ${id} is stale or missing. Call tab.ax.write() for current indices.`);
    if (!target.dialog && (t.dialog || t.ax.documentKey !== this.documentKey(t)))
      throw new BrowserError(`Accessibility element ${id} belongs to a previous page. Call tab.ax.write() for current indices.`);
    if (target.dialog && !t.dialog) throw new BrowserError(`Accessibility element ${id} belonged to a JavaScript dialog that is no longer open.`);
    return { ...target, index: id };
  }

  // ───────────────────────── actions (§3) ─────────────────────────

  private async withDialogRace<T>(t: TabState, label: string, run: () => Promise<T>): Promise<T> {
    let off = () => {};
    const dialog = new Promise<never>((_, reject) => {
      const w = (d: Dialog) => reject(new BrowserError(`Browser action ${label} was interrupted by a JavaScript ${d.type} dialog: ${JSON.stringify(d.message)}. The action may already have taken effect; do not retry it. Inspect or dismiss the dialog before continuing.`));
      t.dialogWaiters.add(w);
      off = () => t.dialogWaiters.delete(w);
    });
    try {
      return await Promise.race([run(), dialog]);
    } finally {
      off();
    }
  }

  /** Visible, hit-testable point for an element in top-level CSS px (Codex `iF`). */
  /** @internal */ async hitPoint(t: TabState, target: Target & { index: number | string }) {
    const measure = () => this.callOn(t, target, page.HIT_POINT);
    let r = await measure();
    if (r.status === "detached") throw new BrowserError(`Accessibility element ${target.index} is no longer in the page. Call tab.ax.write() for current indices.`);
    if (r.status !== "ok") {
      await this.cdp(t, "DOM.scrollIntoViewIfNeeded", { backendNodeId: target.backendNodeId }, { sessionId: target.sessionId }).catch((e) => {
        if (/layout object/i.test(String(e?.message))) throw new BrowserError(`Element ${target.index} couldn't be clicked. Try another element.`);
      });
      r = await measure();
    }
    if (r.status !== "ok") {
      await this.callOn(t, target, page.SCROLL_CENTER);
      let last = await measure();
      const deadline = Date.now() + C.hitSettleMs;
      while (Date.now() < deadline) {
        await sleep(C.hitSettlePollMs);
        const next = await measure();
        const stable = Math.abs((next.x ?? 0) - (last.x ?? 0)) <= C.hitSettlePx && Math.abs((next.y ?? 0) - (last.y ?? 0)) <= C.hitSettlePx;
        last = next;
        if (stable && next.status === "ok") break;
      }
      r = last;
    }
    if (r.status === "unpositioned") throw new BrowserError(`Element ${target.index} couldn't be clicked (it has no visible box). Try another element.`);
    const offset = await this.frameOffset(t, target.sessionId);
    return { ...r, x: r.x + offset.x, y: r.y + offset.y } as { status: string; x: number; y: number; width: number; height: number; coveredBy?: string };
  }

  /** Offset of an OOPIF's viewport in top-level coordinates (same-process frames need none). */
  private async frameOffset(t: TabState, sessionId?: string): Promise<{ x: number; y: number }> {
    let x = 0, y = 0;
    for (let s = sessionId, depth = 0; s && depth < 16; depth++) {
      const child = t.sessions.get(s);
      if (!child) break;
      const parent = child.parent;
      const owner = await this.cdp(t, "DOM.getFrameOwner", { frameId: child.targetId }, parent ? { sessionId: parent } : {});
      const o = await this.callOn(t, { sessionId: parent, backendNodeId: owner.backendNodeId }, page.FRAME_CONTENT_OFFSET);
      x += o.x; y += o.y;
      s = parent;
    }
    return { x, y };
  }

  private modifierBits(key?: string) {
    if (!key) return { bits: 0, down: [] as any[], up: [] as any[] };
    const ev = keyEventsFor(key, this.platform);
    const bits = (ev.down.at(-1)?.modifiers as number | undefined) ?? 0;
    return { bits, down: ev.down, up: ev.up };
  }

  /** @internal */ async mouseClick(t: TabState, x: number, y: number, opts: { button?: string; clickCount?: number; key?: string; duration?: number }) {
    const button = opts.button ?? "left";
    const buttons = button === "right" ? 2 : button === "middle" ? 4 : 1;
    const clicks = Math.max(1, Math.min(3, Number(opts.clickCount ?? 1)));
    const mods = this.modifierBits(opts.key);
    const modifiers = mods.bits;
    const hold = Math.max(0, Math.min(30, Number(opts.duration ?? 0))) * 1000;
    const moved = { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x, y, button: "none", modifiers } };
    if (!hold) {
      const cmds: Array<{ method: string; params: Record<string, unknown> }> = [...mods.down.map((p: any) => ({ method: "Input.dispatchKeyEvent", params: p })), moved];
      for (let k = 1; k <= clicks; k++) {
        cmds.push({ method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x, y, button, buttons, clickCount: k, modifiers } });
        cmds.push({ method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x, y, button, buttons: 0, clickCount: k, modifiers } });
      }
      cmds.push(...mods.up.map((p: any) => ({ method: "Input.dispatchKeyEvent", params: p })));
      await this.batch(t, cmds);
      return;
    }
    await this.batch(t, [...mods.down.map((p: any) => ({ method: "Input.dispatchKeyEvent", params: p })), moved]);
    try {
      for (let k = 1; k <= clicks; k++) {
        await this.cdp(t, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: k, modifiers });
        await sleep(hold);
        await this.cdp(t, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: k, modifiers });
      }
    } finally {
      await this.batch(t, mods.up.map((p: any) => ({ method: "Input.dispatchKeyEvent", params: p }))).catch(() => {});
    }
  }

  private async viewport(t: TabState) {
    const m = await this.cdp(t, "Page.getLayoutMetrics");
    return m.cssVisualViewport as { pageX: number; pageY: number; clientWidth: number; clientHeight: number; offsetX: number; offsetY: number };
  }

  private async point(t: TabState, target: unknown): Promise<{ x: number; y: number; width: number; height: number }> {
    if (Array.isArray(target)) {
      const [x, y] = target.map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new BrowserError("A point must be [x, y] in screenshot (CSS) pixels.");
      const vv = await this.viewport(t);
      if (x! < 0 || y! < 0 || x! > vv.clientWidth || y! > vv.clientHeight) throw new BrowserError(`Point [${x}, ${y}] is outside the ${Math.round(vv.clientWidth)}x${Math.round(vv.clientHeight)} viewport.`);
      return { x: x!, y: y!, width: vv.clientWidth, height: vv.clientHeight };
    }
    const el = this.resolveElement(t, target);
    const p = await this.hitPoint(t, el);
    return p;
  }

  private async focusElement(t: TabState, index: unknown, caretToEnd = true) {
    const el = this.resolveElement(t, index);
    if (el.dialog) return el;
    const deadline = Date.now() + 3000;
    for (;;) {
      const r = await this.callOn(t, el, page.FOCUS, { caretToEnd });
      if (r?.status === "ok") return el;
      if (Date.now() >= deadline) throw new BrowserError(`Could not focus accessibility element ${el.index} for input within 3000 ms. No input was sent.`);
      await sleep(100);
    }
  }

  /** @internal */ async typeInto(t: TabState, text: string) {
    await this.batch(t, typeTextEvents(text).map((params: any) => ({ method: "Input.dispatchKeyEvent", params })));
  }

  /** @internal */ async pressKey(t: TabState, key: string, duration = 0) {
    if (this.isClipboardChord(key)) return this.clipboardChord(t, key);
    const ev = keyEventsFor(key, this.platform);
    const toCmd = (params: any) => ({ method: "Input.dispatchKeyEvent", params });
    if (duration > 0) {
      await this.batch(t, ev.down.map(toCmd));
      await sleep(Math.min(30, duration) * 1000);
      await this.batch(t, ev.up.map(toCmd));
    } else await this.batch(t, [...ev.down, ...ev.up].map(toCmd));
  }

  private isClipboardChord(key: string) {
    const k = key.toLowerCase().replace(/\s+/g, "");
    const mod = this.platform === "mac" ? "(super|cmd|command|meta)" : "(ctrl|control)";
    return new RegExp(`^${mod}\\+[cvx]$`).test(k);
  }

  /** Virtual clipboard (Codex §3.4): never touches the OS clipboard. */
  private async clipboardChord(t: TabState, key: string) {
    const letter = key.toLowerCase().at(-1);
    const focused = { sessionId: undefined as string | undefined };
    if (letter === "v") {
      await this.evaluateFn(t, page.PASTE, { text: this.clipboard }, focused.sessionId);
      return;
    }
    const text = await this.evaluateFn(t, page.SELECTION_TEXT, null, focused.sessionId);
    this.clipboard = String(text ?? "");
    if (letter === "x") await this.cdp(t, "Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, commands: ["deleteForward"] })
      .then(() => this.cdp(t, "Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }));
  }

  private async evaluateFn(t: TabState, fn: string, arg: unknown, sessionId?: string) {
    const r = await this.cdp(t, "Runtime.evaluate", {
      expression: `(${fn}).call(document.activeElement || document.body, ${JSON.stringify(arg)})`,
      returnByValue: true, awaitPromise: true, userGesture: true,
    }, { sessionId });
    if (r.exceptionDetails) throw new BrowserError(exceptionText(r.exceptionDetails));
    return r.result?.value;
  }

  private async scroll(t: TabState, target: unknown, direction: string, pages = 1) {
    if (!["up", "down", "left", "right"].includes(direction)) throw new BrowserError('direction must be "up", "down", "left" or "right".');
    const p = await this.point(t, target);
    const vertical = direction === "up" || direction === "down";
    const distance = Math.max(vertical ? p.height : p.width, 100) * Math.max(0.1, Number(pages) || 1);
    const sign = direction === "up" || direction === "left" ? -1 : 1;
    await this.batch(t, [
      { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: p.x, y: p.y, button: "none" } },
      { method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: p.x, y: p.y, deltaX: vertical ? 0 : sign * distance, deltaY: vertical ? sign * distance : 0 } },
    ]);
  }

  private async handleDialogControl(t: TabState, target: Target, action: "click" | "set" | "key", value?: string) {
    const d = t.dialog;
    if (!d) throw new BrowserError("No JavaScript dialog is open.");
    if (action === "set") {
      if (target.dialog !== "prompt") throw new BrowserError("Only the prompt's text field accepts a value.");
      d.promptText = value ?? "";
      t.revision++;
      return;
    }
    if (target.dialog === "prompt") return;
    await this.cdp(t, "Page.handleJavaScriptDialog", { accept: target.dialog === "accept", ...(d.type === "prompt" && target.dialog === "accept" ? { promptText: d.promptText ?? "" } : {}) });
  }

  private async act(t: TabState, action: Record<string, any>) {
    const kind = String(action.kind);
    await this.ensureAttached(t);
    // Dialog handling: element indices of dialog controls, Return/Escape keys.
    if (t.dialog) {
      if (kind === "press_key" && /^(return|enter|kp_enter)$/i.test(action.key)) return this.handleDialogControl(t, { dialog: "accept" }, "click");
      if (kind === "press_key" && /^escape$/i.test(action.key)) return this.handleDialogControl(t, { dialog: t.dialog.type === "alert" ? "accept" : "dismiss" }, "click");
      const idx = action.element_index ?? (typeof action.target === "number" ? action.target : undefined);
      if (idx === undefined || idx === null) throw new BrowserError(`A JavaScript ${t.dialog.type} dialog is open. Use its element indices from tab.ax.write(), or press Return/Escape.`);
      const el = this.resolveElement(t, idx);
      if (!el.dialog) throw new BrowserError(`A JavaScript ${t.dialog.type} dialog is open; element ${el.index} is not one of its controls.`);
      if (kind === "set_value") return this.handleDialogControl(t, el, "set", String(action.value));
      if (kind === "type_text") return this.handleDialogControl(t, el, "set", (t.dialog.promptText ?? "") + String(action.text));
      return this.handleDialogControl(t, el, "click");
    }
    t.pending ??= this.navSnapshot(t);
    const label = kind;
    return this.withDialogRace(t, label, async () => {
      switch (kind) {
        case "click":
        case "perform_secondary_action": {
          let target = action.target ?? action.element_index;
          if (kind === "perform_secondary_action") {
            const el = this.resolveElement(t, action.element_index);
            const line = t.ax!.revision.lines.get(el.index) ?? "";
            const m = /Secondary Actions: ([^,\n]+)/.exec(line);
            const names = m ? m[1]!.split(/\s*\/\s*|\s*;\s*/) : [];
            if (!names.some((n) => n.trim().toLowerCase() === String(action.action).toLowerCase()))
              throw new BrowserError(`Element ${el.index} has no secondary action ${JSON.stringify(action.action)}${names.length ? ` (available: ${names.join(", ")})` : ""}.`);
            target = el.index;
          }
          if (!Array.isArray(target)) {
            const el = this.resolveElement(t, target);
            const opt = await this.callOn(t, el, page.SELECT_OPTION_IF_NATIVE);
            if (opt?.status === "option") return;
            if (opt?.status === "disabled") throw new BrowserError(`Option ${el.index} is disabled.`);
            const p = await this.hitPoint(t, el);
            const simple = (action.mouse_button ?? "left") === "left" && (action.click_count ?? 1) === 1 && !action.key && !action.duration;
            if (p.status !== "ok") {
              if (simple) {
                const r = await this.callOn(t, el, page.CLICK_FALLBACK);
                if (r?.status === "clicked" || r?.status === "focused") return;
              }
              throw new BrowserError(`Accessibility element ${el.index} is covered by ${p.coveredBy ?? "another element"} or otherwise not hittable. Close the covering element or try another element.`);
            }
            return this.mouseClick(t, p.x, p.y, { button: action.mouse_button, clickCount: action.click_count, key: action.key, duration: action.duration });
          }
          const p = await this.point(t, target);
          return this.mouseClick(t, p.x, p.y, { button: action.mouse_button, clickCount: action.click_count, key: action.key, duration: action.duration });
        }
        case "hover": {
          const p = await this.point(t, action.target);
          return this.cdp(t, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none" });
        }
        case "set_value": {
          const el = this.resolveElement(t, action.element_index);
          if (isSettable(t.ax!.revision, el.index) === false) {
            // Still try: renderer settability is advisory; the page decides.
          }
          const r = await this.callOn(t, el, page.SET_VALUE, { value: action.value });
          if (r?.status === "needs-click") {
            const p = await this.hitPoint(t, el);
            await this.mouseClick(t, p.x, p.y, {});
            return;
          }
          if (r?.status !== "ok") throw new BrowserError(`Accessibility element ${el.index} ${r?.message ?? "rejected the value"}.`);
          return;
        }
        case "type_text": {
          const text = String(action.text ?? "");
          if (action.element_index !== null && action.element_index !== undefined) await this.focusElement(t, action.element_index);
          return this.typeInto(t, text);
        }
        case "paste": {
          if (action.element_index !== null && action.element_index !== undefined) await this.focusElement(t, action.element_index);
          const r = await this.evaluateFn(t, page.PASTE, { text: String(action.text ?? ""), ...(action.format === "html" ? { html: String(action.text ?? "") } : {}) });
          if (r?.status === "not_inserted") throw new BrowserError("Paste was not accepted by the focused element.");
          return;
        }
        case "press_key": {
          if (action.element_index !== null && action.element_index !== undefined) await this.focusElement(t, action.element_index, false);
          return this.pressKey(t, String(action.key), Number(action.duration ?? 0));
        }
        case "scroll":
          return this.scroll(t, action.target, String(action.direction ?? "down"), action.pages ?? 1);
        case "select_text": {
          const el = this.resolveElement(t, action.element_index);
          const r = await this.callOn(t, el, page.SELECT_TEXT, { text: String(action.text), prefix: action.prefix, suffix: action.suffix, selectionType: action.selection_type });
          if (r?.status !== "ok") throw new BrowserError(`select_text on element ${el.index}: ${r?.message ?? "failed"}.`);
          return;
        }
        case "drag": {
          const a = await this.point(t, action.from), b = await this.point(t, action.to);
          const cmds: Array<{ method: string; params: Record<string, unknown> }> = [
            { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: a.x, y: a.y, button: "none" } },
            { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: a.x, y: a.y, button: "left", buttons: 1, clickCount: 1 } },
          ];
          for (let i = 1; i <= 8; i++)
            cmds.push({ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8, button: "left", buttons: 1 } });
          cmds.push({ method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 } });
          return this.batch(t, cmds);
        }
        default:
          throw new BrowserError(`Unknown action kind ${JSON.stringify(kind)}.`);
      }
    });
  }

  // ───────────────────────── screenshots (§5) ─────────────────────────

  /** @internal */ async screenshot(t: TabState, opts: { fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } } = {}) {
    await this.ensureAttached(t);
    if (t.dialog) throw new BrowserError(`Screenshot unavailable while a JavaScript ${t.dialog.type} dialog is open. Use tab.ax.write() and tab.ax.click(index) to handle it.`);
    const vv = await this.viewport(t);
    const dpr = Number(await this.evaluateValue(t, "window.devicePixelRatio").catch(() => 1)) || 1;
    if (opts.fullPage || opts.clip) {
      const m = await this.cdp(t, "Page.getLayoutMetrics");
      const clip = opts.clip
        ? { ...opts.clip, x: opts.clip.x + vv.pageX, y: opts.clip.y + vv.pageY, scale: 1 }
        : { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 16384), scale: 1 / dpr };
      const r = await this.cdp(t, "Page.captureScreenshot", { format: "jpeg", quality: 80, captureBeyondViewport: true, clip }, { timeoutMs: 15000 });
      return { data: r.data as string, mimeType: "image/jpeg", width: Math.round(clip.width), height: Math.round(clip.height) };
    }
    const width = Math.round(vv.clientWidth), height = Math.round(vv.clientHeight);
    const frame = await this.screencastFrame(t, width, height).catch(() => null);
    if (frame) return { data: frame, mimeType: "image/jpeg", width, height };
    const r = await this.cdp(t, "Page.captureScreenshot", {
      format: "jpeg", quality: 80, clip: { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight, scale: 1 / dpr },
    }, { timeoutMs: C.screenshotMs });
    return { data: r.data as string, mimeType: "image/jpeg", width, height };
  }

  private async screencastFrame(t: TabState, width: number, height: number): Promise<string> {
    const startSeq = t.sequence;
    await this.cdp(t, "Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
    try {
      const deadline = Date.now() + C.screencastMs;
      while (Date.now() < deadline) {
        const ev = t.events.find((e) => e.sequence > startSeq && e.method === "Page.screencastFrame" && !e.sessionId);
        if (ev) {
          const p = ev.params as any;
          void this.cdp(t, "Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
          return p.data;
        }
        await this.waitEvent(t, Math.max(1, deadline - Date.now()));
      }
      throw new BrowserError("No screencast frame.");
    } finally {
      void this.cdp(t, "Page.stopScreencast").catch(() => {});
      t.events = t.events.filter((e) => e.method !== "Page.screencastFrame");
    }
  }

  /** @internal */ waitEvent(t: TabState, ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); t.eventWaiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      t.eventWaiters.add(done);
    });
  }

  // ───────────────────────── host ops (§4 op list) ─────────────────────────

  async execute(op: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    switch (op) {
      case "nameSession":
        await this.port.call("name", { name: String(args.name ?? "").slice(0, 55) }, signal);
        return null;
      case "tabs.list": {
        const { tabs } = await this.port.call("listTabs", {}, signal);
        for (const tab of tabs as TabInfo[]) this.remember(tab);
        return tabs;
      }
      case "tabs.new": {
        const { tab } = await this.port.call("createTab", {}, signal);
        this.remember(tab);
        if (typeof args.url === "string" && args.url) {
          const t = this.state(tab.id);
          await this.goto(t, args.url, Number(args.timeoutMs ?? C.gotoMs));
          return { ...tab, url: t.url ?? args.url };
        }
        return tab;
      }
      case "tabs.get":
        return this.tabInfo(this.tab({ tab: args.id }), signal);
      case "user.openTabs":
        return (await this.port.call("userTabs", {}, signal)).tabs as UserTabInfo[];
      case "user.claimTab": {
        const { tab } = await this.port.call("claimTab", { tabId: Number(args.id) }, signal);
        return this.remember(tab);
      }
      case "chrome":
        return this.port.call("chrome", { namespace: args.namespace, method: args.method, args: args.args ?? [] }, signal);
    }
    const t = this.tab(args);
    switch (op) {
      case "tab.info":
        return this.tabInfo(t, signal);
      case "tab.goto":
        await this.goto(t, String(args.url), Number(args.timeoutMs ?? C.gotoMs));
        return null;
      case "tab.back":
        await this.history(t, -1);
        return null;
      case "tab.forward":
        await this.history(t, 1);
        return null;
      case "tab.reload":
        t.pending ??= this.navSnapshot(t);
        await this.cdp(t, "Page.reload", {});
        await poll(() => !t.loading && t.committed, C.gotoMs, 25);
        return null;
      case "tab.close":
        await this.port.call("closeTab", { tabId: t.id }, signal);
        this.tabs.delete(t.id);
        this.known.delete(t.id);
        return null;
      case "tab.show":
        await this.port.call("showTab", { tabId: t.id }, signal);
        return null;
      case "tab.mark":
        await this.port.call("markTab", { tabId: t.id, mark: args.mark ?? null }, signal);
        return null;
      case "tab.screenshot":
        return this.serial(t, () => this.settle(t).then(() => this.screenshot(t, { fullPage: !!args.fullPage, clip: args.clip as any })));
      case "tab.ax.get": {
        const mode = String(args.mode ?? "state");
        if (!["state", "screenshot", "both"].includes(mode)) throw new BrowserError('mode must be "state", "screenshot" or "both".');
        return this.serial(t, async () => {
          const out: { state?: string; screenshot?: { data: string; mimeType: string; width: number; height: number } } = {};
          if (mode !== "screenshot") out.state = await this.captureState(t, !!args.disableDiffing);
          else {
            await this.ensureAttached(t);
            const s = t.pending; t.pending = undefined;
            if (s) { await sleep(250); if (t.loading || t.navigationRevision !== s.navigationRevision) { t.pending = s; await this.settle(t); } }
          }
          if (mode !== "state") {
            try { out.screenshot = await this.screenshot(t); }
            catch (error) { if (mode === "screenshot") throw error; }
          }
          return out;
        });
      }
      case "tab.ax.action":
        return this.serial(t, async () => {
          try {
            await this.act(t, (args.action ?? {}) as Record<string, any>);
            return null;
          } catch (error) {
            // Preparation errors carry fresh state so the model needn't make another call (Codex Ro).
            if (error instanceof BrowserError && /stale or missing|previous page|not hittable|couldn't be clicked|no longer in the page|Could not focus/.test(error.message)) {
              const state = await this.captureState(t).catch(() => null);
              if (state) throw new BrowserError(`${error.message}\n\n${state}`);
            }
            throw error;
          }
        });
      case "tab.evaluate":
        return this.evaluate(t, args);
      case "tab.pw":
        return this.playwright.execute(t, args);
      case "tab.cdp":
        return this.cdp(t, String(args.method), (args.params ?? {}) as Record<string, unknown>, { sessionId: args.sessionId as string | undefined, timeoutMs: args.timeoutMs as number | undefined });
      case "tab.cdp.events":
        return this.readEvents(t, args);
      case "tab.setFiles": {
        const el = this.resolveElement(t, args.element_index);
        const paths = (args.paths as unknown[] | undefined)?.map(String) ?? [];
        await this.cdp(t, "DOM.setFileInputFiles", { files: paths, backendNodeId: el.backendNodeId }, { sessionId: el.sessionId });
        return null;
      }
      case "tab.dialog":
        await this.ensureAttached(t);
        return t.dialog ? { type: t.dialog.type, message: t.dialog.message, defaultPrompt: t.dialog.defaultPrompt ?? null } : null;
      case "tab.handleDialog":
        await this.ensureAttached(t);
        if (!t.dialog) throw new BrowserError("No JavaScript dialog is open.");
        await this.cdp(t, "Page.handleJavaScriptDialog", { accept: !!args.accept, ...(typeof args.promptText === "string" ? { promptText: args.promptText } : {}) });
        return null;
      case "tab.waitForLoad":
        return this.waitForLoad(t, String(args.state ?? "load"), Number(args.timeoutMs ?? C.gotoMs));
    }
    throw new BrowserError(`Unknown browser operation ${JSON.stringify(op)}.`);
  }

  /** Serialise state reads and input per tab (Codex pendingInput chain). */
  /** @internal */ serial<T>(t: TabState, fn: () => Promise<T>): Promise<T> {
    const next = t.input.catch(() => {}).then(fn);
    t.input = next;
    return next;
  }

  private async tabInfo(t: TabState, signal?: AbortSignal): Promise<TabInfo> {
    const { tabs } = await this.port.call("listTabs", {}, signal);
    const info = (tabs as TabInfo[]).find((x) => x.id === t.id);
    if (!info) throw new BrowserError(`Tab ${t.id} is no longer part of this browser session.`);
    return this.remember(info);
  }

  private async evaluate(t: TabState, args: Record<string, unknown>) {
    const arg = args.arg ?? null;
    if (args.elementIndex !== undefined && args.elementIndex !== null) {
      const el = this.resolveElement(t, args.elementIndex);
      return this.callOn(t, el, String(args.functionDeclaration ?? args.expression), arg);
    }
    const expression = args.functionDeclaration
      ? `(${String(args.functionDeclaration)})(${JSON.stringify(arg)})`
      : String(args.expression ?? "undefined");
    const r = await this.cdp(t, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true, replMode: true });
    if (r.exceptionDetails) throw new BrowserError(exceptionText(r.exceptionDetails));
    return r.result?.value ?? (r.result?.type === "undefined" ? undefined : r.result?.description ?? null);
  }

  private async readEvents(t: TabState, args: Record<string, unknown>) {
    await this.ensureAttached(t);
    const after = args.afterSequence === undefined ? t.sequence : Number(args.afterSequence);
    const methods = Array.isArray(args.methods) ? new Set(args.methods.map(String)) : null;
    const limit = Math.max(1, Math.min(1000, Number(args.limit ?? 100)));
    const match = () => t.events.filter((e) => e.sequence > after && (!methods || methods.has(e.method)));
    const timeoutMs = Math.max(0, Math.min(60000, Number(args.timeoutMs ?? 0)));
    const deadline = Date.now() + timeoutMs;
    while (!match().length && Date.now() < deadline) await this.waitEvent(t, deadline - Date.now());
    const all = match();
    const events = all.slice(0, limit);
    return {
      cursor: events.at(-1)?.sequence ?? Math.max(after, 0),
      events,
      hasMore: all.length > limit,
      truncated: (t.events[0]?.sequence ?? 1) > after + 1 && after > 0,
    };
  }

  private async waitForLoad(t: TabState, state: string, timeoutMs: number) {
    await this.ensureAttached(t);
    const ok = await poll(() => {
      if (state === "domcontentloaded") return !t.loading && t.committed;
      if (state === "networkidle") return t.lifecycle.has("networkIdle");
      return t.complete;
    }, timeoutMs, 25);
    if (!ok) throw new BrowserError(`Timed out after ${timeoutMs} ms waiting for ${state}.`);
    return null;
  }
}

// ───────────────────────── helpers ─────────────────────────

interface DomMeta { tagName: string; id: string | null; inputType: string | null }

function domMetadata(snap: any): Map<number, DomMeta> {
  const map = new Map<number, DomMeta>();
  const strings: string[] = snap.strings ?? [];
  for (const doc of snap.documents ?? []) {
    const nodes = doc.nodes ?? {};
    const ids: number[] = nodes.backendNodeId ?? [];
    const names: number[] = nodes.nodeName ?? [];
    const attrs: number[][] = nodes.attributes ?? [];
    for (let i = 0; i < ids.length; i++) {
      const tagName = (strings[names[i]!] ?? "").toLowerCase();
      if (!tagName || tagName.startsWith("#")) continue;
      let id: string | null = null, inputType: string | null = null;
      const a = attrs[i] ?? [];
      for (let j = 0; j + 1 < a.length; j += 2) {
        const name = strings[a[j]!];
        if (name === "id") id = strings[a[j + 1]!] ?? null;
        else if (name === "type") inputType = (strings[a[j + 1]!] ?? "").toLowerCase();
      }
      map.set(ids[i]!, { tagName, id, inputType });
    }
  }
  return map;
}

function normalise(node: any, parentIndex: number, identity: string, meta?: DomMeta): AXInputNode {
  const properties: Record<string, unknown> = {};
  for (const p of node.properties ?? []) {
    if (!AX_PROPERTIES.has(p.name) || NO_RELATED.has(p.name)) continue;
    properties[p.name] = p.value?.value;
  }
  let nameSource: AXInputNode["nameSource"] = null;
  for (const s of node.name?.sources ?? []) {
    if (s.superseded || !s.value || s.value.value === "" || s.value.value === undefined) continue;
    nameSource = s.type === "contents" ? "contents" : s.type === "placeholder" ? "placeholder" : s.type === "relatedElement" ? "relatedElement" : s.type === "attribute" ? (s.attribute === "placeholder" ? "placeholder" : "attribute") : null;
    break;
  }
  const value = node.value?.value;
  return {
    parentIndex,
    identity,
    role: String(node.role?.value ?? "generic"),
    name: node.name?.value ?? null,
    nameSource,
    description: node.description?.value ?? null,
    value: value === undefined ? null : value,
    properties,
    dom: meta ? { tagName: meta.tagName, id: meta.id, inputType: meta.inputType } : undefined,
  };
}

function exceptionText(d: any): string {
  const e = d.exception;
  return (e?.description ?? e?.value ?? d.text ?? "Page script threw an exception").toString().slice(0, 4000);
}

export const BROWSER_DISPLAY_LIMIT = C.maxDisplay;
