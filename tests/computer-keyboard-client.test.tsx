await import("./dom");
import { afterEach, expect, test } from "bun:test";
import { ComputerKeyboard } from "../src/client/ComputerKeyboard";
const { render, screen, fireEvent, cleanup } = await import("@testing-library/react");
afterEach(cleanup);
const guard = "\u200b";
function fixture() {
  const keys: [number, string, boolean][] = [];
  let blurs = 0;
  const viewer = { focusOnClick: true, blur() { blurs++; }, sendKey(sym: number, code: string, down: boolean) { keys.push([sym, code, down]); } };
  const connection = { current: viewer };
  const props = { identity: { controlId: "take", generation: 1 }, connected: true, connection };
  const view = render(<ComputerKeyboard {...props} />);
  return { ...view, viewer, keys, connection, blurs: () => blurs,
    input: () => screen.getByRole("textbox", { name: "Remote keyboard input" }) as HTMLTextAreaElement,
    open: () => fireEvent.click(screen.getByRole("button", { name: "Show keyboard" })),
    update: (change: Partial<typeof props>) => { Object.assign(props, change); view.rerender(<ComputerKeyboard {...props} />); },
  };
}
function type(input: HTMLTextAreaElement, text: string, inputType = "insertText", isComposing = false) {
  fireEvent.input(input, { target: { value: guard + text }, inputType, isComposing, data: text });
}
const downs = (keys: [number, string, boolean][]) => keys.filter(key => key[2]).map(key => key[0]);

test("keyboard opens synchronously from toggle, sends balanced Unicode keys and clears text", () => {
  const f = fixture();
  expect(f.keys).toHaveLength(0);
  f.open();
  expect(document.activeElement === f.input()).toBe(true);
  expect(f.blurs()).toBe(1);
  expect(f.viewer.focusOnClick).toBe(false);
  expect(screen.getByRole("button", { name: "Hide keyboard" }).getAttribute("aria-pressed")).toBe("true");
  type(f.input(), "Hi é雪🪼");
  expect(downs(f.keys)).toEqual([72, 105, 32, 233, 0x010096ea, 0x0101fabc]);
  for (let i = 0; i < f.keys.length; i += 2) {
    expect(f.keys[i]![2]).toBe(true);
    expect(f.keys[i + 1]).toEqual([f.keys[i]![0], f.keys[i]![1], false]);
  }
  expect(f.input().value).toBe(guard);
  fireEvent.click(screen.getByRole("button", { name: "Hide keyboard" }));
  expect(f.input().value).toBe("");
  expect(f.viewer.focusOnClick).toBe(true);
});

test("IME emits only committed text and ignores the following duplicate input notification", () => {
  const f = fixture(); f.open();
  fireEvent.compositionStart(f.input());
  type(f.input(), "x", "insertCompositionText", true);
  type(f.input(), "雪", "insertCompositionText", true);
  expect(f.keys).toHaveLength(0);
  fireEvent.compositionEnd(f.input(), { data: "雪" });
  expect(downs(f.keys)).toEqual([0x010096ea]);
  fireEvent.input(f.input(), { inputType: "insertText", data: "雪" });
  expect(f.keys).toHaveLength(2);
  expect(f.input().value).toBe(guard);
});

test("Backspace on the sentinel, Enter, Tab and navigation work without duplicate text input", () => {
  const f = fixture(); f.open();
  fireEvent.input(f.input(), { target: { value: "" }, inputType: "deleteContentBackward" });
  expect(f.input().value).toBe(guard);
  expect(fireEvent.keyDown(f.input(), { key: "Enter", code: "Enter" })).toBe(false);
  fireEvent.keyDown(f.input(), { key: "Backspace", code: "Backspace" });
  fireEvent.click(screen.getByRole("button", { name: "Tab" }));
  fireEvent.click(screen.getByRole("button", { name: "ArrowLeft" }));
  fireEvent.click(screen.getByRole("button", { name: "Escape" }));
  type(f.input(), "\n");
  expect(downs(f.keys)).toEqual([0xff08, 0xff0d, 0xff08, 0xff09, 0xff51, 0xff1b, 0xff0d]);
  const count = f.keys.length;
  expect(fireEvent.keyDown(f.input(), { key: "Tab", code: "Tab", shiftKey: true })).toBe(true);
  expect(f.keys.length).toBe(count);
  fireEvent.keyDown(f.input(), { key: "Escape", code: "Escape" });
  expect(screen.getByRole("button", { name: "Show keyboard" })).toBeTruthy();
  expect(f.keys.length).toBe(count);
});

test("paste, drop, invalid Unicode and oversized commits are not replayed or silently truncated", () => {
  const f = fixture(); f.open();
  expect(fireEvent.paste(f.input())).toBe(false);
  expect(screen.getByText(/Use Paste to computer to transfer/)).toBeTruthy();
  type(f.input(), "clipboard", "insertFromPaste");
  type(f.input(), "drop", "insertFromDrop");
  type(f.input(), "a".repeat(257));
  type(f.input(), "\ud800");
  expect(f.keys).toHaveLength(0);
  expect(f.input().value).toBe(guard);
  expect(screen.getByText(/long or unsupported/)).toBeTruthy();
});

test("connection replacement, Take change and late composition cannot type into a new viewer", () => {
  const f = fixture(); f.open();
  fireEvent.compositionStart(f.input());
  type(f.input(), "private draft", "insertCompositionText", true);
  const oldInput = f.input();
  const replacementKeys: unknown[] = [];
  f.connection.current = { focusOnClick: true, blur() {}, sendKey(...args) { replacementKeys.push(args); } };
  fireEvent.compositionEnd(oldInput);
  expect(f.keys).toHaveLength(0);
  expect(replacementKeys).toHaveLength(0);
  f.update({ identity: { controlId: "replacement", generation: 2 } });
  expect(oldInput.value).toBe("");
  expect(f.input() === oldInput).toBe(false);
  expect(f.viewer.focusOnClick).toBe(true);
  f.open();
  fireEvent.compositionEnd(oldInput, { data: "private draft" });
  type(oldInput, "private draft");
  expect(replacementKeys).toHaveLength(0);
  f.update({ connected: false });
  type(f.input(), "late");
  expect(replacementKeys).toHaveLength(0);
  expect(f.input().value).toBe("");
});

test("blur/unmount discards composing text and restores the captured focus policy", () => {
  const f = fixture();
  f.viewer.focusOnClick = false;
  f.open();
  fireEvent.compositionStart(f.input());
  type(f.input(), "uncommitted", "insertCompositionText", true);
  const element = f.input();
  f.unmount();
  expect(element.value).toBe("");
  expect(f.viewer.focusOnClick).toBe(false);
  expect(f.keys).toHaveLength(0);
});
