/**
 * Keyboard input for CDP `Input.dispatchKeyEvent`.
 *
 * `keyEventsFor("ctrl+shift+Left", platform)` parses an xdotool-style key spec (`Return`, `Tab`,
 * `super+c`, `KP_0`, `Page_Up`, `F5`, `space`, single characters, DOM key names such as `ArrowLeft`)
 * and returns the events to press it: modifiers go down first (in the order given), then the key;
 * `up` releases the key and then the modifiers in reverse. Every event carries the modifier bitmask
 * in effect (Alt=1, Ctrl=2, Meta/super=4, Shift=8), so `down.at(-1).modifiers` is the chord's mask.
 * On macOS, editing shortcuts carry Chrome editing `commands` (Meta+A → selectAll, Meta+C → copy, …)
 * because Chrome does not run them for synthesized key events.
 *
 * `typeTextEvents(text)` produces Codex-style typing events (§3.2): characters are sent as `char`
 * events; newline and tab use the `insertParagraph` / `insertTab` editing commands instead of Enter
 * and Tab, so typing never submits a form or moves focus.
 */

export type KeyPlatform = "mac" | "other";

export interface KeyEventParams {
  type: "keyDown" | "rawKeyDown" | "keyUp" | "char";
  modifiers: number;
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  text?: string;
  unmodifiedText?: string;
  location?: number;
  isKeypad?: boolean;
  commands?: string[];
  autoRepeat?: boolean;
}

export interface KeyChord {
  /** Modifier names in press order ("Alt" | "Control" | "Meta" | "Shift"). */
  modifiers: ModifierName[];
  /** The non-modifier key, or null for a modifier-only chord such as "shift". */
  key: KeyDefinition | null;
}

export interface KeyEvents {
  down: KeyEventParams[];
  up: KeyEventParams[];
  /** Modifier bitmask held while the key is down. */
  modifiers: number;
}

type ModifierName = "Alt" | "Control" | "Meta" | "Shift";

export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  /** Text produced by the key (printable keys, Enter). */
  text?: string;
  /** Key and text when Shift is held. */
  shiftKey?: string;
  location?: number;
}

export const MODIFIER_BITS: Record<ModifierName, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const MODIFIER_DEFS: Record<ModifierName, KeyDefinition> = {
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18, location: 1 },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17, location: 1 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91, location: 1 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, location: 1 },
};

const MODIFIER_ALIASES: Record<string, ModifierName> = {
  alt: "Alt", option: "Alt", opt: "Alt", alt_l: "Alt", alt_r: "Alt", altgr: "Alt",
  ctrl: "Control", control: "Control", control_l: "Control", control_r: "Control", ctl: "Control",
  super: "Meta", super_l: "Meta", super_r: "Meta", cmd: "Meta", command: "Meta", meta: "Meta", meta_l: "Meta",
  meta_r: "Meta", win: "Meta", windows: "Meta", os: "Meta", hyper: "Meta",
  shift: "Shift", shift_l: "Shift", shift_r: "Shift",
};

