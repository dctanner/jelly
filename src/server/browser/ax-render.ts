/**
 * Accessibility-tree renderer (Codex-compatible text format).
 *
 * Pure and synchronous: turns a flattened CDP accessibility snapshot into the
 * VoiceOver-style text the model reads, keeps element ids stable across
 * captures, and emits a compact diff against the previous revision when that
 * saves enough text. The format mirrors the Codex Chrome plugin renderer:
 *
 *   0 AXWebArea Title, URL: example.com/
 *   \t1 container
 *   \t\t2 text field (settable) Email, Value: a@b.c, Placeholder: you@example.com, ID: email
 *   \t\t3 link Description: Docs, Value: example.com/docs
 *
 *   The focused UI element is 2 text field (settable) Email, Value: a@b.c, …
 *
 * Line grammar: `<id> <role word>[ (<flags>)][ <label>][, <Key>: <value>]*`
 * where keys are, in order: Description, URL, Help, Value, Details,
 * Placeholder, ID, Secondary Actions. When an element has no title and only
 * one key (other than Secondary Actions), the key's value is printed bare.
 *
 * JavaScript dialogs: pass `snapshot.dialog` (and any `nodes`, which are then
 * ignored) or build the nodes yourself with {@link dialogSnapshotNodes}; the
 * dialog controls get identities `javascript-dialog:<tab>:<dialog>:<control>`
 * and {@link dialogControlFor} maps an element id back to its control.
 */

export interface AXInputNode {
  /** Index of the parent in `nodes`; -1 for a root. Parents precede children. */
  parentIndex: number;
  /** Stable identity, e.g. `${tabId}|${sessionId ?? ""}|${backendDOMNodeId}`. */
  identity: string;
  /** CDP `AXNode.role.value`, e.g. "RootWebArea", "button", "StaticText", "generic". */
  role: string;
  name: string | null;
  nameSource?: "contents" | "placeholder" | "relatedElement" | "attribute" | "value" | null;
  description: string | null;
  value: string | number | boolean | null;
  /**
   * Whitelisted CDP AX properties with values unwrapped: expanded, checked, pressed, settable,
   * editable, disabled, focused, focusable, selected, level, hasPopup, roledescription, url,
   * valuetext, placeholder, multiline, required, invalid, …
   */
  properties: Record<string, unknown>;
  /**
   * DOM metadata. `tagName` matters for input/select/textarea (native controls are settable);
   * `id` is printed as `ID:`. `hasAriaDescription` (optional) hides an aria-description `Help:`.
   */
  dom?: { tagName?: string | null; id?: string | null; inputType?: string | null; hasAriaDescription?: boolean | null };
  isDialogControl?: boolean;
}

export type JsDialogType = "alert" | "confirm" | "prompt" | "beforeunload";

export interface AXDialogInfo {
  type: JsDialogType;
  message: string;
  /** Current prompt text (falls back to `defaultPrompt`). */
  promptText?: string | null;
  defaultPrompt?: string | null;
  /** URL of the page that opened the dialog (for "<host> says"); defaults to the tab URL. */
  url?: string | null;
  /** Dialog id used in identities (default "1"). */
  id?: string | number | null;
}

export interface AXSnapshot {
  tab: { id: number; title: string; url: string };
  nodes: AXInputNode[];
  /** When set, the synthetic JS dialog tree (Codex §2.6) is rendered instead of `nodes`. */
  dialog?: AXDialogInfo | null;
}

export interface AXRevision {
  /** identity → element id */
  ids: Map<string, number>;
  /** element id → identity */
  byId: Map<number, string>;
  /** Next id to hand out; ids are never reused. */
  nextId: number;
  /** element id → rendered line (without indentation) */
  lines: Map<number, string>;
  /** Rendered element ids in document order. */
  order: number[];
  /** The full rendering of this revision (never a diff). */
  text: string;
  documentKey: string;
  /** element id → whether the element shows the `settable` flag. */
  settable: Map<number, boolean>;
  /** element id → depth (indentation). */
  depth: Map<number, number>;
  /** element id → parent element id (-1 for roots). */
  parent: Map<number, number>;
  /** Focused element id, if any (it may be an element that is not rendered). */
  focused: number | null;
  /** The focused element's line (footer text after the id). */
  focusedLine: string;
}

export interface RenderOptions {
  mode: "auto" | "full";
  documentKey: string;
  /** Minimum characters a diff must save over the full text (default 1000). */
  minSavedChars?: number;
  /** Minimum fraction a diff must save over the full text (default 0.30). */
  minSavedRatio?: number;
}

export interface RenderResult {
  revision: AXRevision;
  /** Full tree or diff, without the "Browser tab:" header. */
  text: string;
  diff: boolean;
}

export const AX_MAX_CHILDREN = 500;
export const AX_MAX_DEPTH = 200;
export const AX_URL_BUDGET = 4000;
export const AX_URL_MIN_CAP = 20;
export const AX_DIFF_HEADER =
  "The following is a diff from the previous accessibility tree with ~ and + representing changed and added elements, respectively. Removed elements are summarized by ID range.";
export const AX_NO_CHANGE = "There has been no change in the accessibility tree.";
const FOCUS_PREFIX = "The focused UI element is ";

// ---------------------------------------------------------------------------
// Role table

/** text: StaticText; webarea: document root; container: AXGroup-like; bare: no role word; option: no role word, name is the value. */
type Cls = "text" | "webarea" | "container" | "image" | "canvas" | "bare" | "option" | "control";

interface RoleSpec {
  /** role word printed on the line */
  w: string;
  c: Cls;
  /** the accessible name is always exposed as a description (generic, group, link, …) */
  desc?: boolean;
  /** children are not rendered */
  leaf?: boolean;
  /**
   * StaticText children that are dropped: "all" when every child is StaticText, "single" when the
   * only child is StaticText, "dup" when the only child is StaticText equal to the name.
   */
  dropText?: "all" | "single" | "dup";
  /** how `settable` is decided: always, native <input>, or the CDP `settable` property */
  set?: "always" | "input" | "prop" | "select";
  /** value type flag is always boolean (switch) */
  bool?: boolean;
  /** cell: names from contents are hidden */
  cell?: boolean;
  /** text fields stay visible while focused even when empty */
  keepFocused?: boolean;
}

