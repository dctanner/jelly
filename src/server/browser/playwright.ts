/**
 * Playwright-style locators for `tab.playwright` (Codex analysis §9): not real Playwright.
 * Playwright's own InjectedScript (selector engines, strict mode, actionability states,
 * fill/selectOptions, aria snapshots) is injected into an isolated world per frame;
 * input goes through the engine's CDP mouse/keyboard code, as in Codex.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { BrowserEngine, TabState, Target } from "./engine";
import { BrowserError } from "./types";

const WORLD = "__jelly_playwright";
const DEFAULT_TIMEOUT = 3000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let injectedSource: string | undefined;
/** Playwright's InjectedScript bundle, read from the installed playwright-core (Apache-2.0). */
export function playwrightInjectedSource(): string {
  if (injectedSource) return injectedSource;
  const require = createRequire(import.meta.url);
  const bundle = readFileSync(require.resolve("playwright-core/lib/coreBundle.js"), "utf8");
  const marker = bundle.indexOf("/generated/injectedScriptSource.ts");
  const start = bundle.indexOf("= '", marker);
  const end = bundle.indexOf("\n  }\n});", start);
  if (marker < 0 || start < 0 || end < 0) throw new Error("Playwright injected script not found in playwright-core.");
  const literal = bundle.slice(start + 2, end).trim().replace(/;$/, "");
  const source = new Function(`return ${literal}`)() as string;
  if (typeof source !== "string" || !source.includes("InjectedScript")) throw new Error("Unexpected playwright-core injected script format.");
  return (injectedSource = source);
}

interface FrameRef { sessionId?: string; frameId: string }
interface Ctx extends FrameRef { contextId: number; seq: number }
interface PwTabState { contexts: Map<string, Ctx>; seqs: Map<string, number>; bySeq: Map<number, FrameRef>; nextSeq: number; chooser?: { since: number; armed: boolean }; download?: { since: number } }

export interface LocatorSpec { frames: string[]; selector: string }

class Retry extends Error {}

export class PlaywrightLayer {
  private tabs = new WeakMap<TabState, PwTabState>();
  constructor(private e: BrowserEngine) {}

  private pw(t: TabState): PwTabState {
    let s = this.tabs.get(t);
    if (!s) this.tabs.set(t, (s = { contexts: new Map(), seqs: new Map(), bySeq: new Map(), nextSeq: 1 }));
    return s;
  }

  // ───────────── frame contexts ─────────────

  private seqFor(t: TabState, f: FrameRef) {
    const s = this.pw(t);
    const key = `${f.sessionId ?? ""}|${f.frameId}`;
    let seq = s.seqs.get(key);
    if (seq === undefined) {
      seq = f.frameId === t.mainFrameId && !f.sessionId ? 0 : s.nextSeq++;
      s.seqs.set(key, seq);
      s.bySeq.set(seq, f);
    }
    return seq;
  }