// Named (non-character) keys. Keys are lower-cased xdotool keysyms and DOM key names.
const NAMED: Record<string, KeyDefinition> = {};
const def = (names: string[], d: KeyDefinition) => { for (const n of names) NAMED[n.toLowerCase()] = d; };
def(["Return", "Enter", "Linefeed"], { key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
def(["KP_Enter", "NumpadEnter"], { key: "Enter", code: "NumpadEnter", keyCode: 13, text: "\r", location: 3 });
def(["Tab", "ISO_Left_Tab"], { key: "Tab", code: "Tab", keyCode: 9 });
def(["Escape", "Esc"], { key: "Escape", code: "Escape", keyCode: 27 });
def(["BackSpace", "Backspace"], { key: "Backspace", code: "Backspace", keyCode: 8 });
def(["Delete", "Del"], { key: "Delete", code: "Delete", keyCode: 46 });
def(["Insert", "Ins"], { key: "Insert", code: "Insert", keyCode: 45 });
def(["Home"], { key: "Home", code: "Home", keyCode: 36 });
def(["End"], { key: "End", code: "End", keyCode: 35 });
def(["Page_Up", "Prior", "PageUp"], { key: "PageUp", code: "PageUp", keyCode: 33 });
def(["Page_Down", "Next", "PageDown"], { key: "PageDown", code: "PageDown", keyCode: 34 });
def(["Left", "ArrowLeft"], { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 });
def(["Up", "ArrowUp"], { key: "ArrowUp", code: "ArrowUp", keyCode: 38 });
def(["Right", "ArrowRight"], { key: "ArrowRight", code: "ArrowRight", keyCode: 39 });
def(["Down", "ArrowDown"], { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
def(["space", "Space"], { key: " ", code: "Space", keyCode: 32, text: " " });
def(["Caps_Lock", "CapsLock"], { key: "CapsLock", code: "CapsLock", keyCode: 20 });
def(["Num_Lock", "NumLock"], { key: "NumLock", code: "NumLock", keyCode: 144 });
def(["Scroll_Lock", "ScrollLock"], { key: "ScrollLock", code: "ScrollLock", keyCode: 145 });
def(["Print", "PrintScreen"], { key: "PrintScreen", code: "PrintScreen", keyCode: 44 });
def(["Pause", "Break"], { key: "Pause", code: "Pause", keyCode: 19 });
def(["Menu", "ContextMenu", "Apps"], { key: "ContextMenu", code: "ContextMenu", keyCode: 93 });
def(["Help"], { key: "Help", code: "Help", keyCode: 47 });
def(["Clear"], { key: "Clear", code: "NumpadEqual", keyCode: 12 });
for (let f = 1; f <= 24; f++) def([`F${f}`], { key: `F${f}`, code: `F${f}`, keyCode: 111 + f });
for (let d = 0; d <= 9; d++) def([`KP_${d}`, `Numpad${d}`], { key: String(d), code: `Numpad${d}`, keyCode: 96 + d, text: String(d), location: 3 });
def(["KP_Add", "NumpadAdd"], { key: "+", code: "NumpadAdd", keyCode: 107, text: "+", location: 3 });
def(["KP_Subtract", "NumpadSubtract"], { key: "-", code: "NumpadSubtract", keyCode: 109, text: "-", location: 3 });
def(["KP_Multiply", "NumpadMultiply"], { key: "*", code: "NumpadMultiply", keyCode: 106, text: "*", location: 3 });
def(["KP_Divide", "NumpadDivide"], { key: "/", code: "NumpadDivide", keyCode: 111, text: "/", location: 3 });
def(["KP_Decimal", "NumpadDecimal"], { key: ".", code: "NumpadDecimal", keyCode: 110, text: ".", location: 3 });
def(["KP_Separator"], { key: ",", code: "NumpadComma", keyCode: 108, text: ",", location: 3 });
def(["KP_Equal", "NumpadEqual"], { key: "=", code: "NumpadEqual", keyCode: 187, text: "=", location: 3 });
def(["KP_Home"], { key: "Home", code: "Numpad7", keyCode: 36, location: 3 });
def(["KP_End"], { key: "End", code: "Numpad1", keyCode: 35, location: 3 });
def(["KP_Left"], { key: "ArrowLeft", code: "Numpad4", keyCode: 37, location: 3 });
def(["KP_Up"], { key: "ArrowUp", code: "Numpad8", keyCode: 38, location: 3 });
def(["KP_Right"], { key: "ArrowRight", code: "Numpad6", keyCode: 39, location: 3 });
def(["KP_Down"], { key: "ArrowDown", code: "Numpad2", keyCode: 40, location: 3 });
def(["KP_Prior", "KP_Page_Up"], { key: "PageUp", code: "Numpad9", keyCode: 33, location: 3 });
def(["KP_Next", "KP_Page_Down"], { key: "PageDown", code: "Numpad3", keyCode: 34, location: 3 });
def(["KP_Insert"], { key: "Insert", code: "Numpad0", keyCode: 45, location: 3 });
def(["KP_Delete"], { key: "Delete", code: "NumpadDecimal", keyCode: 46, location: 3 });
def(["KP_Begin"], { key: "Clear", code: "Numpad5", keyCode: 12, location: 3 });
def(["AudioVolumeUp", "XF86AudioRaiseVolume"], { key: "AudioVolumeUp", code: "AudioVolumeUp", keyCode: 175 });
def(["AudioVolumeDown", "XF86AudioLowerVolume"], { key: "AudioVolumeDown", code: "AudioVolumeDown", keyCode: 174 });
def(["AudioVolumeMute", "XF86AudioMute"], { key: "AudioVolumeMute", code: "AudioVolumeMute", keyCode: 173 });
def(["BrowserBack", "XF86Back"], { key: "BrowserBack", code: "BrowserBack", keyCode: 166 });
def(["BrowserForward", "XF86Forward"], { key: "BrowserForward", code: "BrowserForward", keyCode: 167 });
def(["BrowserRefresh", "XF86Reload"], { key: "BrowserRefresh", code: "BrowserRefresh", keyCode: 168 });

// US-layout printable characters: char → [code, keyCode, shifted].
const PUNCT: Record<string, [string, number, boolean]> = {
  "-": ["Minus", 189, false], "_": ["Minus", 189, true], "=": ["Equal", 187, false], "+": ["Equal", 187, true],
  "[": ["BracketLeft", 219, false], "{": ["BracketLeft", 219, true], "]": ["BracketRight", 221, false], "}": ["BracketRight", 221, true],
  "\\": ["Backslash", 220, false], "|": ["Backslash", 220, true], ";": ["Semicolon", 186, false], ":": ["Semicolon", 186, true],
  "'": ["Quote", 222, false], "\"": ["Quote", 222, true], "`": ["Backquote", 192, false], "~": ["Backquote", 192, true],
  ",": ["Comma", 188, false], "<": ["Comma", 188, true], ".": ["Period", 190, false], ">": ["Period", 190, true],
  "/": ["Slash", 191, false], "?": ["Slash", 191, true],
  "!": ["Digit1", 49, true], "@": ["Digit2", 50, true], "#": ["Digit3", 51, true], "$": ["Digit4", 52, true],
  "%": ["Digit5", 53, true], "^": ["Digit6", 54, true], "&": ["Digit7", 55, true], "*": ["Digit8", 56, true],
  "(": ["Digit9", 57, true], ")": ["Digit0", 48, true],
};
const SHIFTED_OF: Record<string, string> = {};
for (const [ch, [code, , shifted]] of Object.entries(PUNCT)) if (shifted) SHIFTED_OF[code] = ch;
const DIGIT_SHIFT = ")!@#$%^&*(";

// xdotool keysym names for punctuation.
const KEYSYM_CHARS: Record<string, string> = {
  minus: "-", underscore: "_", equal: "=", plus: "+", bracketleft: "[", braceleft: "{", bracketright: "]",
  braceright: "}", backslash: "\\", bar: "|", semicolon: ";", colon: ":", apostrophe: "'", quoteright: "'",
  quotedbl: "\"", grave: "`", quoteleft: "`", asciitilde: "~", comma: ",", less: "<", period: ".", greater: ">",
  slash: "/", question: "?", exclam: "!", at: "@", numbersign: "#", dollar: "$", percent: "%",
  asciicircum: "^", ampersand: "&", asterisk: "*", parenleft: "(", parenright: ")",
};

/** Key definition for a single printable character (US layout; other characters get code "" / keyCode 0). */
export function charDefinition(ch: string): KeyDefinition {
  if (/^[a-z]$/.test(ch)) {
    const code = `Key${ch.toUpperCase()}`;
    return { key: ch, code, keyCode: ch.toUpperCase().charCodeAt(0), text: ch, shiftKey: ch.toUpperCase() };
  }
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), text: ch, shiftKey: ch };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch, shiftKey: DIGIT_SHIFT[Number(ch)] };
  if (ch === " ") return NAMED.space!;
  const p = PUNCT[ch];
  if (p) {
    const [code, keyCode, shifted] = p;
    return { key: ch, code, keyCode, text: ch, ...(shifted ? {} : SHIFTED_OF[code] ? { shiftKey: SHIFTED_OF[code] } : {}) };
  }
  return { key: ch, code: "", keyCode: 0, text: ch };
}

function keyDefinition(name: string): KeyDefinition {
  if ([...name].length === 1) return charDefinition(name);
  const named = NAMED[name.toLowerCase()];
  if (named) return named;
  const sym = KEYSYM_CHARS[name.toLowerCase()];
  if (sym) return charDefinition(sym);
  // xdotool also accepts single letters by keysym name ("a") and unicode keysyms ("U+00E9" / "0x00e9").
  const uni = /^(?:U\+?|0x)([0-9a-fA-F]{2,6})$/.exec(name);
  if (uni) return charDefinition(String.fromCodePoint(parseInt(uni[1]!, 16)));
  throw new Error(`Unknown key "${name}". Use xdotool key names such as Return, Tab, Escape, BackSpace, Left, Page_Up, F5, KP_0, space or a single character.`);
}

/** Parse an xdotool-style chord ("ctrl+shift+Left", "super+c", "Return", "+", "ctrl++"). */
export function parseKeySpec(spec: string): KeyChord {
  // "U+00E9" names a unicode character; drop its "+" so it is not read as a chord separator.
  const raw = spec.trim().replace(/(^|\+)U\+([0-9a-fA-F]{4,6})(?=$|\+)/g, "$1U$2");
  if (!raw) throw new Error("A key is required, e.g. \"Return\" or \"ctrl+a\".");
  // Split on "+" while allowing a literal "+" key ("+", "ctrl++", "ctrl+plus").
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "+" && cur !== "") { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur !== "") parts.push(cur);
  const modifiers: ModifierName[] = [];
  let key: KeyDefinition | null = null;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!.trim() || parts[i]!;
    const mod = MODIFIER_ALIASES[part.toLowerCase()];
    if (mod && !(i === parts.length - 1 && part.length === 1)) {
      if (!modifiers.includes(mod)) modifiers.push(mod);
      continue;
    }
    if (key) throw new Error(`Key spec "${spec}" names more than one non-modifier key.`);
    key = keyDefinition(part);
  }
  return { modifiers, key };
}