const CONTAINER: RoleSpec = { w: "container", c: "container" };
const ROLES: Record<string, RoleSpec> = {
  RootWebArea: { w: "AXWebArea", c: "webarea" },
  WebArea: { w: "AXWebArea", c: "control" },
  StaticText: { w: "text", c: "text" },
  InlineTextBox: { w: "text", c: "text" },
  LineBreak: { w: "container", c: "container", leaf: true },
  generic: { w: "container", c: "container", desc: true },
  group: { w: "container", c: "container", desc: true },
  tabpanel: { w: "container", c: "container", desc: true },
  radiogroup: { w: "", c: "bare", desc: true },
  button: { w: "button", c: "control", dropText: "single" },
  DisclosureTriangle: { w: "button", c: "control" },
  link: { w: "link", c: "control", desc: true },
  heading: { w: "heading", c: "control" },
  cell: { w: "cell", c: "control", cell: true },
  gridcell: { w: "cell", c: "control", cell: true },
  columnheader: { w: "cell", c: "control", cell: true },
  rowheader: { w: "cell", c: "control", cell: true },
  row: { w: "row", c: "control" },
  treeitem: { w: "row", c: "control" },
  table: { w: "table", c: "control" },
  grid: { w: "table", c: "control" },
  treegrid: { w: "table", c: "control" },
  checkbox: { w: "checkbox", c: "control", dropText: "all", set: "input" },
  radio: { w: "radio button", c: "control", dropText: "all", set: "input" },
  switch: { w: "switch", c: "control", dropText: "single", set: "input", bool: true },
  tab: { w: "tab", c: "control", dropText: "all", set: "always" },
  tablist: { w: "tab group", c: "control" },
  textbox: { w: "text field", c: "control", set: "prop", keepFocused: true },
  searchbox: { w: "search text field", c: "control", set: "prop", keepFocused: true },
  combobox: { w: "combo box", c: "control", set: "prop" },
  ComboBoxMenuButton: { w: "combo box", c: "control", set: "prop" },
  ComboBoxSelect: { w: "pop up button", c: "control", set: "select" },
  list: { w: "content list", c: "control" },
  listbox: { w: "list", c: "control" },
  DescriptionList: { w: "definition list", c: "control" },
  menubar: { w: "menu bar", c: "control" },
  MenuListPopup: { w: "menu", c: "control" },
  toolbar: { w: "toolbar", c: "control" },
  tree: { w: "outline", c: "control" },
  meter: { w: "level indicator", c: "control", leaf: true },
  progressbar: { w: "progress indicator", c: "control", leaf: true },
  scrollbar: { w: "scroll bar", c: "control", leaf: true },
  separator: { w: "splitter", c: "control", leaf: true },
  slider: { w: "slider", c: "control", leaf: true, set: "input" },
  spinbutton: { w: "stepper", c: "control", leaf: true, set: "input" },
  image: { w: "image", c: "image" },
  Canvas: { w: "image", c: "canvas" },
  ListMarker: { w: "AXListMarker", c: "control", dropText: "dup" },
  ColorWell: { w: "color well", c: "control", set: "prop" },
  Date: { w: "date field", c: "control", set: "prop" },
  DateTime: { w: "date field", c: "control", set: "prop" },
  InputTime: { w: "time field", c: "control", set: "prop" },
  Column: { w: "column", c: "control" },
  menuitem: { w: "", c: "bare", dropText: "all" },
  menuitemcheckbox: { w: "", c: "bare", dropText: "all" },
  menuitemradio: { w: "", c: "bare", dropText: "all" },
  option: { w: "", c: "option", dropText: "all" },
  MenuListOption: { w: "", c: "option", dropText: "all" },
};
const POPUP: RoleSpec = { w: "pop up button", c: "control", dropText: "single", set: "prop" };
const SELECT: RoleSpec = { w: "pop up button", c: "control", set: "select" };
const TOGGLE: RoleSpec = { w: "checkbox", c: "control", dropText: "all" };
const TEXTAREA: RoleSpec = { w: "text entry area", c: "control", set: "prop", keepFocused: true };
// Native <input>/<textarea>: the inner editor subtree is not rendered.
const NATIVE_TEXT: RoleSpec = { ...ROLES.textbox!, leaf: true };
const NATIVE_TEXTAREA: RoleSpec = { ...TEXTAREA, leaf: true };
const NATIVE_SEARCH: RoleSpec = { ...ROLES.searchbox!, leaf: true };
const LINK_LEAF: RoleSpec = { w: "link", c: "control", desc: true, leaf: true };
const IMAGE_GROUP: RoleSpec = { w: "container", c: "container" };
const MENU: RoleSpec = { w: "menu", c: "control" };

const has = (v: unknown) => v !== undefined && v !== null;
const isTextRole = (role: string) => role === "StaticText" || role === "InlineTextBox";
const isTrue = (v: unknown) => v === true || v === "true";
const isFalse = (v: unknown) => v === false || v === "false";
const blank = (s: string | null | undefined): boolean => !s || /^[\s\u200b\u200c\u200d\u2060\ufeff]*$/.test(s);

