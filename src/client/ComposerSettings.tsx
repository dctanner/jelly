import { useEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import {
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
  ULTRAFAST_NOTICE,
  type ModelId,
  type Effort,
} from "../shared/models";
import { api } from "./api";

export function ComposerSettings({
  model,
  effort,
  disabled,
  refresh,
  onBusy,
}: {
  model: ModelId;
  effort: Effort;
  disabled: boolean;
  refresh: () => Promise<void>;
  onBusy: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  async function save(change: { model?: ModelId; effort?: Effort }) {
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      await api("/config", { method: "PUT", body: JSON.stringify(change) });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <div
      className="composer-settings"
      ref={root}
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget as Node)
        )
          setOpen(false);
      }}
    >
      <button
        type="button"
        className="icon"
        ref={trigger}
        aria-label="Model and effort"
        aria-expanded={open}
        aria-controls="composer-settings-menu"
        disabled={disabled}
        title={`${MODEL_OPTIONS.find((m) => m.id === model)?.label} · ${EFFORT_OPTIONS.find((e) => e.id === effort)?.label}`}
        onClick={() => setOpen(!open)}
      >
        <Settings2 size={20} />
      </button>
      {open && (
        <div
          className="composer-settings-menu"
          id="composer-settings-menu"
          role="group"
          aria-label="Model and effort"
        >
          <label>
            Model
            <select
              ref={first}
              aria-label="Model"
              value={model}
              disabled={busy || disabled}
              onChange={(e) => void save({ model: e.target.value as ModelId })}
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reasoning effort
            <select
              aria-label="Reasoning effort"
              value={effort}
              disabled={busy || disabled}
              onChange={(e) => void save({ effort: e.target.value as Effort })}
            >
              {EFFORT_OPTIONS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </label>
          {model === "gpt-6-astra-ultrafast" && (
            <p className="subtle">{ULTRAFAST_NOTICE}</p>
          )}
          <p className="subtle">Applies to new runs across all chats.</p>
          {busy && <p role="status">Saving…</p>}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
