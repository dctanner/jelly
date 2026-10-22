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
import { DesktopHandoffCard } from "./DesktopConnection";
import { ComputerControlPanel } from "./ComputerControlPanel";
export function InterventionCard({
  item,
  onChange,
  hasInlineTool = false,
}: {
  item: Intervention;
  onChange: () => void;
  hasInlineTool?: boolean;
}) {
  const passwordHint = useId();
  const password = useRef<HTMLInputElement>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [submitted, setSubmitted] = useState<Intervention["status"] | null>(
    null,
  );
  const [submittedResult, setSubmittedResult] =
    useState<Intervention["result"]>(null);
  const status =
    item.status === "pending" ? (submitted ?? item.status) : item.status;
  const pending = status === "pending";
  async function chromeDone() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await control("/chrome/done", { agentId: item.agentId, handoff: item.id });
      setSubmitted("completed");
      onChange();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
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
  if (!pending) {
    // The original tool event already carries arguments and the result.
    // Only add a fallback row when that event is outside the loaded history.
    if (hasInlineTool) return null;
    const executing = status === "executing";
    const label = item.kind === "sudo" ? "Sudo" : item.kind === "desktop_handoff" ? "Desktop handoff" : "Browser login";
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
              : `${label} ${status}`}
          </span>
          <code>
            {item.kind === "sudo" ? "request_sudo" : item.kind === "desktop_handoff" ? "request_desktop_handoff" : "request_browser_login"}
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
  if (item.kind === "desktop_handoff") return <DesktopHandoffCard item={item} onChange={onChange} />;
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
      status={
        item.kind === "sudo"
          ? "Needs your approval"
          : "Needs your sign-in"
      }
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
            Sign in on the computer, never in chat. Other browser work may continue.
            Done tells the requesting agent you’ve finished.
          </p>
          <ChatFormActions>
            <button type="button" disabled={busy} onClick={() => void act(false)}>Cancel</button>
            <button type="button" disabled={busy} onClick={() => setShareOpen(true)}>Take control</button>
            <button type="button" className="primary" disabled={busy} onClick={() => void chromeDone()}>Done</button>
          </ChatFormActions>
          {shareOpen && <ComputerControlPanel agentId={item.agentId} onClose={() => setShareOpen(false)} onChange={onChange} />}
        </>
      )}
    </ChatFormCard>
  );
}