function specFor(n: AXInputNode, hasChildren: boolean, hasMenuItems: boolean): RoleSpec {
  const p = n.properties;
  const tag = n.dom?.tagName?.toLowerCase();
  switch (n.role) {
    case "button":
      if (has(p.pressed)) return TOGGLE;
      if (has(p.hasPopup)) return POPUP;
      return ROLES.button!;
    case "combobox":
      return tag === "select" ? SELECT : ROLES.combobox!;
    case "textbox":
      if (tag === "input" || tag === "textarea") return isTrue(p.multiline) ? NATIVE_TEXTAREA : NATIVE_TEXT;
      return isTrue(p.multiline) ? TEXTAREA : ROLES.textbox!;
    case "searchbox":
      return tag === "input" ? NATIVE_SEARCH : ROLES.searchbox!;
    case "link":
      return has(p.url) && stripUrl(String(p.url)) !== null ? LINK_LEAF : ROLES.link!;
    case "image":
      return hasChildren ? IMAGE_GROUP : ROLES.image!;
    case "menu":
      return hasMenuItems ? MENU : CONTAINER;
  }
  return ROLES[n.role] ?? CONTAINER;
}

// ---------------------------------------------------------------------------
// URLs

/** Codex URL display form: strip `http(s)://` and a leading `www.` host label; data: and relative URLs are dropped. */
export function stripUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || /^data:/i.test(url)) return null;
  let s = url.includes(" ") ? url.replace(/ /g, "%20") : url;
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#@]*@)?(www\.)?/.exec(s);
  if (m) {
    const scheme = m[1] === "http://" || m[1] === "https://" ? "" : m[1]!;
    s = scheme + (m[2] ?? "") + s.slice(m[0].length);
  }
  return s || null;
}

function codePointLength(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { n--; i++; }
  }
  return n;
}

function truncateUrl(s: string, cap: number): string {
  if (s.length <= cap || codePointLength(s) <= cap) return s;
  return Array.from(s).slice(0, cap - 1).join("") + "…";
}

/**
 * Adaptive URL shortening: all URLs together may use at most `budget` characters. If they do not
 * fit, every URL is capped at the largest common length that fits (never below 20 characters);
 * URLs past the budget even at the floor are replaced by "…".
 */
export function urlCap(lengths: number[], budget = AX_URL_BUDGET, floor = AX_URL_MIN_CAP): number {
  let total = 0;
  for (const l of lengths) total += l;
  if (total <= budget) return Infinity;
  const sorted = [...lengths].sort((a, b) => a - b);
  // Largest c with sum(min(len, c)) <= budget.
  let prefix = 0;
  for (let i = 0; i < sorted.length; i++) {
    const remaining = sorted.length - i;
    const c = Math.floor((budget - prefix) / remaining);
    if (c < sorted[i]!) return Math.max(floor, c);
    prefix += sorted[i]!;
  }
  return Infinity;
}

// ---------------------------------------------------------------------------
// Per-node attributes

interface Item {
  /** input node index */
  src: number;
  spec: RoleSpec;
  /** StaticText run value (text items only) */
  text?: string;
  /** merged text source indices beyond `src` */
  merged?: number[];
  children: Item[];
  /** raw child count when the 500-child cap applied */
  total?: number;
  /** URL shown for this item (stripped, before shortening) and whether it is the Value */
  url?: string | null;
  urlIsValue?: boolean;
  /** root of the snapshot (URL not counted in the budget) */
  top?: boolean;
  /** unlabelled image: shown only when its parent is shown for other reasons */
  weak?: boolean;
  /** a bare "container" line (no label, flags or keys) */
  plain?: boolean;
  /** a bare container holding only unlabelled images */
  weakGroup?: boolean;
  /** children (and separators) before splicing and text merging, used when this item is itself spliced */
  raw?: Item[];
  /** for each `raw` entry: whether it is a StaticText child of this item */
  rawDirect?: boolean[];
  id?: number;
  depth?: number;
}

/** Placeholder for a dropped child: separates text runs. */
const BARRIER: Item = { src: -1, spec: CONTAINER, children: [] };
/**
 * Results for a dropped element. SOFT: an empty unnamed wrapper (separates only a parent's own StaticText
 * runs); HARD: an empty control (separates all text runs); GHOST: an element that carried a name, flags or
 * focus (separates text runs and still counts as content of its parent).
 */
const DROP_SOFT: Item[] = [];
const DROP_HARD: Item[] = [];
const DROP_GHOST: Item[] = [];
/** Placeholder for a vanished child: separates only runs of a parent's own StaticText children. */
const SOFT: Item = { src: -2, spec: CONTAINER, children: [] };

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function triState(v: unknown): string | null {
  if (!has(v)) return null;
  if (isTrue(v)) return "1";
  if (isFalse(v)) return "0";
  if (v === "mixed") return "2";
  return null;
}

interface Attrs {
  title: string | null;
  desc: string | null;
  value: string | null;
  valueType: "" | "boolean" | "integer" | "float";
  help: string | null;
  details: string | null;
  placeholder: string | null;
  domId: string | null;
  flags: string[];
  secondary: string | null;
  settable: boolean;
}

