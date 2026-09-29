import { useLayoutEffect, useRef, useState } from "react";
import { ClipboardPaste, Copy } from "lucide-react";
import { control } from "./api";
import { copyText } from "./clipboard";
import { ChatFormActions, ChatFormCard } from "./ChatFormCard";

const MAX_TEXT = 12000;
/** Mounted only on the connected owner's desktop. Never mirror clipboards or
 * persist this state; text may be a password supplied through a private handoff. */
export function RemoteClipboard({
  paste,
  disabled = false,
}: {
  paste: () => void;
  disabled?: boolean;
}) {
  const [mode, setMode] = useState<"paste" | "copy" | null>(null);
  const [hasText, setHasText] = useState(false);
  const [copyRevision, setCopyRevision] = useState(0);
  const pendingCopy = useRef("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  const allowed = useRef(!disabled);
  allowed.current = !disabled;
  const inFlight = useRef(false);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pendingCopy.current = "";
      if (field.current) field.current.value = "";
    };
  }, []);
  useLayoutEffect(() => {
    if (mode === "copy" && field.current)
      field.current.value = pendingCopy.current;
    pendingCopy.current = "";
  }, [mode, copyRevision]);
  function clearText() {
    if (field.current) field.current.value = "";
    pendingCopy.current = "";
    setHasText(false);
  }
  function clear() {
    setMode(null);
    clearText();
    setError("");
    setMessage("");
  }
  function validate(value: string) {
    if (value.length > MAX_TEXT || value.includes("\0"))
      throw new Error(
        "Use text up to 12,000 characters, without null characters.",
      );
  }
  async function run(action: () => Promise<void>) {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function send(value: string) {
    validate(value);
    if (!value) throw new Error("There is no text to paste.");
    clearText();
    await control("/computer/clipboard", { operation: "write", text: value });
    if (!alive.current || !allowed.current) return;
    paste();
    setMode(null);
    clearText();
    setMessage("Paste sent to the focused remote field.");
  }
  async function pasteLocal() {
    await run(async () => {
      let value: string;
      try {
        if (!navigator.clipboard?.readText) throw new Error("Unavailable");
        value = await navigator.clipboard.readText();
      } catch {
        if (alive.current) {
          clearText();
          setMode("paste");
        }
        return;
      }
      if (alive.current && allowed.current) await send(value);
    });
  }
  async function copyRemote() {
    await run(async () => {
      const result = await control<{ text: string }>("/computer/clipboard", {
        operation: "read",
      });
      if (!alive.current || !allowed.current) return;
      validate(result.text);
      if (!result.text)
        throw new Error(
          "Remote clipboard is empty. Copy text in the remote browser first.",
        );
      try {
        await copyText(result.text);
        if (alive.current) {
          setMode(null);
          clearText();
          setMessage("Copied remote clipboard to this device.");
        }
      } catch {
        if (alive.current) {
          pendingCopy.current = result.text;
          setCopyRevision((v) => v + 1);
          setMode("copy");
        }
      }
    });
  }
  return (
    <section className="remote-clipboard" aria-label="Remote clipboard">
      <div className="remote-clipboard-actions">
        <button
          type="button"
          className="secondary"
          disabled={disabled || busy}
          onClick={() => void pasteLocal()}
        >
          <ClipboardPaste size={16} aria-hidden="true" /> Paste to remote
        </button>
        <button
          type="button"
          className="secondary"
          disabled={disabled || busy}
          onClick={() => void copyRemote()}
        >
          <Copy size={16} aria-hidden="true" /> Copy from remote
        </button>
      </div>
      <p className="subtle">
        Focus a remote field before pasting. To copy back, first copy text
        inside the remote browser. Text only; clipboard contents are not saved
        in chat.
      </p>
      {message && <p role="status">{message}</p>}
      {error && !mode && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {mode && (
        <ChatFormCard
          title={
            mode === "paste"
              ? "Paste into the remote browser"
              : "Copy remote clipboard"
          }
          icon={
            mode === "paste" ? <ClipboardPaste size={20} /> : <Copy size={20} />
          }
          status="Private clipboard transfer"
          error={error}
          description={
            mode === "paste"
              ? "This browser blocked clipboard access. Paste text below, then send it to the focused remote field."
              : "This browser blocked copying. Select the text below and use your device’s Copy command."
          }
        >
          <form
            className="chat-form-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (mode === "paste") {
                const value = field.current?.value ?? "";
                void run(() => send(value));
              }
            }}
          >
            <div className="chat-form-field">
              <label htmlFor="remote-clipboard-text">
                {mode === "paste" ? "Text to paste" : "Remote clipboard text"}
              </label>
              <textarea
                id="remote-clipboard-text"
                ref={field}
                readOnly={mode === "copy"}
                disabled={busy || disabled}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                rows={4}
                onChange={(e) => {
                  try {
                    validate(e.target.value);
                    setHasText(!!e.target.value);
                    setError("");
                  } catch (err) {
                    e.target.value = "";
                    setHasText(false);
                    setError((err as Error).message);
                  }
                }}
              />
            </div>
            <ChatFormActions>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={clear}
              >
                {mode === "paste" ? "Cancel" : "Done"}
              </button>
              {mode === "paste" ? (
                <button
                  type="submit"
                  className="primary"
                  disabled={busy || disabled || !hasText}
                >
                  Paste text
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    field.current?.focus();
                    field.current?.select();
                  }}
                >
                  Select text
                </button>
              )}
            </ChatFormActions>
          </form>
        </ChatFormCard>
      )}
    </section>
  );
}
