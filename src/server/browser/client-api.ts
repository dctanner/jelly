/**
 * Model-facing browser API exposed as the `browser` global of the `browser_js` REPL
 * (plans/codex-style-browser.md §4). Loaded inside the REPL worker; every method maps onto one
 * host RPC op `{op, args}` that the server-side BrowserEngine implements. Shape follows Codex's
 * browser-client (`tab.ax.write()`, `tab.ax.click(42)`, ...).
 */
import type { TabInfo, UserTabInfo } from "./types";
import { TabPlaywright } from "./playwright-client";

export interface ClientRuntime {
  /** Host RPC. Rejects with the host's error message. */
  call(op: string, args: Record<string, unknown>): Promise<unknown>;
  /** Emit a value into the tool result (text, or an image for `{data, mimeType:"image/*"}`). */
  display(value: unknown): void;
  /** Build arrays in the REPL context's realm (so `instanceof Array` holds for model code). */
  makeArray?<T>(items: T[]): T[];
}

export type TabId = number | string;
export type AXPoint = [number, number];
export type AXTarget = number | AXPoint;
export type AXDirection =
  "up" | "down" | "left" | "right" | "u" | "d" | "l" | "r";
export type AXMouseButton = "left" | "right" | "middle" | "l" | "r" | "m";
export type AXMode = "state" | "screenshot" | "both";
export interface AXStateOptions {
  /** Return the full tree instead of a diff against the previous state. */
  disableDiffing?: boolean;
}
export interface AXClickOptions {
  mouseButton?: AXMouseButton;
  clickCount?: number;
  /** Key combination held throughout the click, e.g. "super" or "shift". */
  key?: string;
  /** Seconds (0–30) to hold each press. */
  duration?: number;
}
export interface Screenshot {
  data: string;
  mimeType: string;
  width?: number;
  height?: number;
}
export interface ScreenshotOptions {
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
}
export interface AXState {
  state?: string;
  screenshot?: Screenshot;
}
export interface JsDialog {
  type: string;
  message: string;
  defaultPrompt?: string;
}
export type LoadState = "load" | "domcontentloaded" | "networkidle";

const DIRECTIONS: Record<string, string> = {
  u: "up",
  d: "down",
  l: "left",
  r: "right",
};
const BUTTONS: Record<string, string> = { l: "left", r: "right", m: "middle" };
const MODES = new Set(["state", "screenshot", "both"]);
/** Keys probed by await/JSON/inspect that must not turn into chrome.* calls. */
const NOT_CHROME = new Set([
  "then",
  "toJSON",
  "constructor",
  "inspect",
  "valueOf",
  "toString",
  "prototype",
  "__proto__",
]);

function toTabId(value: unknown, what = "tab id"): number {
  const raw =
    value && typeof value === "object"
      ? (value as { id?: unknown }).id
      : (value as unknown);
  const id = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof id !== "number" || !Number.isInteger(id))
    throw new TypeError(`Invalid ${what}: ${String(raw)}`);
  return id;
}

function checkMode(mode: string): AXMode {
  if (!MODES.has(mode))
    throw new TypeError(`mode must be "state", "screenshot" or "both"`);
  return mode as AXMode;
}

/** Accessibility API for one tab: observe with `write()`/`get()`, act by AX element index or [x, y]. */
export class TabAX {
  readonly #tab: Tab;
  readonly #rt: ClientRuntime;
  constructor(tab: Tab, rt: ClientRuntime) {
    this.#tab = tab;
    this.#rt = rt;
  }