function attrsFor(n: AXInputNode, spec: RoleSpec, tab: AXSnapshot["tab"]): Attrs {
  const p = n.properties;
  const cls = spec.c;
  // Name → title or description.
  let title: string | null = null;
  let desc: string | null = null;
  const name = n.name ? n.name : null;
  let value: string | null = null;
  let valueType: Attrs["valueType"] = "";
  if (cls === "option") {
    value = triState(p.checked) ?? triState(p.pressed) ?? str(n.value) ?? name;
  } else if (name !== null) {
    const src = n.nameSource;
    const hidden = (src === "placeholder" && spec.w !== "AXListMarker") || (spec.cell && (src === "contents" || src === undefined));
    if (!hidden) {
      if (spec.desc || src === "attribute") desc = name;
      else title = name;
    }
  }
  if (cls === "webarea" && title === null && desc === null) title = tab.title || null;
  // Value.
  // `selected` (tabs, options, rows) takes precedence over checked/pressed state.
  const tri = has(p.selected) ? null : triState(p.checked) ?? triState(p.pressed);
  const buttonLike = spec === ROLES.button;
  if (cls !== "option" && !buttonLike) {
    if (tri !== null) { value = tri; valueType = "integer"; }
    else if (spec === ROLES.tab && has(p.selected)) { value = isTrue(p.selected) ? "1" : "0"; valueType = "boolean"; }
    else if (spec.w === "heading" && has(p.level)) { value = str(p.level); valueType = "integer"; }
    else if (spec === LINK_LEAF) value = null; // URL shown as the value below
    else {
      value = str(n.value);
      if (typeof n.value === "number") valueType = Number.isInteger(n.value) ? "integer" : "float";
    }
  }
  if (value !== null && value === "") value = null;
  // Flags.
  const flags: string[] = [];
  if (has(p.selected)) {
    if (isTrue(p.selected)) flags.push("selected");
    else if (cls !== "option" && cls !== "bare") flags.push("selectable");
  }
  if (isTrue(p.disabled) && cls !== "container" && spec !== LINK_LEAF) flags.push("disabled");
  let secondary: string | null = null;
  if (has(p.expanded)) {
    const open = isTrue(p.expanded);
    flags.push(open ? "expanded" : "collapsed");
    secondary = open ? "Collapse" : "Expand";
  }
  const tag = n.dom?.tagName?.toLowerCase();
  let settable = false;
  switch (spec.set) {
    case "always": settable = true; break;
    case "input": settable = tag === "input"; break;
    case "prop": settable = isTrue(p.settable); break;
    case "select": settable = isTrue(p.settable) || tag === "select"; break;
  }
  if (settable) {
    flags.push("settable");
    const t = spec.bool ? "boolean" : valueType;
    if (t) flags.push(t);
  }
  const help = n.dom?.hasAriaDescription ? null : n.description || null;
  return {
    title, desc, value, valueType, help,
    details: str(p.valuetext) || null,
    placeholder: str(p.placeholder) || null,
    domId: n.dom?.id || null,
    flags, secondary, settable,
  };
}

function roleWord(n: AXInputNode, spec: RoleSpec): string {
  const rd = n.properties.roledescription;
  if (typeof rd === "string" && !blank(rd) && (spec.c === "control" || spec.c === "webarea" || spec.c === "image" || spec.c === "canvas") && spec.w !== "row" && spec !== LINK_LEAF) return rd;
  return spec.w;
}

const joinLines = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a + "\n" + b);

/** Whether the line carries a label that justifies keeping an element with no children. */
function hasLabel(a: Attrs) {
  return !blank(a.title) || !blank(a.desc) || !blank(a.value) || !blank(a.placeholder);
}

// ---------------------------------------------------------------------------
// Tree building