// macOS editing commands for synthesized key events (subset of Playwright's macEditingCommands).
const MAC_COMMANDS: Record<string, string | string[]> = {
  Backspace: "deleteBackward", Escape: "cancelOperation", ArrowUp: "moveUp", ArrowDown: "moveDown",
  ArrowLeft: "moveLeft", ArrowRight: "moveRight", Delete: "deleteForward", Home: "scrollToBeginningOfDocument",
  End: "scrollToEndOfDocument", PageUp: "scrollPageUp", PageDown: "scrollPageDown", F5: "complete",
  "Shift+Backspace": "deleteBackward", "Shift+ArrowUp": "moveUpAndModifySelection",
  "Shift+ArrowDown": "moveDownAndModifySelection", "Shift+ArrowLeft": "moveLeftAndModifySelection",
  "Shift+ArrowRight": "moveRightAndModifySelection", "Shift+Delete": "deleteForward",
  "Shift+Home": "moveToBeginningOfDocumentAndModifySelection", "Shift+End": "moveToEndOfDocumentAndModifySelection",
  "Shift+PageUp": "pageUpAndModifySelection", "Shift+PageDown": "pageDownAndModifySelection",
  "Control+KeyA": "moveToBeginningOfParagraph", "Control+KeyB": "moveBackward", "Control+KeyD": "deleteForward",
  "Control+KeyE": "moveToEndOfParagraph", "Control+KeyF": "moveForward", "Control+KeyH": "deleteBackward",
  "Control+KeyK": "deleteToEndOfParagraph", "Control+KeyN": "moveDown", "Control+KeyP": "moveUp",
  "Control+KeyT": "transpose", "Control+KeyY": "yank", "Control+ArrowLeft": "moveToLeftEndOfLine",
  "Control+ArrowRight": "moveToRightEndOfLine", "Control+ArrowUp": "scrollPageUp", "Control+ArrowDown": "scrollPageDown",
  "Shift+Control+KeyA": "moveToBeginningOfParagraphAndModifySelection", "Shift+Control+KeyE": "moveToEndOfParagraphAndModifySelection",
  "Shift+Control+ArrowLeft": "moveToLeftEndOfLineAndModifySelection", "Shift+Control+ArrowRight": "moveToRightEndOfLineAndModifySelection",
  "Alt+Backspace": "deleteWordBackward", "Alt+Delete": "deleteWordForward", "Alt+ArrowLeft": "moveWordLeft",
  "Alt+ArrowRight": "moveWordRight", "Alt+ArrowUp": ["moveBackward", "moveToBeginningOfParagraph"],
  "Alt+ArrowDown": ["moveForward", "moveToEndOfParagraph"], "Alt+PageUp": "pageUp", "Alt+PageDown": "pageDown",
  "Shift+Alt+Backspace": "deleteWordBackward", "Shift+Alt+Delete": "deleteWordForward",
  "Shift+Alt+ArrowLeft": "moveWordLeftAndModifySelection", "Shift+Alt+ArrowRight": "moveWordRightAndModifySelection",
  "Shift+Alt+ArrowUp": "moveParagraphBackwardAndModifySelection", "Shift+Alt+ArrowDown": "moveParagraphForwardAndModifySelection",
  "Meta+Backspace": "deleteToBeginningOfLine", "Meta+ArrowUp": "moveToBeginningOfDocument",
  "Meta+ArrowDown": "moveToEndOfDocument", "Meta+ArrowLeft": "moveToLeftEndOfLine", "Meta+ArrowRight": "moveToRightEndOfLine",
  "Shift+Meta+Backspace": "deleteToBeginningOfLine", "Shift+Meta+ArrowUp": "moveToBeginningOfDocumentAndModifySelection",
  "Shift+Meta+ArrowDown": "moveToEndOfDocumentAndModifySelection", "Shift+Meta+ArrowLeft": "moveToLeftEndOfLineAndModifySelection",
  "Shift+Meta+ArrowRight": "moveToRightEndOfLineAndModifySelection",
  "Meta+KeyA": "selectAll", "Meta+KeyC": "copy", "Meta+KeyX": "cut", "Meta+KeyV": "paste", "Meta+KeyZ": "undo",
  "Shift+Meta+KeyZ": "redo", "Meta+KeyY": "redo",
};