  #action(action: Record<string, unknown>): Promise<unknown> {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(action))
      if (value !== undefined) clean[key] = value;
    return this.#rt.call("tab.ax.action", { tab: this.#tab.id, action: clean });
  }

  async #state(mode: string, options?: AXStateOptions): Promise<AXState> {
    return ((await this.#rt.call("tab.ax.get", {
      tab: this.#tab.id,
      mode: checkMode(mode),
      disableDiffing: options?.disableDiffing,
    })) ?? {}) as AXState;
  }

  /**
   * Return state without displaying it. "state" → AX text (diff vs the previous state unless
   * `disableDiffing`); "screenshot" → `{data, mimeType}`; "both" → `{state, screenshot}`.
   */
  async get(
    mode: AXMode = "state",
    options?: AXStateOptions,
  ): Promise<unknown> {
    const result = await this.#state(mode, options);
    if (mode === "state") return result.state;
    if (mode === "screenshot") return result.screenshot;
    return result;
  }

  /** Display the latest AX state text and/or screenshot into the tool result. Waits for the page to settle. */
  async write(mode: AXMode = "state", options?: AXStateOptions): Promise<void> {
    const result = await this.#state(mode, options);
    if (mode !== "screenshot" && result.state !== undefined)
      this.#rt.display(result.state);
    if (mode !== "state" && result.screenshot !== undefined)
      this.#rt.display(result.screenshot);
  }

  /** Click an AX element index or a viewport [x, y] point. */
  click(target: AXTarget, options: AXClickOptions = {}): Promise<unknown> {
    return this.#action({
      kind: "click",
      target,
      mouseButton: options.mouseButton
        ? (BUTTONS[options.mouseButton] ?? options.mouseButton)
        : undefined,
      clickCount: options.clickCount,
      key: options.key,
      duration: options.duration,
    });
  }

  /** Set the value of an editable/settable element (text field, select, slider, ...). */
  setValue(elementIndex: number, value: string): Promise<unknown> {
    return this.#action({
      kind: "set_value",
      element_index: elementIndex,
      value,
    });
  }

  /** Type text; focuses `elementIndex` first, or uses the current focus when null. */
  typeText(elementIndex: number | null, text: string): Promise<unknown> {
    return this.#action({
      kind: "type_text",
      element_index: elementIndex ?? null,
      text,
    });
  }

  /** Paste text via the clipboard; `format`: "text" | "md" | "html". */
  paste(
    elementIndex: number | null,
    text: string,
    options: { format?: string } = {},
  ): Promise<unknown> {
    return this.#action({
      kind: "paste",
      element_index: elementIndex ?? null,
      text,
      format: options.format,
    });
  }

  /** Press a key/combination (xdotool style: "Return", "Tab", "super+a", "shift+Up"); `duration` holds it (s). */
  pressKey(
    elementIndex: number | null,
    key: string,
    options: { duration?: number } = {},
  ): Promise<unknown> {
    return this.#action({
      kind: "press_key",
      element_index: elementIndex ?? null,
      key,
      duration: options.duration,
    });
  }

  /** Scroll an element or the point [x, y] by `pages` viewport pages (default 1). */
  scroll(
    target: AXTarget,
    direction: AXDirection,
    pages?: number,
  ): Promise<unknown> {
    return this.#action({
      kind: "scroll",
      target,
      direction: DIRECTIONS[direction] ?? direction,
      pages,
    });
  }

  /** Select `text` in an editable element; `prefix`/`suffix` disambiguate, `selectionType` places a cursor. */
  selectText(
    elementIndex: number,
    text: string,
    options: {
      prefix?: string;
      suffix?: string;
      selectionType?: "text" | "cursor_before" | "cursor_after";
    } = {},
  ): Promise<unknown> {
    return this.#action({
      kind: "select_text",
      element_index: elementIndex,
      text,
      prefix: options.prefix,
      suffix: options.suffix,
      selection_type: options.selectionType,
    });
  }

  /** Invoke a secondary action listed on the element (`Secondary Actions: ...`). */
  performSecondaryAction(
    elementIndex: number,
    action: string,
  ): Promise<unknown> {
    return this.#action({
      kind: "perform_secondary_action",
      element_index: elementIndex,
      action,
    });
  }

  /** Drag between two elements or points. */
  drag(from: AXTarget, to: AXTarget): Promise<unknown> {
    return this.#action({ kind: "drag", from, to });
  }

  /** Move the mouse over an element or point. */
  hover(target: AXTarget): Promise<unknown> {
    return this.#action({ kind: "hover", target });
  }
}

/** Raw Chrome DevTools Protocol access for one tab. */
export class TabCDP {
  readonly #tab: Tab;
  readonly #rt: ClientRuntime;
  constructor(tab: Tab, rt: ClientRuntime) {
    this.#tab = tab;
    this.#rt = rt;
  }

