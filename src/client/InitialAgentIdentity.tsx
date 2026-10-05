import { useEffect, useRef, useState } from "react";
import type { AgentRecord } from "../shared/types";
import { AVATARS } from "../shared/avatars";
import { Avatar } from "./Avatar";
import { api } from "./api";
import "./InitialAgentIdentity.css";

/** Before the first message, edit the identity itself rather than opening a sheet. */
export function InitialAgentIdentity({
  agent,
  disabled,
  onSaved,
  onEditing,
}: {
  agent: AgentRecord;
  disabled: boolean;
  onSaved: (agent: AgentRecord) => void;
  onEditing: (editing: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.name);
  const [changed, setChanged] = useState(false);
  const [avatars, setAvatars] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const nameButton = useRef<HTMLButtonElement>(null);
  const avatarButton = useRef<HTMLButtonElement>(null);
  const choices = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onEditing(editing || busy);
    return () => onEditing(false);
  }, [editing, busy, onEditing]);
  useEffect(() => {
    if (!avatars) return;
    choices.current
      ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      ?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!pending.current && !root.current?.contains(event.target as Node))
        setAvatars(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [avatars]);

  async function save(input: {
    name?: string;
    nameEdited?: boolean;
    avatarId?: string;
  }) {
    if (disabled || pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const updated = await api<AgentRecord>(`/agents/${agent.id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      });
      onSaved(updated);
      return true;
    } catch (error) {
      setError((error as Error).message);
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function cancelName() {
    if (pending.current) return;
    setEditing(false);
    setChanged(false);
    setError("");
    window.requestAnimationFrame(() => nameButton.current?.focus());
  }
  async function saveName() {
    if (pending.current || disabled) return;
    if (!name.trim()) {
      setError("Enter an agent name.");
      return;
    }
    // An explicit edit back to New Agent is still a manual choice. Merely
    // opening and closing the field must not opt out of automatic naming.
    if (!changed || (await save({ name: name.trim(), nameEdited: true }))) {
      setEditing(false);
      setChanged(false);
      setError("");
    }
  }
  function closeAvatars() {
    setAvatars(false);
    setError("");
    window.requestAnimationFrame(() => avatarButton.current?.focus());
  }
  return (
    <div
      className="initial-agent-profile"
      ref={root}
      onKeyDown={(event) => {
        if (
          event.key !== "Escape" ||
          event.nativeEvent.isComposing ||
          pending.current
        )
          return;
        if (editing || avatars) {
          event.preventDefault();
          event.stopPropagation();
          if (editing) cancelName();
          else closeAvatars();
        }
      }}
    >
      <div
        className="initial-agent-identity"
        role="group"
        aria-label="Agent profile"
      >
        <button
          ref={avatarButton}
          type="button"
          className="initial-agent-avatar"
          aria-label="Edit agent avatar"
          aria-expanded={avatars}
          disabled={disabled || busy || editing}
          onClick={() => {
            setError("");
            setAvatars(!avatars);
          }}
        >
          <Avatar agent={agent} size="small" />
        </button>
        <div className="initial-agent-name">
          {editing ? (
            <span className="inline-agent-name">
              <span className="inline-agent-name-measure" aria-hidden="true">
                {name || " "}
              </span>
              <input
                className="inline-agent-name-input"
                aria-label="Agent name"
                autoFocus
                maxLength={60}
                value={name}
                disabled={busy || disabled}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => {
                  setName(event.target.value);
                  setChanged(true);
                  setError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                onBlur={() => void saveName()}
              />
            </span>
          ) : (
            <button
              ref={nameButton}
              type="button"
              className="initial-agent-title"
              aria-label="Edit agent name"
              title={agent.name}
              disabled={disabled || busy}
              onClick={() => {
                setName(agent.name);
                setChanged(false);
                setError("");
                setAvatars(false);
                setEditing(true);
              }}
            >
              {agent.name}
            </button>
          )}
          {(busy || agent.archivedAt || disabled) && (
            <span className="header-status">
              {busy ? "Saving…" : agent.archivedAt ? "Archived" : "Offline"}
            </span>
          )}
        </div>
      </div>
      {error && (
        <p className="error-text identity-error" role="alert">
          {error}
        </p>
      )}
      {avatars && (
        <div
          ref={choices}
          className="sea-avatar-grid"
          role="group"
          aria-label="Sea creature avatars"
        >
          {AVATARS.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={agent.avatarId === id}
              disabled={busy || disabled}
              onClick={async () => {
                if (await save({ avatarId: id })) closeAvatars();
              }}
            >
              <Avatar agent={{ ...agent, avatarId: id }} />
              <span>{id.replaceAll("-", " ")}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