function buildTree(snapshot: AXSnapshot, nodes: AXInputNode[]): { roots: Item[]; focusedSrc: number; attrs: (Attrs | undefined)[] } {
  const count = nodes.length;
  const childStart = new Int32Array(count + 1);
  const parentOf = new Int32Array(count).fill(-1);
  const depth = new Int32Array(count);
  const valid = new Uint8Array(count);
  const roots: number[] = [];
  const focusCandidates: number[] = [];
  for (let i = 0; i < count; i++) {
    const n = nodes[i]!;
    const p = n.parentIndex;
    if (p === -1 || p === undefined || p === null) { roots.push(i); valid[i] = 1; }
    else if (p >= 0 && p < i && valid[p]) { parentOf[i] = p; depth[i] = depth[p]! + 1; valid[i] = 1; childStart[p + 1]!++; }
    if (valid[i] && isTrue(n.properties?.focused)) focusCandidates.push(i);
  }
  // CSR children lists.
  for (let i = 0; i < count; i++) childStart[i + 1]! += childStart[i]!;
  const childList = new Int32Array(childStart[count]!);
  const fill = childStart.slice(0, count);
  for (let i = 0; i < count; i++) if (valid[i] && parentOf[i]! >= 0) childList[fill[parentOf[i]!]!++] = i;

  const attrs: (Attrs | undefined)[] = new Array(count);
  const visited = new Uint8Array(count);
  /** > 0 while rendering below a selectable element: text runs there are not merged. */
  let inSelectable = 0;
  // The last focused element that is inside the rendered part of the tree (not e.g. under a slider).
  const focusedSrc = () => {
    for (let k = focusCandidates.length - 1; k >= 0; k--) if (visited[focusCandidates[k]!]) return focusCandidates[k]!;
    return -1;
  };
  const tab = snapshot.tab;

  /**
   * Render node `i`. Returns the items that take its place (itself, or its children when it is a
   * transparent wrapper), one of the DROP_* markers when it is dropped, or null when it vanishes
   * without trace (whitespace-only text).
   */
  const process = (i: number): Item[] | null => {
    visited[i] = 1;
    const n = nodes[i]!;
    const p = n.properties;
    const from = childStart[i]!, to = childStart[i + 1]!;
    const rawChildren = to - from;
    // A menu is a "menu" when it holds menu items (anywhere below it); otherwise a plain container.
    let menuItems = false;
    if (n.role === "menu") {
      const stack = [i];
      for (let seen = 0; stack.length && seen < 5000 && !menuItems; seen++) {
        const x = stack.pop()!;
        for (let k = childStart[x]!; k < childStart[x + 1]!; k++) {
          const c = childList[k]!;
          if (nodes[c]!.role.startsWith("menuitem")) { menuItems = true; break; }
          stack.push(c);
        }
      }
    }
    const spec = specFor(n, rawChildren > 0, menuItems);
    if (spec.c === "text") {
      const t = str(n.value) ?? n.name;
      if (t === null) return DROP_HARD;
      // Blank text joins a run (lending it its attributes) but adds no words; blank-only runs are dropped.
      return [{ src: i, spec, text: blank(t) ? "" : t, children: [] }];
    }
    const a = attrsFor(n, spec, tab);
    attrs[i] = a;
    let url: string | null = null;
    let urlIsValue = false;
    if (spec.c === "webarea") url = stripUrl(str(p.url) ?? tab.url);
    else if (spec.c !== "image" && spec.c !== "canvas" && has(p.url)) {
      url = stripUrl(str(p.url));
      urlIsValue = spec === LINK_LEAF;
    }
    const focused = isTrue(p.focused);
    const selectable = has(p.selected);
    // `named`: any label text at all (decides wrapper transparency); `labelled`: a non-blank label (decides keeping).
    const named = a.title !== null || a.desc !== null || a.value !== null || a.placeholder !== null;
    let labelled = hasLabel(a);
    const noKeys = a.secondary === null && a.help === null && a.details === null && a.domId === null && !url;
    const bareLine = noKeys && !a.flags.length;
    const transparent = spec.c === "container" && !named && !selectable && !(focused && isTrue(p.focusable));
    // Selectable elements other than rows and options read their content into their own line.
    const merger = selectable && !focused && spec.c !== "webarea" && spec.w !== "row" && spec.c !== "bare" && spec.c !== "option";
    // Children.
    let kids: Item[] = [];
    let rawKids: Item[] | undefined;
    let rawKidsDirect: boolean[] | undefined;
    let total: number | undefined;
    let ghosts = 0;
    if (depth[i]! < AX_MAX_DEPTH && (!spec.leaf || spec === LINK_LEAF)) {
      const end = Math.min(to, from + AX_MAX_CHILDREN);
      if (rawChildren > AX_MAX_CHILDREN && !spec.leaf) total = rawChildren;
      let skipText = false;
      if (spec.dropText === "all") {
        skipText = true;
        for (let k = from; k < to; k++) {
          const role = nodes[childList[k]!]!.role;
          if (!isTextRole(role) && role !== "LineBreak") { skipText = false; break; }
        }
      } else if (spec.dropText && rawChildren === 1) {
        const cn = nodes[childList[from]!]!;
        skipText = isTextRole(cn.role) && (spec.dropText === "single" || (str(cn.value) ?? cn.name) === n.name);
      }
      if (!skipText) {
        if (merger) inSelectable++;
        const direct: boolean[] = [];
        // A bare container that is a direct child of a bare container is spliced into it, one level only: it
        // contributes its children as they were before its own splicing and text merging. Spliced text only
        // merges with neighbouring StaticText when both are StaticText children of their own parents.
        const splice = transparent && bareLine && rawChildren > 1 && !total;
        const spl: boolean[] = [];
        const raw: Item[] = [];
        const rawDirect: boolean[] = [];
        const push = (it: Item, d: boolean, sp: boolean, own: boolean) => {
          kids.push(it); direct.push(d); spl.push(sp);
          if (own) { raw.push(it); rawDirect.push(d); }
        };
        for (let k = from; k < end; k++) {
          const c = childList[k]!;
          const r = process(c);
          if (r === null) continue; // whitespace text never interrupts a run
          if (r.length === 0) {
            push(r === DROP_SOFT ? SOFT : BARRIER, false, false, true);
            if (r === DROP_GHOST) ghosts++;
            continue;
          }
          const isText = nodes[c]!.role === "StaticText";
          for (const it of r) {
            const spliced = splice && it.plain && parentOf[it.src] === i;
            if (it.weakGroup && !spliced) {
              // A wrapper holding only unlabelled images is shown only when spliced into a bare container.
              push(BARRIER, false, false, true);
              continue;
            }
            if (spliced) {
              raw.push(it); rawDirect.push(isText);
              const list = it.raw ?? it.children;
              for (let g = 0; g < list.length; g++) {
                const x = list[g]!;
                push(x.weakGroup ? BARRIER : x, it.rawDirect?.[g] ?? false, true, false);
              }
              continue;
            }
            push(it, isText, false, true);
          }
        }
        rawKids = raw;
        rawKidsDirect = rawDirect;
        // Unnamed containers merge every run of adjacent text; others only runs of their own StaticText
        // children; focusable elements keep their text runs apart.
        const tidy = (list: Item[], dir: boolean[], sp: boolean[]) =>
          isTrue(p.focusable) || selectable || inSelectable > 0 ? cleanKids(list) : mergeText(list, dir, spec.c === "container" && !named && noKeys && n.name == null, sp);
        if (merger) inSelectable--;
        kids = tidy(kids, direct, spl);
      }
    }
    let strong = 0;
    for (const k of kids) if (!k.weak) strong++;
    if (spec === LINK_LEAF) {
      // A link's URL labels it only when the link wraps visible content; the content itself is not rendered.
      if (strong > 0 && url) labelled = true;
      kids = [];
      strong = 0;
    }
    const item: Item = { src: i, spec, children: kids, url, urlIsValue, ...(total ? { total } : {}) };
    if (strong === 0 && kids.length && ghosts === 0 && transparent && bareLine && !total) {
      item.plain = item.weakGroup = true;
      return [item];
    }
    // An unnamed wrapper around a single element is replaced by it.
    if (transparent && rawChildren === 1 && kids.length === 1) return kids;
    // Dropped elements that carried something ("ghosts") still count as content.
    strong += ghosts;
    if (strong === 0) {
      // Nothing (or only unlabelled images) below: keep only meaningful elements.
      let keep: boolean;
      const disabled = isTrue(p.disabled);
      switch (spec.c) {
        case "webarea": keep = true; break;
        case "image": case "canvas":
          keep = true;
          if (!labelled && noKeys && a.flags.every((f) => f === "disabled") && !isTrue(p.focusable)) item.weak = true;
          break;
        case "container": keep = labelled || selectable || !!total || (isTrue(p.focusable) && (rawChildren > 1 || focused)); break;
        case "bare": case "option":
          keep = labelled || a.secondary !== null ||
            (isTrue(p.focusable) && (a.help !== null || a.details !== null || !!url || a.flags.includes("selected")));
          break;
        default:
          keep = labelled || (!disabled && (selectable || a.secondary !== null || !!total || spec === ROLES.tab || a.settable ||
            isTrue(p.focusable) || (!!spec.keepFocused && focused)));
      }
      if (keep) return [item];
      if (named || a.flags.some((f) => f !== "disabled") || a.secondary !== null || isTrue(p.focusable)) return DROP_GHOST;
      return spec.c === "control" ? DROP_HARD : DROP_SOFT;
    }
    if (transparent && rawChildren === 1 && kids.length === 0 && !focused) return DROP_GHOST;
    // A selectable element (tab, cell, …) reads non-interactive content below it as part of itself: labels
    // and values are joined with newlines.
    if (merger && kids.length) {
      const flat: Item[] = [];
      const mergeable = (list: Item[]): boolean => {
        for (const k of list) {
          if (k.weak) continue;
          if (k.text === undefined) {
            const kp = nodes[k.src]!.properties;
            if (has(kp.selected) || attrs[k.src]!.settable) return false;
          }
          flat.push(k);
          if (!mergeable(k.children)) return false;
        }
        return true;
      };
      if (mergeable(kids)) {
        for (const k of flat) {
          if (k.text !== undefined) { if (k.text) a.value = joinLines(a.value, k.text); }
          else {
            const ka = attrs[k.src]!;
            a.title = joinLines(a.title, ka.title);
            a.desc = joinLines(a.desc, ka.desc);
            a.value = joinLines(a.value, ka.value);
          }
        }
        item.children = kids = [];
      }
    }
    if (kids.length === 1 && ghosts === 0 && kids[0]!.children.length === 0 && spec.c !== "webarea") {
      const k = kids[0]!;
      // An empty container repeating its parent's label is dropped.
      if (k.text === undefined && nodes[k.src]!.role === "generic") {
        const ka = attrs[k.src]!;
        if ((ka.title ?? ka.desc) !== null && (ka.title ?? ka.desc) === (a.title ?? a.desc)) item.children = kids = [];
      }
    }
    if (transparent && bareLine && !total) {
      item.plain = true;
      if (rawKids) { item.raw = rawKids; item.rawDirect = rawKidsDirect; }
    }
    if ((spec.c === "bare" || spec.c === "option") && !named && bareLine && !a.flags.length && !focused && !total) return kids;
    return [item];
  };

  const out: Item[] = [];
  for (const r of roots) {
    const res = process(r);
    if (res) for (const it of res) if (it !== BARRIER) out.push(it);
  }
  const merged = mergeText(out, [], false);
  if (merged.length && roots.length) {
    const first = merged.find((m) => m.spec.c === "webarea");
    if (first) first.top = true;
  }
  return { roots: merged, focusedSrc: focusedSrc(), attrs };
}