  /** Isolated world with Playwright's InjectedScript as `globalThis.__jellyPW`. */
  private async context(t: TabState, f: FrameRef): Promise<Ctx> {
    const s = this.pw(t);
    const key = `${f.sessionId ?? ""}|${f.frameId}`;
    const cached = s.contexts.get(key);
    if (cached) {
      try {
        const r = await this.e.cdp(t, "Runtime.evaluate", { expression: "!!globalThis.__jellyPW", contextId: cached.contextId, returnByValue: true }, { sessionId: f.sessionId });
        if (r.result?.value === true) return cached;
      } catch {}
      s.contexts.delete(key);
    }
    const seq = this.seqFor(t, f);
    const { executionContextId } = await this.e.cdp(t, "Page.createIsolatedWorld", { frameId: f.frameId, worldName: WORLD, grantUniveralAccess: true }, { sessionId: f.sessionId });
    const options = { isUnderTest: false, sdkLanguage: "javascript", frameSeq: seq, testIdAttributeName: "data-testid", stableRafCount: 1, browserName: "chromium", shouldPrependErrorPrefix: false, isUtilityWorld: true, customEngines: [] };
    const expression = `(() => { const module = {};\n${playwrightInjectedSource()}\nglobalThis.__jellyPW = new (module.exports.InjectedScript())(globalThis, ${JSON.stringify(options)}); return true; })()`;
    const r = await this.e.cdp(t, "Runtime.evaluate", { expression, contextId: executionContextId, returnByValue: true }, { sessionId: f.sessionId, timeoutMs: 10000 });
    if (r.exceptionDetails) throw new BrowserError(`Could not inject Playwright selectors: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    const ctx = { ...f, contextId: executionContextId, seq };
    s.contexts.set(key, ctx);
    return ctx;
  }

  /** Run `body` (JS using `pw`, `arg`) in a frame's isolated world. Throws page errors as BrowserError. */
  private async run(t: TabState, ctx: Ctx, body: string, arg: unknown = null, returnByValue = true): Promise<any> {
    const expression = `(async (pw, arg) => { ${body} })(globalThis.__jellyPW, ${JSON.stringify(arg)})`;
    const r = await this.e.cdp(t, "Runtime.evaluate", { expression, contextId: ctx.contextId, returnByValue, awaitPromise: true, userGesture: true }, { sessionId: ctx.sessionId });
    if (r.exceptionDetails) {
      const message = String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "Page script failed").split("\n    at ")[0]!;
      if (/Cannot find context|Execution context was destroyed/.test(message)) throw new Retry(message);
      throw new BrowserError(message.replace(/^Error: /, ""));
    }
    return returnByValue ? r.result?.value : r.result;
  }

  private mainFrame(t: TabState): FrameRef {
    if (!t.mainFrameId) throw new Retry("waiting for the page");
    return { frameId: t.mainFrameId };
  }

  /** Resolve the frame a locator lives in (frameLocator hops, or an aria-ref frame prefix). */
  private async frameFor(t: TabState, loc: LocatorSpec): Promise<Ctx> {
    let frame = this.mainFrame(t);
    const ref = /^aria-ref=f(\d+)e\d+$/.exec(loc.selector.trim());
    if (ref && !loc.frames.length) {
      const f = this.pw(t).bySeq.get(Number(ref[1]));
      if (!f) throw new BrowserError(`Unknown aria-ref frame f${ref[1]}; call tab.playwright.domSnapshot() again.`);
      frame = f;
    }
    let ctx = await this.context(t, frame);
    for (const frameSelector of loc.frames) {
      const found = await this.run(t, ctx, `
        const parsed = pw.parseSelector(arg);
        const els = pw.querySelectorAll(parsed, document);
        if (!els.length) return { retry: "waiting for frame " + arg };
        if (els.length > 1) throw pw.strictModeViolationError(parsed, els);
        const el = els[0];
        if (!/^(IFRAME|FRAME)$/.test(el.nodeName)) throw new Error("Selector " + arg + " does not resolve to an <iframe>");
        globalThis.__jellyPWFrame = el;
        return { ok: true };`, frameSelector);
      if (found?.retry) throw new Retry(found.retry);
      const owner = await this.e.cdp(t, "Runtime.evaluate", { expression: "globalThis.__jellyPWFrame", contextId: ctx.contextId }, { sessionId: ctx.sessionId });
      const { node } = await this.e.cdp(t, "DOM.describeNode", { objectId: owner.result.objectId }, { sessionId: ctx.sessionId });
      const frameId: string | undefined = node.frameId ?? node.contentDocument?.frameId;
      if (!frameId) throw new Retry(`waiting for frame ${frameSelector} to load`);
      const oopif = [...t.sessions.values()].find((s) => s.targetId === frameId);
      frame = oopif ? { sessionId: oopif.sessionId, frameId } : { sessionId: ctx.sessionId, frameId };
      ctx = await this.context(t, frame);
    }
    return ctx;
  }

  /** Strictly resolve one element satisfying `states`, with Playwright-style auto-wait. */
  private async element(t: TabState, loc: LocatorSpec, states: string[], timeoutMs: number, label: string): Promise<{ ctx: Ctx; target: Target & { index: string } }> {
    return this.retrying(timeoutMs, label, loc, async () => {
      const ctx = await this.frameFor(t, loc);
      const r = await this.run(t, ctx, `
        const parsed = pw.parseSelector(arg.selector);
        const els = pw.querySelectorAll(parsed, document);
        if (!els.length) return { retry: "waiting for " + arg.selector };
        if (els.length > 1) throw pw.strictModeViolationError(parsed, els);
        const el = els[0];
        for (const state of arg.states) {
          const s = pw.elementState(el, state);
          if (!s.matches) return { retry: "element is not " + state + (s.received && s.received !== state ? " (" + s.received + ")" : "") };
        }
        globalThis.__jellyPWTarget = el;
        return { ok: true, preview: pw.previewNode(el) };`, { selector: loc.selector, states });
      if (r?.retry) throw new Retry(r.retry);
      const handle = await this.e.cdp(t, "Runtime.evaluate", { expression: "globalThis.__jellyPWTarget", contextId: ctx.contextId }, { sessionId: ctx.sessionId });
      const { node } = await this.e.cdp(t, "DOM.describeNode", { objectId: handle.result.objectId }, { sessionId: ctx.sessionId });
      void this.e.cdp(t, "Runtime.releaseObject", { objectId: handle.result.objectId }, { sessionId: ctx.sessionId }).catch(() => {});
      return { ctx, target: { sessionId: ctx.sessionId, backendNodeId: node.backendNodeId, frameId: ctx.frameId, index: r.preview } };
    });
  }

  private async retrying<T>(timeoutMs: number, label: string, loc: LocatorSpec | null, fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    const log: string[] = [];
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (!(error instanceof Retry)) throw error;
        if (log.at(-1) !== error.message) log.push(error.message);
        if (Date.now() >= deadline) {
          const where = loc ? `${loc.frames.map((f) => `frameLocator(${JSON.stringify(f)}).`).join("")}locator(${JSON.stringify(loc.selector)})` : "";
          throw new BrowserError(`${label}: Timeout ${timeoutMs}ms exceeded.${where ? `\nLocator: ${where}` : ""}\nCall log:\n${log.slice(-6).map((l) => `  - ${l}`).join("\n")}`);
        }
        await sleep([0, 20, 50, 100, 100, 250][Math.min(attempt, 5)]!);
      }
    }
  }

  // ───────────── actions ─────────────

  private async click(t: TabState, loc: LocatorSpec, o: Record<string, any>, label: string) {
    const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT;
    const deadline = Date.now() + timeoutMs;
    await this.retrying(timeoutMs, label, loc, async () => {
      const { target } = await this.element(t, loc, o.force ? [] : ["visible", "enabled"], Math.max(0, deadline - Date.now()), label);
      let p;
      try { p = await this.e.hitPoint(t, target); }
      catch (error) { throw new Retry(String((error as Error).message).replace(/Accessibility element .*? (is|couldn't)/, "element $1")); }
      if (p.status !== "ok" && !o.force) throw new Retry(`${target.index} intercepts pointer events: covered by ${p.coveredBy ?? "another element"}`);
      const x = o.position ? p.x - p.width / 2 + Number(o.position.x) : p.x;
      const y = o.position ? p.y - p.height / 2 + Number(o.position.y) : p.y;
      if (o.hover) return this.e.cdp(t, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
      const modifiers = (o.modifiers as string[] | undefined)?.map((m) => this.key(m)).join("+");
      await this.e.mouseClick(t, x, y, { button: o.button, clickCount: o.clickCount, key: modifiers || undefined, duration: o.delay ? Number(o.delay) / 1000 : undefined });
    });
  }

  private key(k: string) {
    return k.replace(/ControlOrMeta/g, this.e.platform === "mac" ? "Meta" : "Control");
  }

  private async focus(t: TabState, loc: LocatorSpec, timeoutMs: number, label: string) {
    const { ctx } = await this.element(t, loc, [], timeoutMs, label);
    const r = await this.run(t, ctx, `return pw.focusNode(globalThis.__jellyPWTarget, true);`);
    if (r !== "done") throw new BrowserError(`${label}: ${r}`);
  }

  private async setChecked(t: TabState, loc: LocatorSpec, checked: boolean, o: Record<string, any>, label: string) {
    const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT;
    const state = async () => {
      const { ctx } = await this.element(t, loc, [], timeoutMs, label);
      const s = await this.run(t, ctx, `return pw.elementState(globalThis.__jellyPWTarget, "checked");`);
      if (s?.received === "error:notcheckbox") throw new BrowserError(`${label}: Not a checkbox or radio button`);
      return s?.received === "checked";
    };
    if ((await state()) === checked) return;
    await this.click(t, loc, o, label);
    if ((await state()) !== checked) throw new BrowserError(`${label}: Clicking the checkbox did not change its state`);
  }

  async execute(t: TabState, args: Record<string, any>): Promise<unknown> {
    const action = String(args.action);
    const loc: LocatorSpec = { frames: (args.frames ?? []).map(String), selector: String(args.selector ?? "") };
    const o: Record<string, any> = args.options ?? {};
    const timeoutMs = Number(o.timeoutMs ?? DEFAULT_TIMEOUT);
    const label = `locator.${action}`;
    await this.e.ensureAttached(t);
    const input = <T>(fn: () => Promise<T>) => this.e.serial(t, () => { t.pending ??= this.e.navSnapshot(t); return fn(); });
    switch (action) {
      // ── element actions (auto-wait, strict, CDP input) ──
      case "click":
        return input(() => this.click(t, loc, o, label)).then(() => null);
      case "dblclick":
        return input(() => this.click(t, loc, { ...o, clickCount: 2 }, label)).then(() => null);
      case "hover":
        return input(() => this.click(t, loc, { ...o, hover: true }, label)).then(() => null);
      case "fill":
        return input(async () => {
          const { ctx } = await this.element(t, loc, o.force ? [] : ["visible", "enabled", "editable"], timeoutMs, label);
          const r = await this.run(t, ctx, `return pw.fill(globalThis.__jellyPWTarget, arg);`, String(args.value ?? ""));
          if (r === "needsinput") {
            if (args.value) await this.e.cdp(t, "Input.insertText", { text: String(args.value) });
            else await this.e.pressKey(t, "Delete");
          } else if (r !== "done") throw new BrowserError(`${label}: ${r}`);
          return null;
        });
      case "type":
      case "pressSequentially":
        return input(async () => {
          await this.focus(t, loc, timeoutMs, label);
          await this.e.typeInto(t, String(args.value ?? ""));
          return null;
        });
      case "press":
        return input(async () => {
          await this.focus(t, loc, timeoutMs, label);
          await this.e.pressKey(t, this.key(String(args.value)));
          return null;
        });
      case "check":
      case "uncheck":
      case "setChecked":
        return input(() => this.setChecked(t, loc, action === "check" ? true : action === "uncheck" ? false : !!args.value, o, label)).then(() => null);
      case "selectOption":
        return input(() => this.retrying(timeoutMs, label, loc, async () => {
          const { ctx } = await this.element(t, loc, ["visible", "enabled"], timeoutMs, label);
          const values = (Array.isArray(args.value) ? args.value : [args.value]).map((v: unknown) =>
            typeof v === "string" ? { valueOrLabel: v } : v);
          const r = await this.run(t, ctx, `return pw.selectOptions(globalThis.__jellyPWTarget, arg);`, values);
          if (r === "error:optionsnotfound" || r === "error:optionnotenabled") throw new Retry(r === "error:optionsnotfound" ? "did not find some options" : "option being selected is not enabled");
          if (typeof r === "string") throw new BrowserError(`${label}: ${r}`);
          return r as string[];
        }));
      case "selectText":
        return input(async () => {
          const { ctx } = await this.element(t, loc, ["visible"], timeoutMs, label);
          await this.run(t, ctx, `return pw.selectText(globalThis.__jellyPWTarget);`);
          return null;
        });
      case "setInputFiles":
        return input(async () => {
          const { target } = await this.element(t, loc, [], timeoutMs, label);
          await this.e.cdp(t, "DOM.setFileInputFiles", { files: (Array.isArray(args.value) ? args.value : [args.value]).map(String), backendNodeId: target.backendNodeId }, { sessionId: target.sessionId });
          return null;
        });
      case "waitFor": {
        const state = String(o.state ?? "visible");
        const want = state === "attached" ? "count > 0" : state === "detached" ? "count === 0" : state === "visible" ? "visible" : "!visible";
        return this.retrying(timeoutMs, "locator.waitFor", loc, async () => {
          const ctx = await this.frameFor(t, loc);
          const ok = await this.run(t, ctx, `
            const parsed = pw.parseSelector(arg.selector);
            const els = pw.querySelectorAll(parsed, document);
            const count = els.length;
            if (count > 1 && (arg.state === "visible" || arg.state === "hidden")) throw pw.strictModeViolationError(parsed, els);
            const visible = count === 1 && pw.elementState(els[0], "visible").matches;
            return ${want};`, { selector: loc.selector, state });
          if (!ok) throw new Retry(`waiting for ${loc.selector} to be ${state}`);
          return null;
        });
      }
      // ── queries ──
      case "count":
        return this.retrying(timeoutMs, label, loc, async () => this.run(t, await this.frameFor(t, loc), `return pw.querySelectorAll(pw.parseSelector(arg), document).length;`, loc.selector));
      case "isVisible":
      case "isEnabled":
        return this.retrying(timeoutMs, label, loc, async () => this.run(t, await this.frameFor(t, loc), `
          const parsed = pw.parseSelector(arg.selector);
          const els = pw.querySelectorAll(parsed, document);
          if (els.length > 1) throw pw.strictModeViolationError(parsed, els);
          return !!els.length && pw.elementState(els[0], arg.state).matches;`, { selector: loc.selector, state: action === "isVisible" ? "visible" : "enabled" }));
      case "textContent":
      case "innerText":
      case "getAttribute":
      case "innerHTML":
      case "inputValue": {
        const { ctx } = await this.element(t, loc, [], timeoutMs, label);
        return this.run(t, ctx, `
          const el = globalThis.__jellyPWTarget;
          switch (arg.action) {
            case "textContent": return el.textContent;
            case "innerText": return el.innerText;
            case "innerHTML": return el.innerHTML;
            case "inputValue": return "value" in el ? el.value : null;
            default: return el.getAttribute(arg.name);
          }`, { action, name: args.value });
      }
      case "allTextContents":
      case "allInnerTexts":
        return this.retrying(timeoutMs, label, loc, async () => this.run(t, await this.frameFor(t, loc), `
          return pw.querySelectorAll(pw.parseSelector(arg.selector), document).map((e) => arg.inner ? e.innerText : e.textContent ?? "");`,
          { selector: loc.selector, inner: action === "allInnerTexts" }));
      case "evaluate": {
        const { target } = await this.element(t, loc, [], timeoutMs, label);
        return this.e.callOn(t, target, `function (arg) { return (${String(args.fn)})(this, arg); }`, args.arg ?? null);
      }
      case "evaluateAll":
        return this.retrying(timeoutMs, label, loc, async () => this.run(t, await this.frameFor(t, loc), `
          const els = pw.querySelectorAll(pw.parseSelector(arg.selector), document);
          return await (${String(args.fn)})(els, arg.arg);`, { selector: loc.selector, arg: args.arg ?? null }));
      case "downloadMedia":
        return this.downloadMedia(t, loc, o, timeoutMs, label);
      // ── page-level ──
      case "domSnapshot":
        return this.domSnapshot(t);
      case "elementInfo":
        return this.elementsAt(t, Number(o.x), Number(o.y), !!o.includeNonInteractable);
      case "elementScreenshot":
        return this.elementScreenshot(t, Number(o.x), Number(o.y), !!o.includeNonInteractable);
      case "waitForURL":
        return this.waitForURL(t, args, timeoutMs);
      case "navState":
        return { navigationRevision: t.navigationRevision, revision: t.revision, url: t.url };
      case "waitForNavigation": {
        const since = Number(args.since ?? -1);
        await this.retrying(timeoutMs || 10000, "expectNavigation", null, async () => {
          if (t.navigationRevision <= since && !t.loading) throw new Retry("waiting for navigation");
          return null;
        });
        if (args.url) await this.waitForURL(t, args, timeoutMs || 10000);
        await this.e.execute("tab.waitForLoad", { tab: t.id, state: o.waitUntil ?? "load", timeoutMs: timeoutMs || 10000 });
        return null;
      }
      case "fileChooser.arm":
        return this.e.serial(t, async () => {
          await this.e.cdp(t, "Page.setInterceptFileChooserDialog", { enabled: true });
          this.pw(t).chooser = { since: t.sequence, armed: true };
          return null;
        });
      case "fileChooser.wait": {
        const armed = this.pw(t).chooser;
        if (!armed) throw new BrowserError("waitForEvent('filechooser') was not armed.");
        try {
          const ev = await this.retrying(Number(o.timeoutMs ?? 30000), "waitForEvent(\"filechooser\")", null, async () => {
            const e = t.events.find((x) => x.sequence > armed.since && x.method === "Page.fileChooserOpened");
            if (!e) throw new Retry("waiting for a file chooser");
            return e;
          });
          const p = ev.params as { backendNodeId?: number; mode?: string; frameId?: string };
          return { backendNodeId: p.backendNodeId, sessionId: ev.sessionId ?? null, isMultiple: p.mode === "selectMultiple" };
        } finally {
          this.pw(t).chooser = undefined;
          void this.e.cdp(t, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
        }
      }
      case "fileChooser.setFiles":
        await this.e.cdp(t, "DOM.setFileInputFiles", { files: (args.files as unknown[]).map(String), backendNodeId: Number(args.backendNodeId) }, args.sessionId ? { sessionId: String(args.sessionId) } : {});
        return null;
      case "download.arm": {
        const [latest] = await this.e.port.call("chrome", { namespace: "downloads", method: "search", args: [{ orderBy: ["-startTime"], limit: 1 }] });
        this.pw(t).download = { since: Number(latest?.id ?? 0) };
        return null;
      }
      case "download.wait": {
        const armed = this.pw(t).download;
        if (!armed) throw new BrowserError("waitForEvent('download') was not armed.");
        this.pw(t).download = undefined;
        return this.retrying(Number(o.timeoutMs ?? 30000), "waitForEvent(\"download\")", null, async () => {
          const items = await this.e.port.call("chrome", { namespace: "downloads", method: "search", args: [{ orderBy: ["-startTime"], limit: 10 }] }) as Array<Record<string, any>>;
          const item = items.find((d) => Number(d.id) > armed.since);
          if (!item) throw new Retry("waiting for a download to start");
          if (item.state === "interrupted") throw new BrowserError(`Download failed: ${item.error ?? "interrupted"}`);
          if (item.state !== "complete") throw new Retry(`waiting for download ${item.id} to complete`);
          return { id: item.id, url: item.finalUrl ?? item.url, path: item.filename, suggestedFilename: basename(String(item.filename ?? "")), mime: item.mime };
        });
      }
    }
    throw new BrowserError(`Unknown playwright action ${JSON.stringify(action)}.`);
  }

  private async waitForURL(t: TabState, args: Record<string, any>, timeoutMs: number) {
    const pattern = args.url as string | { source: string; flags: string };
    const re = typeof pattern === "string"
      ? (/[*?]/.test(pattern) ? globToRegex(pattern) : null)
      : new RegExp(pattern.source, pattern.flags);
    const matches = (url: string) => (re ? re.test(url) : url === pattern);
    await this.retrying(timeoutMs || 10000, "waitForURL", null, async () => {
      if (!t.url || !matches(t.url)) throw new Retry(`waiting for URL ${typeof pattern === "string" ? pattern : `/${pattern.source}/${pattern.flags}`} (current ${t.url})`);
      return null;
    });
    return null;
  }

  /** Aria snapshot (Playwright "ai" mode) with [ref=…] ids usable as locator("aria-ref=e12"); iframes expanded. */
  private async domSnapshot(t: TabState) {
    const snap = async (frame: FrameRef, depth: number): Promise<string> => {
      const ctx = await this.context(t, frame);
      const text: string = await this.run(t, ctx, `return pw.ariaSnapshot(document.body ?? document.documentElement, { mode: "ai" });`);
      if (depth >= 5) return text;
      const lines = text.split("\n");
      const out: string[] = [];
      for (const line of lines) {
        out.push(line);
        const m = /^(\s*)- iframe\b.*\[ref=([\w]+)\]/.exec(line);
        if (!m) continue;
        try {
          const found = await this.run(t, ctx, `
            const els = pw.querySelectorAll(pw.parseSelector("aria-ref=" + arg), document);
            if (els.length !== 1) return false;
            globalThis.__jellyPWFrame = els[0]; return true;`, m[2]);
          if (!found) continue;
          const owner = await this.e.cdp(t, "Runtime.evaluate", { expression: "globalThis.__jellyPWFrame", contextId: ctx.contextId }, { sessionId: ctx.sessionId });
          const { node } = await this.e.cdp(t, "DOM.describeNode", { objectId: owner.result.objectId }, { sessionId: ctx.sessionId });
          const frameId: string | undefined = node.frameId ?? node.contentDocument?.frameId;
          if (!frameId) continue;
          const oopif = [...t.sessions.values()].find((s) => s.targetId === frameId);
          const child = await snap(oopif ? { sessionId: oopif.sessionId, frameId } : { sessionId: ctx.sessionId, frameId }, depth + 1);
          const indent = `${m[1]}  `;
          if (!line.trimEnd().endsWith(":")) out[out.length - 1] = `${line}:`;
          out.push(...child.split("\n").filter(Boolean).map((l) => indent + l));
        } catch {}
      }
      return out.join("\n");
    };
    return this.retrying(5000, "domSnapshot", null, () => snap(this.mainFrame(t), 0));
  }

  /**
   * Elements at a screenshot (CSS px) point, topmost first, in Codex's ElementInfo shape.
   * Descends into iframes (incl. cross-origin) under the point; boxes are in screenshot coordinates.
   */
  private async elementsAt(t: TabState, x: number, y: number, includeNonInteractable: boolean): Promise<ElementInfo[]> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new BrowserError("Needs {x, y} in screenshot (CSS) pixels.");
    const visit = async (frame: FrameRef, px: number, py: number, ox: number, oy: number, frameSelectors: string[], depth: number): Promise<ElementInfo[]> => {
      const ctx = await this.context(t, frame);
      const r = await this.run(t, ctx, ELEMENTS_AT, { x: px, y: py, include: includeNonInteractable, descend: depth < 5 });
      const items: ElementInfo[] = await Promise.all((r.items as RawInfo[]).map(async (item, i) => {
        let nodeId: number | null = null;
        try {
          const h = await this.e.cdp(t, "Runtime.evaluate", { expression: `globalThis.__jellyPWInfo[${i}]`, contextId: ctx.contextId }, { sessionId: ctx.sessionId });
          nodeId = (await this.e.cdp(t, "DOM.describeNode", { objectId: h.result.objectId }, { sessionId: ctx.sessionId })).node.backendNodeId;
          void this.e.cdp(t, "Runtime.releaseObject", { objectId: h.result.objectId }, { sessionId: ctx.sessionId }).catch(() => {});
        } catch {}
        const { box, candidates, ...rest } = item;
        return {
          ...rest,
          nodeId,
          boundingBox: box ? { x: box.x + ox, y: box.y + oy, width: box.width, height: box.height } : null,
          selector: { primary: candidates[0] ?? null, candidates, ...(frameSelectors.length ? { frameSelectors } : {}) },
        };
      }));
      if (!r.frame) return items;
      try {
        const owner = await this.e.cdp(t, "Runtime.evaluate", { expression: "globalThis.__jellyPWFrame", contextId: ctx.contextId }, { sessionId: ctx.sessionId });
        const { node } = await this.e.cdp(t, "DOM.describeNode", { objectId: owner.result.objectId }, { sessionId: ctx.sessionId });
        const frameId: string | undefined = node.frameId ?? node.contentDocument?.frameId;
        if (!frameId) return items;
        const oopif = [...t.sessions.values()].find((c) => c.targetId === frameId);
        const child = oopif ? { sessionId: oopif.sessionId, frameId } : { sessionId: ctx.sessionId, frameId };
        const inner = await visit(child, px - r.frame.x, py - r.frame.y, ox + r.frame.x, oy + r.frame.y, [...frameSelectors, r.frame.selector], depth + 1);
        return [...inner, ...items];
      } catch {
        return items;
      }
    };
    return this.retrying(3000, "elementInfo", null, () => visit(this.mainFrame(t), x, y, 0, 0, [], 0));
  }

  /** Viewport screenshot annotated with the bounds of the elements at the point (numbered as returned) and the probed point. */
  private async elementScreenshot(t: TabState, x: number, y: number, includeNonInteractable: boolean) {
    const elements = await this.elementsAt(t, x, y, includeNonInteractable);
    const ctx = await this.context(t, this.mainFrame(t));
    const boxes = elements.map((e) => e.boundingBox).filter(Boolean);
    await this.run(t, ctx, DRAW_OVERLAY, { x, y, boxes });
    try {
      const shot = await this.e.screenshot(t);
      return { ...shot, elements };
    } finally {
      await this.run(t, ctx, `globalThis.__jellyPWOverlay?.remove(); globalThis.__jellyPWOverlay = undefined; return true;`).catch(() => {});
    }
  }

  private async downloadMedia(t: TabState, loc: LocatorSpec, o: Record<string, any>, timeoutMs: number, label: string) {
    const { ctx } = await this.element(t, loc, [], timeoutMs, label);
    const r = await this.run(t, ctx, `
      const el = globalThis.__jellyPWTarget;
      const url = el.currentSrc || el.src || el.href || el.getAttribute("src") || el.querySelector?.("source[src]")?.src || el.getAttribute("href") || el.getAttribute("data");
      if (!url) throw new Error("Element has no media or link URL");
      const res = await fetch(new URL(url, location.href), { credentials: "include" });
      if (!res.ok) throw new Error("HTTP " + res.status + " fetching " + url);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > 20 * 1024 * 1024) throw new Error("Media is larger than 20 MB; use waitForEvent('download') instead");
      let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { url: res.url, type: res.headers.get("content-type") || "", data: btoa(bin) };`);
    const dir = o.directory ? String(o.directory) : join(tmpdir(), "jelly-browser-media");
    mkdirSync(dir, { recursive: true });
    const name = o.path ? String(o.path) : join(dir, safeName(r.url, r.type));
    writeFileSync(name, Buffer.from(r.data, "base64"));
    return name;
  }
}

function safeName(url: string, type: string) {
  let base = "media";
  try { base = basename(new URL(url).pathname) || base; } catch {}
  base = base.replace(/[^\w.\-]+/g, "_").slice(0, 80);
  if (!/\.\w{2,5}$/.test(base)) {
    const ext = /\/(jpeg|jpg|png|gif|webp|svg|mp4|webm|mpeg|ogg|pdf|wav|mp3)/.exec(type)?.[1];
    if (ext) base += `.${ext === "jpeg" ? "jpg" : ext}`;
  }
  return `${Date.now()}-${base}`;
}

function globToRegex(glob: string) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += ".";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

interface Rect { x: number; y: number; width: number; height: number }
interface RawInfo { tagName: string; preview: string; role: string | null; ariaName: string | null; testId: string | null; visibleText: string | null; box: Rect | null; candidates: string[] }
export interface ElementInfo {
  ariaName: string | null; boundingBox: Rect | null; nodeId: number | null; preview: string; role: string | null;
  selector: { candidates: string[]; frameSelectors?: string[]; primary: string | null }; tagName: string; testId: string | null; visibleText: string | null;
}

/** In-page (isolated world, `pw` = InjectedScript): describe elements under a point, topmost first. */
const ELEMENTS_AT = String.raw`
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,label,iframe,frame,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],[role=treeitem],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const pointer = (el) => { try { return getComputedStyle(el).cursor === 'pointer'; } catch { return false; } };
  const interactable = (el) => el.matches(INTERACTIVE) || (pointer(el) && !(el.parentElement && pointer(el.parentElement)));
  const stack = []; const seen = new Set();
  const collect = (root) => {
    for (const el of root.elementsFromPoint(arg.x, arg.y)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.shadowRoot && stack.length < 64) collect(el.shadowRoot);
      stack.push(el);
    }
  };
  collect(document);
  const unique = (sel, el) => { try { const m = pw.querySelectorAll(pw.parseSelector(sel), document); return m.length === 1 && m[0] === el; } catch { return false; } };
  const q = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const info = (el) => {
    const role = pw.utils.getAriaRole(el) || null;
    let name = null; try { name = pw.utils.getElementAccessibleNameText(el, false) || null; } catch {}
    const tag = el.tagName.toLowerCase();
    let visibleText = null;
    if (tag === 'select') visibleText = el.selectedOptions?.[0]?.text ?? null;
    else if ((tag === 'input' && !/^(password|hidden)$/i.test(el.type)) || tag === 'textarea') visibleText = el.value || null;
    else visibleText = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200) || null;
    const candidates = [];
    const add = (sel) => { if (sel && !candidates.includes(sel) && unique(sel, el)) candidates.push(sel); };
    try { add(pw.generateSelectorSimple(el)); } catch {}
    if (role && name) add('internal:role=' + role + '[name=' + q(name) + 's]');
    const testId = el.getAttribute('data-testid');
    if (testId) add('internal:testid=[data-testid=' + q(testId) + 's]');
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) add('#' + el.id);
    if (role && !name) add('internal:role=' + role);
    const r = el.getBoundingClientRect();
    return { tagName: tag, preview: pw.previewNode(el), role, ariaName: name, testId, visibleText, box: r.width || r.height ? { x: r.x, y: r.y, width: r.width, height: r.height } : null, candidates };
  };
  const picked = stack.filter((el) => arg.include || interactable(el)).slice(0, 12);
  globalThis.__jellyPWInfo = picked;
  const items = picked.map(info);
  const top = stack[0];
  let frame = null;
  if (arg.descend && top && (top.tagName === 'IFRAME' || top.tagName === 'FRAME')) {
    const r = top.getBoundingClientRect(), st = getComputedStyle(top);
    globalThis.__jellyPWFrame = top;
    let selector = null; try { selector = pw.generateSelectorSimple(top); } catch {}
    frame = { selector: selector || 'iframe', x: r.left + top.clientLeft + parseFloat(st.paddingLeft || '0'), y: r.top + top.clientTop + parseFloat(st.paddingTop || '0') };
  }
  return { items, frame };
