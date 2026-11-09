import { describe, expect, test } from "bun:test";
import { keyEventsFor, parseKeySpec, typeTextEvents, MODIFIER_BITS } from "../src/server/browser/keys";

describe("keyEventsFor", () => {
  test("Return sends Enter with a carriage-return text", () => {
    const { down, up, modifiers } = keyEventsFor("Return", "other");
    expect(modifiers).toBe(0);
    expect(down).toEqual([
      { type: "keyDown", modifiers: 0, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" },
    ]);
    expect(up).toEqual([{ type: "keyUp", modifiers: 0, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }]);
  });

  test("named keys map to DOM key, code and virtual key codes", () => {
    const cases: Array<[string, string, string, number]> = [
      ["Tab", "Tab", "Tab", 9],
      ["Escape", "Escape", "Escape", 27],
      ["BackSpace", "Backspace", "Backspace", 8],
      ["Delete", "Delete", "Delete", 46],
      ["Home", "Home", "Home", 36],
      ["End", "End", "End", 35],
      ["Page_Up", "PageUp", "PageUp", 33],
      ["Page_Down", "PageDown", "PageDown", 34],
      ["Prior", "PageUp", "PageUp", 33],
      ["Left", "ArrowLeft", "ArrowLeft", 37],
      ["Up", "ArrowUp", "ArrowUp", 38],
      ["Right", "ArrowRight", "ArrowRight", 39],
      ["Down", "ArrowDown", "ArrowDown", 40],
      ["ArrowDown", "ArrowDown", "ArrowDown", 40],
      ["F5", "F5", "F5", 116],
      ["F12", "F12", "F12", 123],
      ["Insert", "Insert", "Insert", 45],
      ["Menu", "ContextMenu", "ContextMenu", 93],
    ];
    for (const [spec, key, code, vk] of cases) {
      const e = keyEventsFor(spec).down.at(-1)!;
      expect({ spec, key: e.key, code: e.code, vk: e.windowsVirtualKeyCode, native: e.nativeVirtualKeyCode, type: e.type, text: e.text })
        .toEqual({ spec, key, code, vk, native: vk, type: "rawKeyDown", text: undefined });
    }
  });

  test("printable keys produce text; space and keysym punctuation", () => {
    expect(keyEventsFor("a").down).toEqual([{ type: "keyDown", modifiers: 0, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, text: "a", unmodifiedText: "a" }]);
    expect(keyEventsFor("space").down[0]).toMatchObject({ type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " });
    expect(keyEventsFor("7").down[0]).toMatchObject({ key: "7", code: "Digit7", windowsVirtualKeyCode: 55, text: "7" });
    expect(keyEventsFor("slash").down[0]).toMatchObject({ key: "/", code: "Slash", windowsVirtualKeyCode: 191, text: "/" });
    expect(keyEventsFor("question").down[0]).toMatchObject({ key: "?", code: "Slash", text: "?" });
    expect(keyEventsFor("é").down[0]).toMatchObject({ key: "é", code: "", windowsVirtualKeyCode: 0, text: "é" });
    expect(keyEventsFor("U+00E9").down[0]).toMatchObject({ key: "é", text: "é" });
  });

  test("keypad keys", () => {
    expect(keyEventsFor("KP_0").down[0]).toEqual({
      type: "keyDown", modifiers: 0, key: "0", code: "Numpad0", windowsVirtualKeyCode: 96, nativeVirtualKeyCode: 96, location: 3, isKeypad: true, text: "0", unmodifiedText: "0",
    });
    expect(keyEventsFor("KP_Enter").down[0]).toMatchObject({ key: "Enter", code: "NumpadEnter", windowsVirtualKeyCode: 13, text: "\r", location: 3 });
    expect(keyEventsFor("KP_Add").down[0]).toMatchObject({ key: "+", code: "NumpadAdd", windowsVirtualKeyCode: 107 });
  });

  test("chords press modifiers in order and release them in reverse", () => {
    const { down, up, modifiers } = keyEventsFor("ctrl+shift+Left", "other");
    expect(modifiers).toBe(MODIFIER_BITS.Control | MODIFIER_BITS.Shift);
    expect(down.map((e) => [e.type, e.key, e.modifiers])).toEqual([
      ["rawKeyDown", "Control", 2],
      ["rawKeyDown", "Shift", 10],
      ["rawKeyDown", "ArrowLeft", 10],
    ]);
    expect(up.map((e) => [e.type, e.key, e.modifiers])).toEqual([
      ["keyUp", "ArrowLeft", 10],
      ["keyUp", "Shift", 2],
      ["keyUp", "Control", 0],
    ]);
    expect(down[0]).toMatchObject({ code: "ControlLeft", windowsVirtualKeyCode: 17, location: 1 });
    expect(down[2]!.commands).toBeUndefined(); // no editing commands off macOS
  });

  test("modifier bitmask: Alt=1 Ctrl=2 Meta/super=4 Shift=8", () => {
    expect(keyEventsFor("alt+x").modifiers).toBe(1);
    expect(keyEventsFor("ctrl+x").modifiers).toBe(2);
    expect(keyEventsFor("super+x").modifiers).toBe(4);
    expect(keyEventsFor("cmd+x").modifiers).toBe(4);
    expect(keyEventsFor("shift+x").modifiers).toBe(8);
    expect(keyEventsFor("ctrl+alt+shift+super+x").modifiers).toBe(15);
    // modifier-only chord: the last down event carries the mask
    const shift = keyEventsFor("shift");
    expect(shift.down.at(-1)!.modifiers).toBe(8);
    expect(shift.up).toEqual([{ type: "keyUp", modifiers: 0, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, location: 1 }]);
  });

  test("Shift selects the shifted character; Ctrl/Alt/Meta suppress text", () => {
    expect(keyEventsFor("shift+a").down[1]).toMatchObject({ type: "keyDown", key: "A", code: "KeyA", text: "A", modifiers: 8 });
    expect(keyEventsFor("shift+1").down[1]).toMatchObject({ key: "!", code: "Digit1", text: "!" });
    const ctrlA = keyEventsFor("ctrl+a").down[1]!;
    expect(ctrlA).toMatchObject({ type: "rawKeyDown", key: "a", code: "KeyA", modifiers: 2 });
    expect(ctrlA.text).toBeUndefined();
  });

  test("macOS editing commands", () => {
    expect(keyEventsFor("super+a", "mac").down[1]!.commands).toEqual(["selectAll"]);
    expect(keyEventsFor("super+c", "mac").down[1]!.commands).toEqual(["copy"]);
    expect(keyEventsFor("super+x", "mac").down[1]!.commands).toEqual(["cut"]);
    expect(keyEventsFor("super+v", "mac").down[1]!.commands).toEqual(["paste"]);
    expect(keyEventsFor("super+z", "mac").down[1]!.commands).toEqual(["undo"]);
    expect(keyEventsFor("super+shift+z", "mac").down[2]!.commands).toEqual(["redo"]);
    expect(keyEventsFor("BackSpace", "mac").down[0]!.commands).toEqual(["deleteBackward"]);
    expect(keyEventsFor("alt+BackSpace", "mac").down[1]!.commands).toEqual(["deleteWordBackward"]);
    expect(keyEventsFor("super+Left", "mac").down[1]!.commands).toEqual(["moveToLeftEndOfLine"]);
    expect(keyEventsFor("Return", "mac").down[0]!.commands).toBeUndefined();
    expect(keyEventsFor("super+a", "other").down[1]!.commands).toBeUndefined();
  });

  test("literal plus and case-insensitive names", () => {
    expect(parseKeySpec("ctrl++")).toMatchObject({ modifiers: ["Control"], key: { key: "+" } });
    expect(parseKeySpec("+")).toMatchObject({ modifiers: [], key: { key: "+" } });
    expect(parseKeySpec("CTRL+RETURN")).toMatchObject({ modifiers: ["Control"], key: { key: "Enter" } });
    expect(parseKeySpec("Control_L+Shift_L+t")).toMatchObject({ modifiers: ["Control", "Shift"], key: { code: "KeyT" } });
  });

  test("rejects unknown keys and double keys", () => {
    expect(() => keyEventsFor("NoSuchKey")).toThrow(/Unknown key "NoSuchKey"/);
    expect(() => keyEventsFor("a+b")).toThrow(/more than one non-modifier key/);
    expect(() => keyEventsFor("  ")).toThrow();
  });
});

describe("typeTextEvents", () => {
  test("first character gets key down/up; the rest are char events", () => {
    expect(typeTextEvents("ab")).toEqual([
      { type: "rawKeyDown", key: "a", modifiers: 0, code: "", windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 },
      { type: "char", key: "a", text: "a", unmodifiedText: "a", modifiers: 0, code: "", windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 },
      { type: "keyUp", key: "a", modifiers: 0, code: "", windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 },
      { type: "char", key: "b", text: "b", unmodifiedText: "b", modifiers: 0, code: "", windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 },
    ]);
  });

  test("newline and tab use editing commands, never Enter/Tab keys", () => {
    const events = typeTextEvents("x\ny\tz");
    const special = events.filter((e) => e.commands);
    expect(special.map((e) => [e.type, e.key, e.windowsVirtualKeyCode, e.commands])).toEqual([
      ["rawKeyDown", "Unidentified", 0, ["insertParagraph"]],
      ["rawKeyDown", "Unidentified", 0, ["insertTab"]],
    ]);
    expect(events.filter((e) => e.type === "char").map((e) => e.text).join("")).toBe("xyz");
    expect(events.some((e) => e.key === "Enter" || e.key === "Tab")).toBe(false);
  });

  test("normalises CRLF and keeps astral characters whole", () => {
    expect(typeTextEvents("a\r\nb").filter((e) => e.commands).length).toBe(1);
    expect(typeTextEvents("a\rb").filter((e) => e.commands).length).toBe(1);
    expect(typeTextEvents("😀").filter((e) => e.type === "char").map((e) => e.text)).toEqual(["😀"]);
  });

  test("rejects other control characters", () => {
    expect(() => typeTextEvents("a\u0007b")).toThrow(/U\+0007/);
    expect(() => typeTextEvents("\u001b")).toThrow(/control character/);
    expect(typeTextEvents("")).toEqual([]);
  });
});
