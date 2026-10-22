import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Keyboard, KeyboardOff } from "lucide-react";
import type { ComputerClipboardIdentity } from "../shared/computer-clipboard";

type Viewer = {
  focusOnClick: boolean;
  blur: () => void;
  sendKey: (keysym: number, code: string, down: boolean) => void;
};
const guard = "\u200b"; // Gives mobile Backspace something to delete, even after a commit.
const special: Record<string, [number, string]> = {
  Backspace: [0xff08, "Backspace"], Delete: [0xffff, "Delete"],
  Enter: [0xff0d, "Enter"], Tab: [0xff09, "Tab"], Escape: [0xff1b, "Escape"],
  ArrowLeft: [0xff51, "ArrowLeft"], ArrowUp: [0xff52, "ArrowUp"],
  ArrowRight: [0xff53, "ArrowRight"], ArrowDown: [0xff54, "ArrowDown"],
  Home: [0xff50, "Home"], End: [0xff57, "End"],
};

/** Human-only soft-keyboard input. No clipboard, API, React text state or storage. */
export function ComputerKeyboard({ identity, connected, connection }: {
  identity: ComputerClipboardIdentity | null;
  connected: boolean;
  connection: RefObject<Viewer | null>;
}) {
  const key = identity ? `${identity.controlId}:${identity.generation}` : "";
  const active = useRef({ key, connected });
  active.current = { key, connected };
  const input = useRef<HTMLTextAreaElement>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const session = useRef<{ key: string; viewer: Viewer; focusOnClick: boolean } | null>(null);
  const composing = useRef<typeof session.current>(null);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const current = () => {
    const captured = session.current;
    return captured && active.current.connected && active.current.key === captured.key &&
      connection.current === captured.viewer && document.activeElement === input.current
      ? captured.viewer : null;
  };
  function clear() {
    const captured = session.current;
    session.current = null;
    composing.current = null;
    if (captured) captured.viewer.focusOnClick = captured.focusOnClick;
    if (input.current) {
      input.current.value = "";
      input.current.blur();
    }
  }
  function close() { clear(); setOpen(false); setMessage(""); }
  useLayoutEffect(() => {
    const element = input.current;
    close();
    return () => { clear(); if (element) element.value = ""; };
  }, [key, connected]);
  function reset() {
    if (!input.current) return;
    input.current.value = guard;
    input.current.setSelectionRange(guard.length, guard.length);
  }
  function toggle() {
    if (session.current) { close(); return; }
    const viewer = connection.current;
    if (!viewer || !active.current.connected || !active.current.key) return;
    viewer.blur(); // The shared canvas-blur handler releases held physical keys.
    session.current = { viewer, key: active.current.key, focusOnClick: viewer.focusOnClick };
    viewer.focusOnClick = false; // Remote pointer taps must not steal keyboard focus.
    setMessage("");
    setOpen(true);
    reset();
    // Must stay in the user's click gesture for iOS/Android keyboard activation.
    input.current?.focus({ preventScroll: true });
  }
  function press(sym: number, code: string) {
    const viewer = current();
    if (!viewer) return;
    // Always balance a pair on the captured viewer, never acquire a new one mid-key.
    viewer.sendKey(sym, code, true);
    viewer.sendKey(sym, code, false);
  }
  function commit(inputType = "") {
    if (composing.current) return;
    if (!current()) { if (input.current) input.current.value = ""; return; }
    const value = input.current!.value;
    const text = (value.startsWith(guard) ? value.slice(guard.length) : value).replace(/\r\n?/g, "\n");
    reset(); // Do not retain committed text, including when rejecting an operation.
    if (/paste|drop/i.test(inputType)) {
      setMessage("Use Paste to computer to transfer clipboard text.");
      return;
    }
    if (inputType === "deleteContentBackward" || (!value && !inputType)) {
      press(...special.Backspace!); return;
    }
    if (inputType === "deleteContentForward") { press(...special.Delete!); return; }
    if (inputType.startsWith("delete")) return;
    const points = Array.from(text, character => character.codePointAt(0)!);
    if (points.length > 256 || points.some(point =>
      (point < 32 && point !== 9 && point !== 10) || point === 127 || (point >= 0xd800 && point <= 0xdfff))) {
      setMessage("Use Paste to computer for long or unsupported text.");
      return;
    }
    for (const point of points) {
      if (point === 10) press(...special.Enter!);
      else if (point === 9) press(...special.Tab!);
      else press(point <= 0xff ? point : 0x01000000 + point, "");
    }
  }
  return <div className="computer-keyboard">
    <button ref={toggleButton} type="button" className="computer-keyboard-toggle" disabled={!connected || !identity}
      title={open ? "Hide keyboard" : "Show keyboard"}
      aria-label={open ? "Hide keyboard" : "Show keyboard"} aria-pressed={open}
      onPointerDown={event => event.preventDefault()} onClick={toggle}>
      {open ? <KeyboardOff size={20} aria-hidden="true" /> : <Keyboard size={20} aria-hidden="true" />}
      <span>Keyboard</span>
    </button>
    <textarea key={key} ref={input} className="computer-keyboard-input" aria-label="Remote keyboard input"
      aria-description="Typing goes to the computer. Escape hides the keyboard. Shift+Tab returns to the controls."
      tabIndex={-1} disabled={!connected} autoComplete="off" autoCorrect="off" autoCapitalize="off"
      spellCheck={false} data-lpignore="true" data-1p-ignore="true"
      onBlur={event => { if (event.currentTarget === input.current) close(); }}
      onCompositionStart={() => { composing.current = current() ? session.current : null; }}
      onCompositionEnd={event => {
        const valid = composing.current !== null && composing.current === session.current && event.currentTarget === input.current;
        composing.current = null;
        if (valid) commit(); else event.currentTarget.value = "";
      }}
      onInput={event => {
        if (event.currentTarget === input.current && !(event.nativeEvent as InputEvent).isComposing)
          commit((event.nativeEvent as InputEvent).inputType);
      }}
      onPaste={event => { event.preventDefault(); event.stopPropagation(); setMessage("Use Paste to computer to transfer clipboard text."); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); close(); toggleButton.current?.focus(); return;
        }
        if (event.key === "Tab" && event.shiftKey) return;
        const mapped = special[event.key];
        if (mapped) {
          event.preventDefault(); event.stopPropagation();
          press(...mapped); reset();
        }
      }} />
    {open && <div className="computer-keyboard-keys" role="group" aria-label="Remote keyboard keys">
      {[["Escape", "Esc"], ["Tab", "Tab"], ["ArrowLeft", "←"], ["ArrowUp", "↑"], ["ArrowDown", "↓"], ["ArrowRight", "→"]].map(([name, label]) =>
        <button key={name} type="button" aria-label={name} onPointerDown={event => event.preventDefault()}
          onClick={() => press(...special[name!]!)}>{label}</button>)}
    </div>}
    {message && <p className="computer-keyboard-message" role="status">{message}</p>}
  </div>;
}
