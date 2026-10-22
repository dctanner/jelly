import { useEffect, useRef, useState, type RefObject } from "react";
import { ClipboardCopy, ClipboardPaste, Ellipsis } from "lucide-react";
import { api } from "./api";
import {
  validClipboardText,
  type ComputerClipboardIdentity,
} from "../shared/computer-clipboard";

type Viewer = {
  focus: () => void;
  sendKey: (keysym: number, code: string, down?: boolean) => void;
};
export function ComputerClipboard({
  identity,
  connected,
  connection,
  screen,
}: {
  identity: ComputerClipboardIdentity | null;
  connected: boolean;
  connection: RefObject<Viewer | null>;
  screen: RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState("");
  const [received, setReceived] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [terminal, setTerminal] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null),
    output = useRef<HTMLTextAreaElement>(null);
  const active = useRef({ identity, connected });
  active.current = { identity, connected };
  const operation = useRef<AbortController | null>(null),
    mounted = useRef(true);
  const key = identity ? `${identity.controlId}:${identity.generation}` : "";
  useEffect(() => {
    mounted.current = true;
    setDraft("");
    setReceived(null);
    setMessage("");
    setError("");
    setBusy(false);
    setOpen(false);
    setTerminal(false);
    operation.current?.abort();
    operation.current = null;
    return () => {
      mounted.current = false;
      operation.current?.abort();
      operation.current = null;
    };
  }, [key, connected]);
  function begin() {
    if (
      operation.current ||
      !active.current.connected ||
      !active.current.identity ||
      !connection.current
    )
      return null;
    const controller = new AbortController(),
      viewer = connection.current;
    const captured = { ...active.current.identity };
    operation.current = controller;
    setBusy(true);
    setMessage("");
    setError("");
    const current = () =>
      mounted.current &&
      !controller.signal.aborted &&
      active.current.connected &&
      connection.current === viewer &&
      active.current.identity?.controlId === captured.controlId &&
      active.current.identity?.generation === captured.generation;
    const finish = () => {
      if (operation.current === controller) {
        operation.current = null;
        if (mounted.current) setBusy(false);
      }
    };
    return { controller, viewer, captured, current, finish };
  }
  type Operation = NonNullable<ReturnType<typeof begin>>;
  async function transfer<T>(
    op: Operation,
    direction: "send" | "receive",
    text?: string,
  ) {
    if (!op.current()) throw new Error("Connection changed");
    // Clipboard operations are never replayed, even after an expired session.
    const result = await api<T>(
      `/chrome/share/clipboard/${direction}`,
      {
        method: "POST",
        body: JSON.stringify({
          ...op.captured,
          ...(text === undefined ? {} : { text }),
        }),
        signal: op.controller.signal,
      },
      false,
    );
    if (!op.current()) throw new Error("Connection changed");
    return result;
  }
  function manualPaste() {
    setOpen(true);
    setError(
      "Paste access is unavailable in this browser. Paste into Text to computer below, then choose Send & paste.",
    );
    window.requestAnimationFrame(() => input.current?.focus());
  }
  async function send(
    text: string | undefined,
    paste: boolean,
    useTerminal = terminal,
  ) {
    const op = begin();
    if (!op) return;
    try {
      if (text === undefined) {
        try {
          if (navigator.clipboard?.read) {
            const items = await navigator.clipboard.read();
            if (!op.current()) return;
            const item = items.find((item) =>
              item.types.includes("text/plain"),
            );
            if (!item) {
              setError(
                "Only text can be transferred. Images and files are not supported.",
              );
              return;
            }
            const blob = await item.getType("text/plain");
            if (!op.current()) return;
            if (blob.size > 256 * 1024) {
              setError(
                "Text exceeds the 256 KiB limit. Nothing was transferred.",
              );
              return;
            }
            text = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(await blob.arrayBuffer());
          } else {
            if (!navigator.clipboard?.readText) throw new Error();
            text = await navigator.clipboard.readText();
            if (op.current() && text === "") {
              setOpen(true);
              setMessage(
                "This device has empty or unreadable clipboard text. Use Text options to send empty text deliberately.",
              );
              return;
            }
          }
        } catch {
          if (op.current()) manualPaste();
          return;
        }
      }
      if (!op.current()) return;
      if (!validClipboardText(text)) {
        setOpen(true);
        setError(
          "Use valid Unicode text up to 256 KiB. Nothing was transferred.",
        );
        return;
      }
      try {
        await transfer(op, "send", text);
      } catch {
        if (op.current()) {
          setOpen(true);
          setDraft(text);
          setError(
            "Transfer was not confirmed. Nothing was pasted. Your text is below; check the connection and try again.",
          );
        }
        return;
      }
      if (!op.current()) return;
      setDraft("");
      if (paste) {
        // Release locally held modifiers before an intentional remote shortcut.
        for (const [sym, code] of [
          [0xffe3, "ControlLeft"],
          [0xffe4, "ControlRight"],
          [0xffe1, "ShiftLeft"],
          [0xffe2, "ShiftRight"],
          // noVNC translates Mac/iOS CommandLeft to Alt_L.
          [0xffe9, "AltLeft"],
          [0xffea, "AltRight"],
          [0xffeb, "MetaLeft"],
          [0xffec, "MetaRight"],
        ] as const)
          op.viewer.sendKey(sym, code, false);
        op.viewer.focus();
        op.viewer.sendKey(0xffe3, "ControlLeft", true);
        if (useTerminal) op.viewer.sendKey(0xffe1, "ShiftLeft", true);
        op.viewer.sendKey(0x76, "KeyV", true);
        op.viewer.sendKey(0x76, "KeyV", false);
        if (useTerminal) op.viewer.sendKey(0xffe1, "ShiftLeft", false);
        op.viewer.sendKey(0xffe3, "ControlLeft", false);
      }
      setMessage(
        paste
          ? "Text sent. Paste shortcut sent to the computer."
          : "Text sent to the computer clipboard. Not pasted.",
      );
    } finally {
      op.finish();
    }
  }
  async function copy() {
    const op = begin();
    if (!op) return;
    let text: string | undefined;
    const reading = transfer<{ text: string }>(op, "receive").then((result) => {
      if (!validClipboardText(result.text)) throw new Error("Unsupported text");
      text = result.text;
      return new Blob([result.text], { type: "text/plain" });
    });
    // Safari needs write() and its promised ClipboardItem inside this gesture,
    // not after the network read. The promise refuses stale viewer responses.
    void reading.catch(() => {});
    let writing: Promise<void> | undefined;
    try {
      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined")
        writing = navigator.clipboard.write([
          new ClipboardItem({ "text/plain": reading }),
        ]);
    } catch {
      /* Manual copy remains available. */
    }
    void writing?.catch(() => {});
    try {
      await reading;
      if (!op.current()) return;
      if (writing) {
        try {
          await writing;
          if (op.current()) {
            setReceived(null);
            setMessage(
              text === ""
                ? "Empty text copied to this device."
                : "Copied to this device.",
            );
          }
          return;
        } catch {
          /* The text stays local in the explicit manual-copy panel. */
        }
      }
      if (op.current()) {
        setReceived(text!);
        setOpen(true);
        setMessage(
          text === ""
            ? "The computer clipboard contains empty text."
            : "Text received. Select it below and copy on this device.",
        );
        window.requestAnimationFrame(() => {
          output.current?.focus();
          output.current?.select();
        });
      }
    } catch {
      if (op.current())
        setError(
          "Could not receive text. Copy text on the computer first and retry. Only UTF-8 text up to 256 KiB is supported; images and files are not transferred.",
        );
    } finally {
      op.finish();
    }
  }
  async function copyReceived() {
    if (received === null) return;
    const op = begin();
    if (!op) return;
    const text = received;
    output.current?.focus();
    output.current?.select();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        if (op.current())
          setMessage(
            text === ""
              ? "Empty text copied to this device."
              : "Copied to this device.",
          );
      } else {
        // Explicit gesture-only fallback also handles a deliberately empty clipboard.
        const copyEvent = (event: ClipboardEvent) => {
          event.clipboardData?.setData("text/plain", text);
          event.preventDefault();
        };
        document.addEventListener("copy", copyEvent);
        let copied = false;
        try {
          copied = document.execCommand("copy");
        } finally {
          document.removeEventListener("copy", copyEvent);
        }
        if (op.current())
          setMessage(
            copied
              ? "Copied to this device."
              : text === ""
                ? "Empty text received. This browser cannot copy empty text; use a browser with clipboard access."
                : "Text selected. Use Copy on this device.",
          );
      }
    } catch {
      if (op.current())
        setMessage(
          "Copy access is unavailable. Select the received text and use Copy on this device.",
        );
    } finally {
      op.finish();
    }
  }
  const actions = useRef({ send, terminal });
  actions.current = { send, terminal };
  useEffect(() => {
    const target = screen.current;
    if (!target) return;
    let terminalPaste = false;
    const keyEvent = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.code === "KeyV") {
        // Do not preventDefault: the browser must provide the real paste event.
        event.stopImmediatePropagation();
        if (event.type === "keydown") terminalPaste = event.shiftKey;
      }
    };
    const paste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!active.current.connected) return;
      const data = event.clipboardData;
      if (
        !data ||
        data.files.length ||
        !Array.from(data.types).includes("text/plain")
      ) {
        setError(
          "Only text can be transferred. Images and files are not supported.",
        );
        return;
      }
      void actions.current.send(
        data.getData("text/plain"),
        true,
        terminalPaste || actions.current.terminal,
      );
      terminalPaste = false;
    };
    target.addEventListener("keydown", keyEvent, true);
    target.addEventListener("keyup", keyEvent, true);
    target.addEventListener("paste", paste, true);
    return () => {
      target.removeEventListener("keydown", keyEvent, true);
      target.removeEventListener("keyup", keyEvent, true);
      target.removeEventListener("paste", paste, true);
    };
  }, [screen]);
  const disabled = !connected || busy || !identity;
  return (
    <section className="computer-clipboard" aria-label="Text transfer">
      <div className="computer-clipboard-actions">
        <button disabled={disabled} title="Paste to computer" aria-label="Paste to computer" onClick={() => void send(undefined, true)}>
          <ClipboardPaste size={18} aria-hidden="true" /> <span>Paste to computer</span>
        </button>
        <button disabled={disabled} title="Copy from computer" aria-label="Copy from computer" onClick={() => void copy()}>
          <ClipboardCopy size={18} aria-hidden="true" /> <span>Copy from computer</span>
        </button>
        <button
          aria-expanded={open}
          aria-controls="computer-clipboard-manual"
          aria-label="Text options" title="Text options"
          disabled={!connected}
          onClick={() => setOpen(!open)}
        >
          <Ellipsis className="computer-text-options-icon" size={20} aria-hidden="true" /><span>Text options</span>
        </button>
      </div>
      {busy && <p role="status">Transferring text…</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {open && (
        <div
          id="computer-clipboard-manual"
          className="computer-clipboard-manual"
        >
          <p className="chat-form-hint">
            Text only, up to 256 KiB. Transfers happen only when you ask. Text
            is not saved by Jelly or sent to agents. Computer apps and clipboard
            managers may retain it.
          </p>
          <label className="computer-clipboard-terminal">
            <input
              type="checkbox"
              checked={terminal}
              onChange={(e) => setTerminal(e.target.checked)}
            />{" "}
            Paste into a terminal (Ctrl+Shift+V)
          </label>
          <label htmlFor="computer-clipboard-input">Text to computer</label>
          <textarea
            id="computer-clipboard-input"
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!connected || busy}
            placeholder="Paste text from this device here"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
          <div className="computer-clipboard-actions">
            <button disabled={disabled} onClick={() => void send(draft, true)}>
              Send &amp; paste
            </button>
            <button disabled={disabled} onClick={() => void send(draft, false)}>
              Send without pasting
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setDraft("");
                setReceived(null);
                setMessage("");
                setError("");
              }}
            >
              Clear text
            </button>
          </div>
          {received !== null && (
            <>
              <label htmlFor="computer-clipboard-output">
                Text from computer
              </label>
              <textarea
                id="computer-clipboard-output"
                ref={output}
                value={received}
                readOnly
                spellCheck={false}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button disabled={disabled} onClick={() => void copyReceived()}>
                Copy received text
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