function macCommands(code: string, modifiers: ModifierName[]): string[] {
  const order: ModifierName[] = ["Shift", "Control", "Alt", "Meta"];
  const shortcut = [...order.filter((m) => modifiers.includes(m)), code].join("+");
  const c = MAC_COMMANDS[shortcut];
  return c === undefined ? [] : Array.isArray(c) ? c : [c];
}

function event(type: KeyEventParams["type"], d: KeyDefinition, modifiers: number, key = d.key): KeyEventParams {
  const e: KeyEventParams = { type, modifiers, key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode };
  if (d.location) e.location = d.location;
  if (d.location === 3) e.isKeypad = true;
  return e;
}

/** CDP key events to press (`down`) and release (`up`) an xdotool-style key chord. */
export function keyEventsFor(spec: string, platform: KeyPlatform = "other"): KeyEvents {
  const chord = parseKeySpec(spec);
  const down: KeyEventParams[] = [];
  const up: KeyEventParams[] = [];
  let mask = 0;
  for (const m of chord.modifiers) {
    mask |= MODIFIER_BITS[m];
    down.push(event("rawKeyDown", MODIFIER_DEFS[m], mask));
  }
  const held = mask;
  if (chord.key) {
    const d = chord.key;
    const shift = (held & MODIFIER_BITS.Shift) !== 0;
    const key = shift && d.shiftKey ? d.shiftKey : d.key;
    // Text is produced only without Ctrl/Alt/Meta (those make shortcuts, not characters).
    const text = held & (MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta) ? undefined : d.text === undefined ? undefined : shift && d.shiftKey ? d.shiftKey : d.text;
    const e = event(text ? "keyDown" : "rawKeyDown", d, held, key);
    if (text) { e.text = text; e.unmodifiedText = d.text === "\r" ? "\r" : d.text; }
    if (platform === "mac" && d.code) {
      const commands = macCommands(d.code, chord.modifiers);
      if (commands.length) e.commands = commands;
    }
    down.push(e);
    up.push(event("keyUp", d, held, key));
  }
  for (let k = chord.modifiers.length - 1; k >= 0; k--) {
    const m = chord.modifiers[k]!;
    mask &= ~MODIFIER_BITS[m];
    up.push(event("keyUp", MODIFIER_DEFS[m], mask));
  }
  return { down, up, modifiers: held };
}