/** Drop separators and blank-only text items. */
function cleanKids(kids: Item[]): Item[] {
  let dirty = false;
  for (const k of kids) if (k === BARRIER || k === SOFT || k.text === "") { dirty = true; break; }
  return dirty ? kids.filter((k) => k !== BARRIER && k !== SOFT && k.text !== "") : kids;
}

/**
 * Merge runs of adjacent text items (words joined with a space; the run keeps its first item's identity
 * and attributes) and drop separators. With `any` every pair of adjacent text items merges; otherwise
 * only items flagged in `direct` (a parent's own StaticText children).
 */
function mergeText(kids: Item[], direct: boolean[], any: boolean, spliced?: boolean[]): Item[] {
  let needed = false;
  for (let k = 0; k < kids.length; k++) {
    const it = kids[k]!;
    if (it === BARRIER || it === SOFT || it.text === "" || (it.text !== undefined && k + 1 < kids.length && kids[k + 1]!.text !== undefined)) { needed = true; break; }
  }
  if (!needed) return kids;
  const out: Item[] = [];
  let run: Item | null = null;
  let runDirect = false;
  let runBlocked = false;
  for (let k = 0; k < kids.length; k++) {
    const it = kids[k]!;
    const sp = spliced?.[k] === true;
    if (it === BARRIER) { run = null; continue; }
    if (it === SOFT) { if (!any || sp) run = null; continue; }
    if (it.text !== undefined) {
      const d = direct[k] === true;
      // Text spliced in from a nested container's wrappers stays apart (except StaticText-to-StaticText).
      const blocked = sp && !d;
      if (run !== null && ((any && !blocked && !runBlocked) || (runDirect && d))) {
        runDirect = d;
        runBlocked = blocked;
        let target: Item = run;
        if (target.merged === undefined) { target = { ...target, merged: [] }; out[out.length - 1] = target; run = target; }
        if (it.text) target.text = target.text ? target.text + " " + it.text : it.text;
        target.merged!.push(it.src);
        if (it.merged) for (const m of it.merged) target.merged!.push(m);
        continue;
      }
      run = it;
      runDirect = d;
      runBlocked = blocked;
      out.push(it);
      continue;
    }
    run = null;
    out.push(it);
  }
  return out.some((k) => k.text === "") ? out.filter((k) => k.text !== "") : out;
}

// ---------------------------------------------------------------------------
// Line rendering

/**
 * Label part of a line: the title bare, then `Key: value` pairs. Entries whose text spans several lines
 * move to the end; a lone key (other than Secondary Actions) is printed bare.
 */
function labelFor(title: string | null, keys: [string, string][]): string {
  const entries: [string | null, string][] = title !== null ? [[null, title], ...keys] : keys;
  if (entries.length === 1) {
    const [k, v] = entries[0]!;
    return k === null || k !== "Secondary Actions" ? v : `${k}: ${v}`;
  }
  let multi = false;
  for (const [, v] of entries) if (v.includes("\n")) { multi = true; break; }
  const ordered = multi ? [...entries.filter(([, v]) => !v.includes("\n")), ...entries.filter(([, v]) => v.includes("\n"))] : entries;
  return ordered.map(([k, v]) => (k === null ? v : `${k}: ${v}`)).join(", ");
}

