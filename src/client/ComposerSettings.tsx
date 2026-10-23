import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import {
  MODEL_OPTIONS,
  MODE_OPTIONS,
  modelsForMode,
  effortsForModel,
  modelSummary,
  EFFORT_OPTIONS,
  modelSpeedNotice,
  type ModelId,
  type Effort,
} from "../shared/models";
import type { Mode } from "../shared/types";
import { api } from "./api";
import { Modal } from "./Modal";
import { useAnchoredPopover } from "./useAnchoredPopover";

export function ComposerSettings({
  agentId,
  mode = "auto",
  activeMode,
  providerLocked = false,
  model,
  effort,
  disabled,
  readOnly = false,
  refresh,
  onBusy,
}: {
  agentId: string;
  mode?: Mode;
  activeMode?: Exclude<Mode, "auto"> | null;
  providerLocked?: boolean;
  model: ModelId;
  effort: Effort;
  disabled: boolean;
  readOnly?: boolean;
  refresh: () => Promise<void>;
  onBusy: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mobile, setMobile] = useState(
    () => window.matchMedia("(max-width: 767px)").matches,
  );
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useAnchoredPopover(open && !mobile, trigger, panel, "above");
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!open || mobile) return;
    const outside = (event: PointerEvent) => {
      if (
        !root.current?.contains(event.target as Node) &&
        !panel.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, mobile]);
  async function save(change: { mode?: Mode; model?: ModelId; effort?: Effort }) {
    if (readOnly) return;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      await api("/config", {
        method: "PUT",
        body: JSON.stringify({ ...change, agentId }),
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  const speedNotice = modelSpeedNotice(model);
  const fields = (
    <div
      className={`composer-settings-fields ${mobile ? "" : "composer-settings-menu floating-popover"}`}
      id="composer-settings-menu"
      role="group"
      aria-label="Model and effort"
      ref={panel}
      onKeyDown={(event) => {
        if (mobile || event.key !== "Tab") return;
        const selects = [
          ...(panel.current?.querySelectorAll<HTMLSelectElement>(
            "select:not(:disabled)",
          ) ?? []),
        ];
        if (event.shiftKey && event.target === selects[0]) {
          event.preventDefault();
          trigger.current?.focus({ preventScroll: true });
        } else if (!event.shiftKey && event.target === selects.at(-1)) {
          const controls = [
            ...(root.current
              ?.closest(".composer-footer")
              ?.querySelectorAll<HTMLElement>(
                "button:not(:disabled), select:not(:disabled)",
              ) ?? []),
          ];
          const next = controls[controls.indexOf(trigger.current!) + 1];
          if (next) {
            event.preventDefault();
            setOpen(false);
            next.focus({ preventScroll: true });
          }
        }
      }}
    >
      <label>
        Provider
        <select aria-label="Provider" value={mode}
          disabled={busy || disabled || readOnly || providerLocked}
          aria-describedby="provider-lock-note"
          onChange={(event) => void save({ mode: event.target.value as Mode })}>
          {MODE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>
      <p className="subtle" id="provider-lock-note">
        {providerLocked ? "Provider locked for this agent. Create a new agent to use another provider; Fresh Session keeps its context and provider."
          : "Choose a provider before the first run. It stays locked afterward, even if that run fails or is cancelled."}
      </p>
      <label>
        Model
        <select
          aria-label="Model"
          value={model}
          disabled={busy || disabled || readOnly}
          onChange={(e) => void save({ model: e.target.value as ModelId })}
        >
          {modelsForMode(mode).map((m) => (
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
          disabled={busy || disabled || readOnly}
          onChange={(e) => void save({ effort: e.target.value as Effort })}
        >
          {effortsForModel(model).map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      {speedNotice && (
        <p className="subtle">{speedNotice}</p>
      )}
      <p className="subtle">
        {readOnly
          ? "Server restart pending. Per-agent settings are unavailable until it restarts; High is shown as the default effort."
          : "Applies to this agent’s next run and becomes the default for new agents. Other agents and existing subagents keep their settings."}
      </p>
      {busy && <p role="status">Saving…</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
  return (
    <div
      className="composer-settings"
      ref={root}
      onBlur={(event) => {
        if (
          !mobile &&
          event.relatedTarget &&
          !root.current?.contains(event.relatedTarget as Node) &&
          !panel.current?.contains(event.relatedTarget as Node)
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
        aria-haspopup={mobile ? "dialog" : undefined}
        aria-controls={open ? "composer-settings-menu" : undefined}
        disabled={disabled}
        title={`${MODEL_OPTIONS.find((m) => m.id === model)?.label} · ${EFFORT_OPTIONS.find((e) => e.id === effort)?.label}`}
        onClick={() => {
          trigger.current?.focus({ preventScroll: true });
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          // The desktop panel is outside DOM tab order after portalling.
          if (open && !mobile && event.key === "Tab" && !event.shiftKey) {
            const first = panel.current?.querySelector<HTMLSelectElement>(
              "select:not(:disabled)",
            );
            if (first) {
              event.preventDefault();
              first.focus({ preventScroll: true });
            }
          }
        }}
      >
        <Settings2 size={20} />
      </button>
      <small className="composer-model-summary">{modelSummary(activeMode ?? mode, model, effort)}</small>
      {open &&
        (mobile
          ? createPortal(
              <Modal
                title="Model and effort"
                className="composer-settings-sheet"
                focusHeading
                onClose={() => setOpen(false)}
              >
                {fields}
              </Modal>,
              root.current?.closest(".app") ?? document.body,
            )
          : createPortal(fields, document.body))}
    </div>
  );
}