  /** Send a CDP command; `sessionId` targets an attached child (OOPIF) session. */
  send(
    method: string,
    params?: Record<string, unknown>,
    options: { sessionId?: string } = {},
  ): Promise<unknown> {
    return this.#rt.call("tab.cdp", {
      tab: this.#tab.id,
      method,
      params,
      sessionId: options.sessionId,
    });
  }

  /** Read buffered CDP events after `afterSequence` (long-polls up to `timeoutMs`). → {cursor, events, hasMore, truncated} */
  events(
    options: {
      afterSequence?: number;
      methods?: string[];
      limit?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<unknown> {
    return this.#rt.call("tab.cdp.events", {
      tab: this.#tab.id,
      afterSequence: options.afterSequence,
      methods: options.methods,
      limit: options.limit,
      timeoutMs: options.timeoutMs,
    });
  }
}

/** A controllable browser tab (agent-created or claimed). */
export class Tab {
  /** Chrome tab id. */
  readonly id: number;
  /** Last-known TabInfo (may be stale; `url()`/`title()` fetch fresh values). */
  lastInfo: TabInfo | undefined;
  readonly ax: TabAX;
  readonly cdp: TabCDP;
  /** Playwright-style locators: tab.playwright.getByRole("button", {name: "Save"}).click(). */
  readonly playwright: TabPlaywright;
  readonly #rt: ClientRuntime;
  readonly #forget: (id: number) => void;

  constructor(id: number, rt: ClientRuntime, forget: (id: number) => void) {
    this.id = id;
    this.#rt = rt;
    this.#forget = forget;
    this.ax = new TabAX(this, rt);
    this.cdp = new TabCDP(this, rt);
    this.playwright = new TabPlaywright(id, rt);
  }

  #op(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.#rt.call(op, { tab: this.id, ...args });
  }

  /** Fresh TabInfo `{id, title, url, windowId, active, origin, mark}`. */
  async info(): Promise<TabInfo> {
    const info = (await this.#op("tab.info")) as TabInfo;
    if (info && typeof info === "object") this.lastInfo = info;
    return info;
  }
  async url(): Promise<string | undefined> {
    return (await this.info())?.url;
  }
  async title(): Promise<string | undefined> {
    return (await this.info())?.title;
  }
  /** Navigate and wait for load. Don't goto the URL the tab is already on; use reload(). */
  goto(url: string, options: { timeoutMs?: number } = {}): Promise<unknown> {
    return this.#op("tab.goto", { url, timeoutMs: options.timeoutMs });
  }
  back(): Promise<unknown> {
    return this.#op("tab.back");
  }
  forward(): Promise<unknown> {
    return this.#op("tab.forward");
  }
  reload(): Promise<unknown> {
    return this.#op("tab.reload");
  }
  async close(): Promise<unknown> {
    const result = await this.#op("tab.close");
    this.#forget(this.id);
    return result;
  }
  /** Activate the tab and focus its window (for the user to see). */
  show(): Promise<unknown> {
    return this.#op("tab.show");
  }
  /** Keep this tab open after the turn as a user-facing result. */
  markDeliverable(): Promise<unknown> {
    return this.#op("tab.mark", { mark: "deliverable" });
  }
  /** Keep this tab for a later turn (work continues from the live page). */
  markHandoff(): Promise<unknown> {
    return this.#op("tab.mark", { mark: "handoff" });
  }
  /** Clear this turn's mark. */
  unmark(): Promise<unknown> {
    return this.#op("tab.mark", { mark: null });
  }
  /** JPEG screenshot `{data (base64), mimeType, width, height}`; pass it to display() to show it. */
  screenshot(options: ScreenshotOptions = {}): Promise<Screenshot> {
    return this.#op("tab.screenshot", {
      fullPage: options.fullPage,
      clip: options.clip,
    }) as Promise<Screenshot>;
  }
  /**
   * Run JS in the page (awaits promises, returns JSON). Pass an expression string, or a function plus
   * one JSON-serialisable `arg`. With `{elementIndex}` the function runs with `this` = that AX element's node.
   */
  evaluate(
    pageFunction: string | ((...args: any[]) => unknown),
    arg?: unknown,
    options: { elementIndex?: number } = {},
  ): Promise<unknown> {
    if (typeof pageFunction === "function")
      return this.#op("tab.evaluate", {
        functionDeclaration: pageFunction.toString(),
        arg,
        elementIndex: options.elementIndex,
      });
    return this.#op("tab.evaluate", {
      expression: String(pageFunction),
      elementIndex: options.elementIndex,
    });
  }
  /** Set files (absolute paths) on a file input AX element. */
  setFiles(elementIndex: number, paths: string | string[]): Promise<unknown> {
    return this.#op("tab.setFiles", {
      element_index: elementIndex,
      paths: Array.isArray(paths) ? paths : [paths],
    });
  }
  /** Open JS dialog `{type, message, defaultPrompt}` or null. */
  dialog(): Promise<JsDialog | null> {
    return this.#op("tab.dialog") as Promise<JsDialog | null>;
  }
  handleDialog(accept: boolean, promptText?: string): Promise<unknown> {
    return this.#op("tab.handleDialog", { accept, promptText });
  }
  waitForLoad(
    state?: LoadState,
    options: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    return this.#op("tab.waitForLoad", { state, timeoutMs: options.timeoutMs });
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      title: this.lastInfo?.title,
      url: this.lastInfo?.url,
    };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    const info = this.lastInfo;
    return `Tab { id: ${this.id}${info ? `, title: ${JSON.stringify(info.title)}, url: ${JSON.stringify(info.url)}` : ""} }`;
  }
}