function lineFor(item: Item, nodes: AXInputNode[], attrs: (Attrs | undefined)[], tab: AXSnapshot["tab"], cap: number, budget: { left: number }): string {
  const n = nodes[item.src]!;
  if (item.text !== undefined) {
    const help = n.dom?.hasAriaDescription ? null : n.description || null;
    const domId = n.dom?.id || null;
    const keys: [string, string][] = [];
    if (help !== null) keys.push(["Help", help]);
    keys.push(["Value", item.text]);
    if (domId !== null) keys.push(["ID", domId]);
    return "text " + labelFor(null, keys);
  }
  const a = attrs[item.src] ?? attrsFor(n, item.spec, tab);
  const word = roleWord(n, item.spec);
  let url = item.url ?? null;
  if (url !== null && cap !== Infinity) {
    url = truncateUrl(url, cap);
    if (!item.top) {
      const len = codePointLength(url);
      if (len > budget.left) url = "…";
      else budget.left -= len;
    }
  }
  const keys: [string, string][] = [];
  if (a.desc !== null) keys.push(["Description", a.desc]);
  if (url !== null && !item.urlIsValue) keys.push(["URL", url]);
  if (a.help !== null) keys.push(["Help", a.help]);
  const value = item.urlIsValue && url !== null ? url : a.value;
  if (value !== null) keys.push(["Value", value]);
  if (a.details !== null) keys.push(["Details", a.details]);
  if (a.placeholder !== null) keys.push(["Placeholder", a.placeholder]);
  if (a.domId !== null) keys.push(["ID", a.domId]);
  if (a.secondary !== null) keys.push(["Secondary Actions", a.secondary]);
  const label = labelFor(a.title, keys);
  let line = word;
  if (a.flags.length) line += (line ? " " : "") + "(" + a.flags.join(", ") + ")";
  if (label) line += (line ? " " : "") + label;
  if (item.total) line += ` (showing 0-${AX_MAX_CHILDREN} of ${item.total} items)`;
  return line;
}

// ---------------------------------------------------------------------------
// Dialogs

/** Synthetic accessibility nodes for an open JavaScript dialog (Codex §2.6). */
export function dialogSnapshotNodes(tab: AXSnapshot["tab"], dialog: AXDialogInfo): AXInputNode[] {
  const did = String(dialog.id ?? "1");
  let host = "";
  try { host = new URL(dialog.url || tab.url).host; } catch { host = ""; }
  const node = (parentIndex: number, part: string, role: string, name: string, extra: Partial<AXInputNode> = {}): AXInputNode => ({
    parentIndex, identity: `javascript-dialog:${tab.id}:${did}:${part}`, role, name, nameSource: "attribute",
    description: null, value: null, properties: {}, ...extra,
  });
  const nodes: AXInputNode[] = [
    node(-1, "root", "RootWebArea", tab.title || "Web page", { properties: { url: tab.url } }),
    node(0, "dialog", "alertdialog", host ? `${host} says` : "This page says", { properties: { modal: true } }),
    node(1, "message", "StaticText", dialog.message ?? ""),
  ];
  if (dialog.type === "prompt") {
    nodes.push(node(1, "prompt", "textbox", "Response", {
      value: dialog.promptText ?? dialog.defaultPrompt ?? "",
      properties: { editable: "plaintext", focusable: true, focused: true, settable: true },
      isDialogControl: true,
    }));
  }
  if (dialog.type !== "alert") {
    nodes.push(node(1, "dismiss", "button", dialog.type === "beforeunload" ? "Stay" : "Cancel", { properties: { focusable: true }, isDialogControl: true }));
  }
  nodes.push(node(1, "accept", "button", dialog.type === "beforeunload" ? "Leave" : "OK", {
    properties: { focusable: true, focused: dialog.type !== "prompt" }, isDialogControl: true,
  }));
  return nodes;
}

/** The dialog control ("accept" | "dismiss" | "prompt") an element id refers to, if any. */
export function dialogControlFor(revision: AXRevision, id: number): "accept" | "dismiss" | "prompt" | null {
  const identity = revision.byId.get(id);
  const m = identity ? /^javascript-dialog:.*:(accept|dismiss|prompt)$/.exec(identity) : null;
  return m ? (m[1] as "accept" | "dismiss" | "prompt") : null;
}

// ---------------------------------------------------------------------------
// Revision

export function identityFor(revision: AXRevision, id: number): string | undefined {
  return revision.byId.get(id);
}

export function isSettable(revision: AXRevision, id: number): boolean {
  return revision.settable.get(id) === true;
}

