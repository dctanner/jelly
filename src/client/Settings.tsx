import { useId, useState, type ReactNode } from "react";
import { ChevronRight, Check } from "lucide-react";
import { Modal } from "./Modal";
import { Connections } from "./Connections";
import { McpConnections } from "./McpConnections";
import { api } from "./api";
import {
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
  type ModelId,
  type Effort,
} from "../shared/models";
import type { Mode, Snapshot } from "../shared/types";
import type { Theme } from "./theme";

export function SettingsRow({
  label,
  value,
  icon,
  onClick,
  disabled = false,
}: {
  label: string;
  value?: string;
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  const valueId = useId();
  return (
    <button
      type="button"
      className="settings-row"
      aria-label={label}
      aria-describedby={value ? valueId : undefined}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
      <span>{label}</span>
      {value && (
        <span className="row-value" id={valueId}>
          {value}
        </span>
      )}
      <ChevronRight size={17} aria-hidden="true" />
    </button>
  );
}
function Choices<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { id: T; label: string; detail?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="settings-group choice-list">
      <legend>{label}</legend>
      {options.map((option) => (
        <label className="settings-choice" key={option.id}>
          <input
            type="radio"
            name={label}
            value={option.id}
            checked={value === option.id}
            onChange={() => onChange(option.id)}
          />
          <span>
            {option.label}
            {option.detail && <small>{option.detail}</small>}
          </span>
          {value === option.id && <Check size={19} aria-hidden="true" />}
        </label>
      ))}
    </fieldset>
  );
}
export function Settings({
  data,
  theme,
  setTheme,
  onClose,
  refresh,
}: {
  data: Snapshot;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>(data.config.mode);
  const [model, setModel] = useState<ModelId>(data.config.selectedModel);
  const [effort, setEffort] = useState<Effort>(data.config.effort);
  const [page, setPage] = useState("Settings");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [detailDirty, setDetailDirty] = useState(false);
  const dirty =
    mode !== data.config.mode ||
    model !== data.config.selectedModel ||
    effort !== data.config.effort;
  const modes = [
    {
      id: "auto" as const,
      label: "Automatic",
      detail: "Prefer ChatGPT, then an API key; otherwise use the demo.",
    },
    {
      id: "chatgpt" as const,
      label: "ChatGPT subscription",
      detail: data.config.chatgptReady
        ? "Connected through Pi"
        : "Connect your account in Settings.",
    },
    {
      id: "api" as const,
      label: "OpenAI API",
      detail: data.config.apiReady
        ? "API key configured · billed separately"
        : "Add an API key in Settings.",
    },
    {
      id: "demo" as const,
      label: "Local demo",
      detail: "Scripted responses, no account required.",
    },
  ];
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api("/config", {
        method: "PUT",
        body: JSON.stringify({ mode, model, effort }),
      });
      await refresh();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={page}
      onClose={onClose}
      detent="large"
      className="settings-sheet"
      dirty={dirty || detailDirty}
      backDiscards={detailDirty}
      dismissible={!busy}
      cancelLabel="Cancel"
      onBack={
        page === "Settings"
          ? undefined
          : () => {
              setDetailDirty(false);
              setPage("Settings");
            }
      }
      actions={
        <button
          type="button"
          className="sheet-nav strong"
          aria-label="Save settings"
          disabled={busy || detailDirty}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Done"}
        </button>
      }
    >
      {page === "Settings" && (
        <>
          <section className="settings-section">
            <h3>Appearance</h3>
            <div className="settings-group">
              <SettingsRow
                label="Theme"
                value={theme[0]!.toUpperCase() + theme.slice(1)}
                onClick={() => setPage("Appearance")}
              />
            </div>
          </section>
          <section className="settings-section">
            <h3>Model</h3>
            <div className="settings-group">
              <SettingsRow
                label="Model"
                value={MODEL_OPTIONS.find((m) => m.id === model)?.label}
                onClick={() => setPage("Model")}
              />
              <SettingsRow
                label="Reasoning effort"
                value={EFFORT_OPTIONS.find((e) => e.id === effort)?.label}
                onClick={() => setPage("Reasoning effort")}
              />
            </div>
          </section>
          <section className="settings-section">
            <h3>Connections</h3>
            <div className="settings-group">
              <SettingsRow
                label="Model access"
                value={modes.find((m) => m.id === mode)?.label}
                onClick={() => setPage("Model access")}
              />
              <SettingsRow
                label="ChatGPT"
                value={data.config.chatgptReady ? "Connected" : "Not connected"}
                onClick={() => setPage("ChatGPT")}
              />
              <SettingsRow
                label="OpenAI API"
                value={data.config.apiReady ? "Connected" : "Not connected"}
                onClick={() => setPage("OpenAI API")}
              />
            </div>
          </section>
          <section className="settings-section">
            <h3>Tools</h3>
            <div className="settings-group">
              <SettingsRow
                label="MCP connections"
                onClick={() => setPage("MCP connections")}
              />
            </div>
          </section>
          <section className="settings-section">
            <h3>Advanced</h3>
            <div className="settings-group">
              <SettingsRow
                label="Workspace & access"
                onClick={() => setPage("Workspace & access")}
              />
            </div>
          </section>
          <p className="settings-footnote">
            Model and access changes apply to new runs when you tap Done.
          </p>
        </>
      )}
      {page === "Appearance" && (
        <>
          <Choices
            label="Appearance"
            value={theme}
            options={[
              { id: "system", label: "System" },
              { id: "light", label: "Light" },
              { id: "dark", label: "Dark" },
            ]}
            onChange={setTheme}
          />
          <p className="settings-footnote">Appearance is saved immediately.</p>
        </>
      )}
      {page === "Model" && (
        <Choices
          label="Model"
          value={model}
          options={MODEL_OPTIONS}
          onChange={setModel}
        />
      )}
      {page === "Reasoning effort" && (
        <>
          <Choices
            label="Reasoning effort"
            value={effort}
            options={EFFORT_OPTIONS}
            onChange={setEffort}
          />
          <p className="settings-footnote">
            Higher effort gives the model more time to reason.
          </p>
        </>
      )}
      {page === "Model access" && (
        <Choices
          label="Model access"
          value={mode}
          options={modes}
          onChange={setMode}
        />
      )}
      {(page === "ChatGPT" || page === "OpenAI API") && (
        <Connections
          onDirty={setDetailDirty}
          only={page === "ChatGPT" ? "chatgpt" : "api"}
          onConnected={(next) => {
            setMode(next);
            void refresh();
          }}
        />
      )}
      {page === "MCP connections" && <McpConnections />}
      {page === "Workspace & access" && (
        <div className="settings-group settings-description">
          <strong>{data.instance.name}</strong>
          <p>
            Full access · All Pi tools enabled. Actions run without approval.
          </p>
          <p>Your agents and conversations stay on this Jelly instance.</p>
        </div>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </Modal>
  );
}