/**
 * Codex-style typing events for `text`: `\r\n` is normalised to `\n`; `\n` and `\t` are sent as
 * `insertParagraph` / `insertTab` editing commands; other control characters are rejected. The first
 * character (and every newline/tab) gets a rawKeyDown/keyUp pair; every other character is a single
 * `char` event, which keeps typing to about one CDP call per character.
 */
export function typeTextEvents(text: string): KeyEventParams[] {
  const normalised = text.replace(/\r\n?/g, "\n");
  // eslint-disable-next-line no-control-regex
  const bad = /[\u0000-\u0008\u000b-\u001f\u007f]/.exec(normalised);
  if (bad) throw new Error(`Text contains an unsupported control character (U+${bad[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}). Only \\n and \\t are allowed; use pressKey for other keys.`);
  const out: KeyEventParams[] = [];
  let first = true;
  for (const ch of normalised) {
    const special = ch === "\n" || ch === "\t";
    const base = { modifiers: 0, code: "", windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 };
    if (first || special) {
      const down: KeyEventParams = { type: "rawKeyDown", key: special ? "Unidentified" : ch, ...base };
      if (special) down.commands = [ch === "\n" ? "insertParagraph" : "insertTab"];
      out.push(down);
    }
    if (!special) out.push({ type: "char", key: ch, text: ch, unmodifiedText: ch, ...base });
    if (first || special) out.push({ type: "keyUp", key: special ? "Unidentified" : ch, ...base });
    first = false;
  }
  return out;
}