function ranges(ids: number[]): string {
  ids.sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < ids.length; ) {
    let j = i;
    while (j + 1 < ids.length && ids[j + 1] === ids[j]! + 1) j++;
    out.push(i === j ? String(ids[i]) : `${ids[i]}-${ids[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

export function renderRevision(snapshot: AXSnapshot, previous: AXRevision | null, opts: RenderOptions): RenderResult {
  const nodes = snapshot.dialog ? dialogSnapshotNodes(snapshot.tab, snapshot.dialog) : snapshot.nodes;
  const { roots, focusedSrc, attrs } = buildTree(snapshot, nodes);
  const sameDoc = !!previous && previous.documentKey === opts.documentKey;

  // Assign ids in document order; collect URLs for the shortening budget.
  const ids = new Map<string, number>();
  const byId = new Map<number, string>();
  let nextId = previous ? previous.nextId : 0;
  const order: Item[] = [];
  const urlLengths: number[] = [];
  const srcItem = new Map<number, Item>();
  const stack: Item[] = [];
  for (let r = roots.length - 1; r >= 0; r--) { roots[r]!.depth = 0; stack.push(roots[r]!); }
  while (stack.length) {
    const it = stack.pop()!;
    order.push(it);
    let identity = nodes[it.src]!.identity ?? `#${it.src}`;
    if (ids.has(identity)) { let k = 2; while (ids.has(`${identity}#${k}`)) k++; identity = `${identity}#${k}`; }
    let id = sameDoc ? previous!.ids.get(identity) : undefined;
    if (id === undefined) id = nextId++;
    it.id = id;
    ids.set(identity, id);
    byId.set(id, identity);
    srcItem.set(it.src, it);
    if (it.merged) for (const s of it.merged) srcItem.set(s, it);
    if (it.url && !it.top) urlLengths.push(codePointLength(it.url));
    for (let c = it.children.length - 1; c >= 0; c--) { it.children[c]!.depth = it.depth! + 1; stack.push(it.children[c]!); }
  }
  // Ids handed out earlier are never reused, even when previous was another document.
  if (previous && nextId < previous.nextId) nextId = previous.nextId;

  const cap = urlLengths.length ? urlCap(urlLengths) : Infinity;
  const budget = { left: AX_URL_BUDGET };
  const lines = new Map<number, string>();
  const depthOf = new Map<number, number>();
  const parentMap = new Map<number, number>();
  const settable = new Map<number, boolean>();
  const orderIds: number[] = new Array(order.length);
  const parts: string[] = new Array(order.length);
  // Parent ids via a second walk (children know their parent).
  for (const r of roots) parentMap.set(r.id!, -1);
  for (let k = 0; k < order.length; k++) {
    const it = order[k]!;
    const line = lineFor(it, nodes, attrs, snapshot.tab, cap, budget);
    lines.set(it.id!, line);
    depthOf.set(it.id!, it.depth!);
    for (const c of it.children) parentMap.set(c.id!, it.id!);
    settable.set(it.id!, it.text === undefined && (attrs[it.src]?.settable ?? false));
    orderIds[k] = it.id!;
    parts[k] = "\t".repeat(it.depth!) + it.id + " " + line;
  }

  // Focused element: its rendered item, or (like Codex) an id of its own when it is not rendered. The
  // footer describes the element itself (a link shows `URL:`, merged text only its own words).
  let focused: number | null = null;
  let focusedLine = "";
  if (focusedSrc >= 0) {
    const n = nodes[focusedSrc]!;
    const rendered = srcItem.get(focusedSrc);
    const it = rendered && rendered.src === focusedSrc ? rendered : undefined;
    const spec = it ? it.spec : specFor(n, false, false);
    const own: Item = { src: focusedSrc, spec, children: [], top: true };
    if (spec.c === "text") own.text = str(n.value) ?? n.name ?? "";
    else if (spec.c === "webarea") own.url = stripUrl(str(n.properties.url) ?? snapshot.tab.url);
    else if (has(n.properties.url) && spec.c !== "image" && spec.c !== "canvas") own.url = stripUrl(str(n.properties.url));
    if (it) focused = it.id!;
    else {
      let identity = n.identity ?? `#${focusedSrc}`;
      if (ids.has(identity)) identity += "#focus";
      let id = sameDoc ? previous!.ids.get(identity) : undefined;
      if (id === undefined || lines.has(id)) id = nextId++;
      ids.set(identity, id);
      byId.set(id, identity);
      focused = id;
    }
    focusedLine = lineFor(own, nodes, attrs, snapshot.tab, cap, { left: Infinity });
  }
  const footer = focused !== null ? FOCUS_PREFIX + focused + " " + focusedLine : "";
  const full = parts.join("\n") + "\n" + (footer ? "\n" + footer : "");

  const revision: AXRevision = {
    ids, byId, nextId, lines, order: orderIds, text: full, documentKey: opts.documentKey,
    settable, depth: depthOf, parent: parentMap, focused, focusedLine,
  };
  if (!sameDoc || opts.mode === "full") return { revision, text: full, diff: false };

  const diffText = buildDiff(previous!, revision, parts);
  const saved = full.length - diffText.length;
  const minChars = opts.minSavedChars ?? 1000;
  const minRatio = opts.minSavedRatio ?? 0.3;
  if (saved >= minChars && full.length > 0 && saved / full.length >= minRatio) return { revision, text: diffText, diff: true };
  return { revision, text: full, diff: false };
}

function buildDiff(prev: AXRevision, cur: AXRevision, parts: string[]): string {
  const removed: number[] = [];
  for (const id of prev.order) if (!cur.lines.has(id)) removed.push(id);
  // Previous sibling (ignoring removed/added elements) to detect moves and reorders.
  const prevSibling = (rev: AXRevision, keep: (id: number) => boolean) => {
    const last = new Map<number, number>();
    const out = new Map<number, number>();
    for (const id of rev.order) {
      if (!keep(id)) continue;
      const p = rev.parent.get(id) ?? -1;
      out.set(id, last.get(p) ?? -1);
      last.set(p, id);
    }
    return out;
  };
  const inBoth = (id: number) => prev.lines.has(id) && cur.lines.has(id);
  const prevSib = prevSibling(prev, inBoth);
  const curSib = prevSibling(cur, inBoth);
  const out: string[] = [];
  let changes = 0;
  for (let k = 0; k < cur.order.length; k++) {
    const id = cur.order[k]!;
    const old = prev.lines.get(id);
    if (old === undefined) { out.push("+" + parts[k]); changes++; continue; }
    if (old !== cur.lines.get(id) || prev.parent.get(id) !== cur.parent.get(id) || prev.depth.get(id) !== cur.depth.get(id) ||
      prevSib.get(id) !== curSib.get(id)) {
      out.push("~" + parts[k]);
      changes++;
    }
  }
  const footer = cur.focused !== null ? FOCUS_PREFIX + cur.focused + " " + cur.focusedLine : "";
  if (!changes && !removed.length) return AX_NO_CHANGE + (footer ? "\n" + footer : "");
  const lines = [AX_DIFF_HEADER];
  if (removed.length) lines.push("Removed element IDs: " + ranges(removed));
  for (const l of out) lines.push(l);
  if (footer) lines.push(footer);
  return lines.join("\n");
}