`;

/** In-page: fixed, pointer-transparent overlay in a closed shadow root with numbered boxes and a crosshair. */
const DRAW_OVERLAY = String.raw`
  globalThis.__jellyPWOverlay?.remove();
  const host = document.createElement('div');
  host.setAttribute('style', 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647');
  const root = host.attachShadow({ mode: 'closed' });
  const colors = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2'];
  let html = '';
  const placed = [];
  arg.boxes.forEach((b, i) => {
    const c = colors[i % colors.length];
    html += '<div style="position:fixed;left:' + b.x + 'px;top:' + b.y + 'px;width:' + b.width + 'px;height:' + b.height + 'px;outline:2px solid ' + c + ';background:' + c + '1a;box-sizing:border-box"></div>';
    // Label above the box (inside it at the viewport top), shifted right past earlier labels.
    const w = 8 + 7 * String(i + 1).length, h = 16;
    let lx = Math.max(0, b.x), ly = b.y >= h ? b.y - h : Math.max(0, b.y);
    while (placed.some((p) => lx < p.x + p.w + 2 && p.x < lx + w + 2 && ly < p.y + h && p.y < ly + h)) lx += w + 4;
    placed.push({ x: lx, y: ly, w });
    html += '<div style="position:fixed;left:' + lx + 'px;top:' + ly + 'px;font:bold 11px/14px sans-serif;color:#fff;background:' + c + ';padding:1px 4px;border-radius:3px">' + (i + 1) + '</div>';
  });
  html += '<div style="position:fixed;left:' + (arg.x - 12) + 'px;top:' + arg.y + 'px;width:24px;height:2px;margin-top:-1px;background:#facc15;box-shadow:0 0 0 1px #000"></div>';
  html += '<div style="position:fixed;left:' + arg.x + 'px;top:' + (arg.y - 12) + 'px;width:2px;height:24px;margin-left:-1px;background:#facc15;box-shadow:0 0 0 1px #000"></div>';
  html += '<div style="position:fixed;left:' + (arg.x - 4) + 'px;top:' + (arg.y - 4) + 'px;width:8px;height:8px;border-radius:50%;background:#facc15;border:1px solid #000;box-sizing:border-box"></div>';
  root.innerHTML = html;
  document.documentElement.appendChild(host);
  globalThis.__jellyPWOverlay = host;
  await new Promise((r) => setTimeout(r, 50));
  return true;
`;