export interface Browser {
  /** Name this browser session (tab group title). Start with an emoji, e.g. "🔎 Flight prices". */
  nameSession(name: string): Promise<unknown>;
  tabs: {
    /** This session's tabs (agent-created + claimed). Same Tab object per id across calls. */
    list(): Promise<Tab[]>;
    /** Open a new background tab in the session group. */
    new: (url?: string | { url?: string }) => Promise<Tab>;
    get(id: TabId): Promise<Tab>;
  };
  user: {
    /** All user tabs not held by another session, most recent first: UserTabInfo[]. */
    openTabs(): Promise<UserTabInfo[]>;
    /** Take control of a user tab (object from openTabs() or its id). */
    claimTab(tab: TabId | { id: TabId }): Promise<Tab>;
  };
  /** Passthrough: `browser.chrome.<namespace>.<method>(...args)` for tabs, windows, tabGroups, bookmarks, history, downloads, sessions, topSites, cookies. */
  chrome: Record<
    string,
    Record<string, (...args: unknown[]) => Promise<unknown>>
  >;
}

/** Build the `browser` global. Tab objects are cached by id. */
export function createBrowserApi(rt: ClientRuntime): Browser {
  const tabs = new Map<number, Tab>();
  const forget = (id: number) => tabs.delete(id);
  const array = <T>(items: T[]): T[] =>
    rt.makeArray ? rt.makeArray(items) : items;
  const tabFor = (info: TabInfo | number): Tab => {
    const id = toTabId(info);
    let tab = tabs.get(id);
    if (!tab) {
      tab = new Tab(id, rt, forget);
      tabs.set(id, tab);
    }
    if (info && typeof info === "object") tab.lastInfo = info;
    return tab;
  };
  const passthrough = (namespace: string) =>
    new Proxy(
      {},
      {
        get: (_target, method) =>
          typeof method !== "string" || NOT_CHROME.has(method)
            ? undefined
            : (...args: unknown[]) =>
                rt.call("chrome", { namespace, method, args }),
      },
    );
  const namespaces = new Map<string, object>();

  return {
    nameSession: (name: string) => rt.call("nameSession", { name }),
    tabs: {
      list: async () => {
        const infos = ((await rt.call("tabs.list", {})) ?? []) as TabInfo[];
        const live = new Set(infos.map((info) => toTabId(info)));
        for (const id of tabs.keys()) if (!live.has(id)) tabs.delete(id);
        return array(infos.map(tabFor));
      },
      new: async (url?: string | { url?: string }) => {
        const target = typeof url === "object" && url !== null ? url.url : url;
        return tabFor((await rt.call("tabs.new", { url: target })) as TabInfo);
      },
      get: async (id: TabId) =>
        tabFor((await rt.call("tabs.get", { id: toTabId(id) })) as TabInfo),
    },
    user: {
      openTabs: async () =>
        ((await rt.call("user.openTabs", {})) ?? array([])) as UserTabInfo[],
      claimTab: async (tab: TabId | { id: TabId }) =>
        tabFor(
          (await rt.call("user.claimTab", { id: toTabId(tab) })) as TabInfo,
        ),
    },
    chrome: new Proxy({} as Browser["chrome"], {
      get: (_target, namespace) => {
        if (typeof namespace !== "string" || NOT_CHROME.has(namespace))
          return undefined;
        let proxy = namespaces.get(namespace);
        if (!proxy) namespaces.set(namespace, (proxy = passthrough(namespace)));
        return proxy;
      },
    }),
  };
}
