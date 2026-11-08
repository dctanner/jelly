/**
 * `tab.playwright` for the browser_js REPL (Codex's PlaywrightAPI surface). Locators are
 * built into real Playwright selector strings (same escaping as Playwright's locatorUtils)
 * and resolved server-side by Playwright's InjectedScript; see ./playwright.ts.
 */
import type { ClientRuntime } from "./client-api";

export type TextMatcher = string | RegExp;
type Spec = { frames: string[]; selector: string };

// ── Playwright selector escaping (packages/playwright-core/src/utils/isomorphic/stringUtils.ts) ──
function escapeRegexForSelector(re: RegExp): string {
  if ((re as RegExp & { unicodeSets?: boolean }).unicode || (re as RegExp & { unicodeSets?: boolean }).unicodeSets) return String(re);
  return String(re).replace(/(^|[^\\])(\\\\)*(["'`])/g, "$1$2\\$3").replace(/>>/g, "\\>\\>");
}
function escapeForTextSelector(text: TextMatcher, exact: boolean): string {
  if (typeof text !== "string") return escapeRegexForSelector(text);
  return `${JSON.stringify(text)}${exact ? "s" : "i"}`;
}
function escapeForAttributeSelector(value: TextMatcher, exact: boolean): string {
  if (typeof value !== "string") return escapeRegexForSelector(value);
  return `"${value.replace(/\\/g, "\\\\").replace(/["]/g, '\\"')}"${exact ? "s" : "i"}`;
}
const byText = (text: TextMatcher, exact?: boolean) => `internal:text=${escapeForTextSelector(text, !!exact)}`;
const byLabel = (text: TextMatcher, exact?: boolean) => `internal:label=${escapeForTextSelector(text, !!exact)}`;
const byAttr = (attr: string, text: TextMatcher, exact?: boolean) => `internal:attr=[${attr}=${escapeForAttributeSelector(text, !!exact)}]`;
const byTestId = (testId: TextMatcher) => `internal:testid=[data-testid=${escapeForAttributeSelector(testId, true)}]`;
export interface ByRoleOptions {
  name?: TextMatcher; description?: TextMatcher; exact?: boolean; checked?: boolean; disabled?: boolean; expanded?: boolean;
  includeHidden?: boolean; level?: number; pressed?: boolean | "mixed"; selected?: boolean;
}
function byRole(role: string, o: ByRoleOptions = {}): string {
  const props: string[][] = [];
  if (o.checked !== undefined) props.push(["checked", String(o.checked)]);
  if (o.disabled !== undefined) props.push(["disabled", String(o.disabled)]);
  if (o.selected !== undefined) props.push(["selected", String(o.selected)]);
  if (o.expanded !== undefined) props.push(["expanded", String(o.expanded)]);
  if (o.includeHidden !== undefined) props.push(["include-hidden", String(o.includeHidden)]);
  if (o.level !== undefined) props.push(["level", String(o.level)]);
  if (o.name !== undefined) props.push(["name", escapeForAttributeSelector(o.name, !!o.exact)]);
  if (o.description !== undefined) props.push(["description", escapeForAttributeSelector(o.description, !!o.exact)]);
  if (o.pressed !== undefined) props.push(["pressed", String(o.pressed)]);
  return `internal:role=${role}${props.map(([n, v]) => `[${n}=${v}]`).join("")}`;
}

export interface FilterOptions { has?: Locator; hasNot?: Locator; hasText?: TextMatcher; hasNotText?: TextMatcher; visible?: boolean }
function filtered(selector: string, o: FilterOptions = {}): string {
  let s = selector;
  if (o.hasText !== undefined) s += ` >> internal:has-text=${escapeForTextSelector(o.hasText, false)}`;
  if (o.hasNotText !== undefined) s += ` >> internal:has-not-text=${escapeForTextSelector(o.hasNotText, false)}`;
  if (o.has) s += ` >> internal:has=${JSON.stringify(innerSelector(o.has, "has"))}`;
  if (o.hasNot) s += ` >> internal:has-not=${JSON.stringify(innerSelector(o.hasNot, "hasNot"))}`;
  if (o.visible !== undefined) s += ` >> visible=${o.visible ? "true" : "false"}`;
  return s;
}
function innerSelector(l: Locator, what: string) {
  if (l._spec.frames.length) throw new Error(`Inner "${what}" locator must belong to the same frame.`);
  return l._spec.selector;
}
const join = (a: string, b: string) => (a ? `${a} >> ${b}` : b);
const serialisePattern = (p: string | RegExp) => (typeof p === "string" ? p : { source: p.source, flags: p.flags });

/** Common getBy* / locator builders for page, frame and locator scopes. */
abstract class Scope {
  protected abstract child(selector: string): Locator;
  locator(selector: string | Locator, options: FilterOptions = {}): Locator {
    const s = typeof selector === "string" ? selector : innerLocator(selector);
    return this.child(filtered(s, options));
  }
  getByRole(role: string, options: ByRoleOptions = {}) { return this.child(byRole(role, options)); }
  getByText(text: TextMatcher, options: { exact?: boolean } = {}) { return this.child(byText(text, options.exact)); }
  getByLabel(text: TextMatcher, options: { exact?: boolean } = {}) { return this.child(byLabel(text, options.exact)); }
  getByPlaceholder(text: TextMatcher, options: { exact?: boolean } = {}) { return this.child(byAttr("placeholder", text, options.exact)); }
  getByAltText(text: TextMatcher, options: { exact?: boolean } = {}) { return this.child(byAttr("alt", text, options.exact)); }
  getByTitle(text: TextMatcher, options: { exact?: boolean } = {}) { return this.child(byAttr("title", text, options.exact)); }
  getByTestId(testId: TextMatcher) { return this.child(byTestId(testId)); }
}
function innerLocator(l: Locator) {
  if (l._spec.frames.length) throw new Error("Cannot nest a locator from another frame.");
  return `internal:chain=${JSON.stringify(l._spec.selector)}`;
}

export class Locator extends Scope {
  /** @internal */ readonly _spec: Spec;
  readonly #pw: TabPlaywright;
  constructor(pw: TabPlaywright, spec: Spec) {
    super();
    this.#pw = pw;
    this._spec = spec;
  }
  protected child(selector: string) { return new Locator(this.#pw, { ...this._spec, selector: join(this._spec.selector, selector) }); }
  #act(action: string, extra: Record<string, unknown> = {}) { return this.#pw._call(action, { ...this._spec, ...extra }); }

  // composition
  first() { return new Locator(this.#pw, { ...this._spec, selector: join(this._spec.selector, "nth=0") }); }
  last() { return new Locator(this.#pw, { ...this._spec, selector: join(this._spec.selector, "nth=-1") }); }
  nth(index: number) { return new Locator(this.#pw, { ...this._spec, selector: join(this._spec.selector, `nth=${index}`) }); }
  filter(options: FilterOptions = {}) { return new Locator(this.#pw, { ...this._spec, selector: filtered(this._spec.selector, options) }); }
  and(other: Locator) { return new Locator(this.#pw, { ...this._spec, selector: join(this._spec.selector, `internal:and=${JSON.stringify(innerSelector(other, "and"))}`) }); }
  or(other: Locator) { return new Locator(this.#pw, { ...this._spec, selector: join(this._spec.selector, `internal:or=${JSON.stringify(innerSelector(other, "or"))}`) }); }
  frameLocator(selector: string) { return new FrameLocator(this.#pw, [...this._spec.frames, join(this._spec.selector, selector)]); }
  async all(): Promise<Locator[]> {
    const n = (await this.count()) as number;
    return Array.from({ length: n }, (_, i) => this.nth(i));
  }

  // actions (auto-wait for actionable, strict: exactly one match)
  click(options: { button?: "left" | "right" | "middle"; clickCount?: number; modifiers?: string[]; position?: { x: number; y: number }; force?: boolean; delay?: number; timeoutMs?: number } = {}) { return this.#act("click", { options }); }
  dblclick(options: { button?: "left" | "right" | "middle"; modifiers?: string[]; position?: { x: number; y: number }; force?: boolean; timeoutMs?: number } = {}) { return this.#act("dblclick", { options }); }
  hover(options: { position?: { x: number; y: number }; force?: boolean; timeoutMs?: number } = {}) { return this.#act("hover", { options }); }
  fill(value: string, options: { force?: boolean; timeoutMs?: number } = {}) { return this.#act("fill", { value, options }); }
  clear(options: { timeoutMs?: number } = {}) { return this.#act("fill", { value: "", options }); }
  type(value: string, options: { timeoutMs?: number } = {}) { return this.#act("type", { value, options }); }
  pressSequentially(value: string, options: { timeoutMs?: number } = {}) { return this.#act("pressSequentially", { value, options }); }
  press(key: string, options: { timeoutMs?: number } = {}) { return this.#act("press", { value: key, options }); }
  check(options: { force?: boolean; timeoutMs?: number } = {}) { return this.#act("check", { options }); }
  uncheck(options: { force?: boolean; timeoutMs?: number } = {}) { return this.#act("uncheck", { options }); }
  setChecked(checked: boolean, options: { force?: boolean; timeoutMs?: number } = {}) { return this.#act("setChecked", { value: checked, options }); }
  selectOption(value: string | { value?: string; label?: string; index?: number } | Array<string | { value?: string; label?: string; index?: number }>, options: { timeoutMs?: number } = {}) {
    return this.#act("selectOption", { value, options }) as Promise<string[]>;
  }
  selectText(options: { timeoutMs?: number } = {}) { return this.#act("selectText", { options }); }
  setInputFiles(files: string | string[], options: { timeoutMs?: number } = {}) { return this.#act("setInputFiles", { value: files, options }); }
  waitFor(options: { state?: "attached" | "detached" | "visible" | "hidden"; timeoutMs?: number } = {}) { return this.#act("waitFor", { options }); }

  // queries
  count() { return this.#act("count") as Promise<number>; }
  isVisible() { return this.#act("isVisible") as Promise<boolean>; }
  isEnabled() { return this.#act("isEnabled") as Promise<boolean>; }
  textContent(options: { timeoutMs?: number } = {}) { return this.#act("textContent", { options }) as Promise<string | null>; }
  innerText(options: { timeoutMs?: number } = {}) { return this.#act("innerText", { options }) as Promise<string>; }
  innerHTML(options: { timeoutMs?: number } = {}) { return this.#act("innerHTML", { options }) as Promise<string>; }
  inputValue(options: { timeoutMs?: number } = {}) { return this.#act("inputValue", { options }) as Promise<string>; }
  getAttribute(name: string, options: { timeoutMs?: number } = {}) { return this.#act("getAttribute", { value: name, options }) as Promise<string | null>; }
  allTextContents() { return this.#act("allTextContents") as Promise<string[]>; }
  allInnerTexts() { return this.#act("allInnerTexts") as Promise<string[]>; }
  /** Runs in the page's main world with the element as the first argument. */
  evaluate(fn: (element: any, arg: any) => unknown, arg?: unknown, options: { timeoutMs?: number } = {}) { return this.#act("evaluate", { fn: fn.toString(), arg, options }); }
  /** Runs in an isolated world (page DOM, not page JS globals) with all matched elements. */
  evaluateAll(fn: (elements: any[], arg: any) => unknown, arg?: unknown) { return this.#act("evaluateAll", { fn: fn.toString(), arg }); }
  /** Fetch the element's media/link URL with the page's cookies and save it; returns the file path. */
  downloadMedia(options: { path?: string; directory?: string; timeoutMs?: number } = {}) { return this.#act("downloadMedia", { options }) as Promise<string>; }

  toString() { return `Locator(${[...this._spec.frames.map((f) => `frame ${f}`), this._spec.selector].join(" >> ")})`; }
  [Symbol.for("nodejs.util.inspect.custom")]() { return this.toString(); }
}

export class FrameLocator extends Scope {
  readonly #pw: TabPlaywright;
  readonly #frames: string[];
  constructor(pw: TabPlaywright, frames: string[]) {
    super();
    this.#pw = pw;
    this.#frames = frames;
  }
  protected child(selector: string) { return new Locator(this.#pw, { frames: this.#frames, selector }); }
  frameLocator(selector: string) { return new FrameLocator(this.#pw, [...this.#frames, selector]); }
  /** Locator for the <iframe> element itself, in its parent frame. */
  owner() { return new Locator(this.#pw, { frames: this.#frames.slice(0, -1), selector: this.#frames.at(-1)! }); }
}

export interface FileChooser { isMultiple(): boolean; setFiles(files: string | string[], options?: { timeoutMs?: number }): Promise<void> }
export interface Download { url: string; suggestedFilename: string; path(options?: { timeoutMs?: number }): Promise<string | null> }

/** Codex-compatible `tab.playwright`. */
export class TabPlaywright extends Scope {
  readonly #tabId: number;
  readonly #rt: ClientRuntime;
  constructor(tabId: number, rt: ClientRuntime) {
    super();
    this.#tabId = tabId;
    this.#rt = rt;
  }
  /** @internal */ _call(action: string, args: Record<string, unknown> = {}) {
    return this.#rt.call("tab.pw", { tab: this.#tabId, action, ...args });
  }
  protected child(selector: string) { return new Locator(this, { frames: [], selector }); }
  frameLocator(selector: string) { return new FrameLocator(this, [selector]); }

  /** Run JS in the page's main world (awaits promises, returns JSON). */
  evaluate(fn: string | ((arg: any) => unknown), arg?: unknown) {
    return typeof fn === "function"
      ? this.#rt.call("tab.evaluate", { tab: this.#tabId, functionDeclaration: fn.toString(), arg })
      : this.#rt.call("tab.evaluate", { tab: this.#tabId, expression: String(fn) });
  }
  /** Playwright aria snapshot (YAML) with [ref=…] ids; target them with locator("aria-ref=e12"). Iframes are expanded. */
  domSnapshot() { return this._call("domSnapshot") as Promise<string>; }
  /**
   * Interactable elements at a screenshot (CSS px) point, topmost first (iframes are entered):
   * [{tagName, preview, role, ariaName, testId, visibleText, boundingBox, nodeId, selector: {primary, candidates, frameSelectors?}}].
   * Use a candidate with pw.locator(…) (inside pw.frameLocator(…) for each frameSelectors entry).
   */
  elementInfo(options: { x: number; y: number; includeNonInteractable?: boolean }) { return this._call("elementInfo", { options }); }
  /**
   * Viewport JPEG annotated with the elementInfo() boxes (numbered 1..n in returned order) and the probed point:
   * {data, mimeType, width, height, elements}. display(shot) shows it.
   */
  elementScreenshot(options: { x: number; y: number; includeNonInteractable?: boolean }) { return this._call("elementScreenshot", { options }); }
  waitForLoadState(options: { state?: "load" | "domcontentloaded" | "networkidle"; timeoutMs?: number } = {}) {
    return this.#rt.call("tab.waitForLoad", { tab: this.#tabId, state: options.state ?? "load", timeoutMs: options.timeoutMs });
  }
  waitForURL(url: string | RegExp, options: { timeoutMs?: number } = {}) { return this._call("waitForURL", { url: serialisePattern(url), options }); }
  waitForTimeout(timeoutMs: number) { return new Promise((r) => setTimeout(r, timeoutMs)); }
  /** Run `action` and wait for the navigation it triggers. */
  async expectNavigation<T>(action: () => Promise<T>, options: { url?: string | RegExp; waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeoutMs?: number } = {}): Promise<T> {
    const before = (await this._call("navState")) as { navigationRevision: number };
    const result = await action();
    await this._call("waitForNavigation", { since: before.navigationRevision, url: options.url === undefined ? undefined : serialisePattern(options.url), options: { waitUntil: options.waitUntil, timeoutMs: options.timeoutMs } });
    return result;
  }
  /** Call BEFORE the click that opens the chooser/starts the download, then await the result. */
  waitForEvent(event: "filechooser", options?: { timeoutMs?: number }): Promise<FileChooser>;
  waitForEvent(event: "download", options?: { timeoutMs?: number }): Promise<Download>;
  waitForEvent(event: "filechooser" | "download", options: { timeoutMs?: number } = {}): Promise<FileChooser | Download> {
    if (event === "filechooser") {
      const armed = this._call("fileChooser.arm");
      return armed.then(() => this._call("fileChooser.wait", { options })).then((info: any) => ({
        isMultiple: () => !!info.isMultiple,
        setFiles: async (files: string | string[]) => {
          await this._call("fileChooser.setFiles", { backendNodeId: info.backendNodeId, sessionId: info.sessionId, files: Array.isArray(files) ? files : [files] });
        },
      }));
    }
    if (event === "download") {
      const armed = this._call("download.arm");
      return armed.then(() => this._call("download.wait", { options })).then((d: any) => ({
        url: d.url, suggestedFilename: d.suggestedFilename, path: async () => d.path ?? null,
      }));
    }
    return Promise.reject(new Error(`Unsupported event ${JSON.stringify(event)}; use "filechooser" or "download".`));
  }
}
