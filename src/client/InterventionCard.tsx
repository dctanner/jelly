import { useId, useRef, useState, type FormEvent } from "react";
import {
  ShieldCheck,
  Monitor,
  Check,
  AlertCircle,
  LoaderCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import type { Intervention } from "../shared/types";
import { control } from "./api";
import { ChatFormCard, ChatFormActions } from "./ChatFormCard";
export function InterventionCard({
  item,
  onComputer,
  onChange,
  hasInlineTool = false,
}: {
  item: Intervention;
  onComputer: () => void;
  onChange: () => void;
  hasInlineTool?: boolean;
}) {
  const passwordHint = useId();
  const password = useRef<HTMLInputElement>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [browserOpened, setBrowserOpened] = useState(false);
  const [submitted, setSubmitted] = useState<Intervention["status"] | null>(
    null,
  );
  const [submittedResult, setSubmittedResult] =
    useState<Intervention["result"]>(null);
  const status =
    item.status === "pending" ? (submitted ?? item.status) : item.status;
  const pending = status === "pending";
  async function act(approve: boolean, e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    const value = approve ? (password.current?.value ?? "") : undefined;
    if (password.current) password.current.value = "";
    setSubmitted(approve ? "executing" : "denied");
    try {
      const response = await control<Intervention | { ok: boolean }>(
        `/interventions/${item.id}/${approve ? "approve" : "deny"}`,
        approve ? { password: value } : {},
      );
      setSubmitted("status" in response ? response.status : "denied");
      setSubmittedResult("result" in response ? response.result : null);
      onChange();
    } catch (e) {
      setSubmitted(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!pending || (item.kind === "browser_login" && browserOpened)) {
    // The original tool event already carries arguments and the result.
    // Only add a fallback row when that event is outside the loaded history.
    if (hasInlineTool) return null;
    const executing = status === "executing" || pending;
    const label = item.kind === "sudo" ? "Sudo" : "Browser login";
    return (
      <details className="tool-event">
        <summary>
          {executing ? (
            <LoaderCircle size={14} className="spin" />
          ) : status === "completed" ? (
            <Check size={14} />
          ) : (
            <AlertCircle size={14} />
          )}
          <span>
            {busy && status === "denied"
              ? "Dismissing…"
              : pending
                ? "Browser login in progress"
                : `${label} ${status}`}
          </span>
          <code>
            {item.kind === "sudo" ? "request_sudo" : "request_browser_login"}
          </code>
          <ChevronDown size={14} />
        </summary>
        <pre>
          {JSON.stringify(
            { ...item.payload, result: item.result ?? submittedResult },
            null,
            2,
          )}
        </pre>
      </details>
    );
  }
  return (
    <ChatFormCard
      label={item.kind === "sudo" ? "Sudo authentication" : "Browser login"}
      title={
        item.kind === "sudo"
          ? "Administrator password required"
          : "Sign in through the browser"
      }
      icon={
        item.kind === "sudo" ? <ShieldCheck size={22} /> : <Monitor size={22} />
      }
      status={item.kind === "sudo" ? "Needs your approval" : "Private sign-in"}
      description={String(item.payload.reason ?? "")}
      error={error}
    >
      {item.kind === "sudo" ? (
        <>
          <details className="chat-form-group chat-form-details">
            <summary>
              <span className="chat-form-detail-label">
                <span>Review command</span>
                <code>{String(item.payload.executable)}</code>
              </span>
              <ChevronRight size={16} aria-hidden="true" />
            </summary>
            <div className="chat-form-detail-content">
              {typeof item.payload.summary === "string" &&
                item.payload.summary.trim() && (
                  <p className="chat-form-command-summary">
                    {item.payload.summary}
                  </p>
                )}
              <pre aria-label="Command" tabIndex={0}>
                {[
                  item.payload.executable,
                  ...((item.payload.args as string[]) ?? []),
                ]
                  .map((value) => JSON.stringify(value))
                  .join(" ")}
              </pre>
              <dl className="chat-form-metadata">
                <dt>Working directory</dt>
                <dd>{String(item.payload.cwd)}</dd>
              </dl>
            </div>
          </details>
          <form className="chat-form-form" onSubmit={(e) => void act(true, e)}>
            <label className="chat-form-field">
              <span>Sudo password</span>
              <input
                ref={password}
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="Enter password"
                maxLength={1024}
                disabled={busy}
                aria-label="Sudo password"
                aria-describedby={passwordHint}
              />
            </label>
            <p className="chat-form-hint" id={passwordHint}>
              Used for this command only. Never sent to the agent or saved by
              Jelly.
            </p>
            <ChatFormActions>
              <button
                type="button"
                className="chat-form-secondary"
                disabled={busy}
                onClick={() => void act(false)}
              >
                Deny
              </button>
              <button type="submit" className="primary" disabled={busy}>
                {busy ? "Running…" : "Authenticate and run"}
              </button>
            </ChatFormActions>
          </form>
        </>
      ) : (
        <>
          <dl className="chat-form-group chat-form-metadata chat-form-website">
            <dt>Website</dt>
            <dd>{String(item.payload.url)}</dd>
          </dl>
          <p className="chat-form-hint">
            Sign in privately in the shared browser, then return control to the
            agent.
          </p>
          <ChatFormActions>
            <button
              type="button"
              className="chat-form-secondary"
              disabled={busy}
              onClick={() => void act(false)}
            >
              Deny
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                onComputer();
                setBrowserOpened(true);
              }}
            >
              Open browser
            </button>
          </ChatFormActions>
        </>
      )}
    </ChatFormCard>
  );
}
