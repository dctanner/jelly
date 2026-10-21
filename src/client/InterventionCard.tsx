import { useEffect, useId, useRef, useState, type FormEvent } from "react";
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
import { api, control } from "./api";
import type { ChromeStatus } from "./ChromeConnection";
import { ChatFormCard, ChatFormActions } from "./ChatFormCard";
import { DesktopHandoffCard } from "./DesktopConnection";
import { ChromeSharePanel } from "./ChromeSharePanel";
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
  const browserLogin = item.kind === "browser_login";
  const [chromeTask, setChromeTask] = useState<ChromeStatus["task"]>(null);
  const [chromeUnavailable, setChromeUnavailable] = useState(false);
  const [chromeSharing, setChromeSharing] = useState(false);
  const chromeRevision = useRef(0);
  const chromeControlling = useRef(false);
  useEffect(() => {
    if (!browserLogin || !pending) return;
    let disposed = false,
      loading = false;
    const load = async () => {
      if (loading || chromeControlling.current) return;
      loading = true;
      const revision = ++chromeRevision.current;
      try {
        await api("/control-session");
        const state = await api<ChromeStatus>(
          `/chrome?agentId=${encodeURIComponent(item.agentId)}`,
        );
        if (!disposed && revision === chromeRevision.current) {
          setChromeTask(state.task);
          setChromeSharing(!!state.desktopShared);
          setChromeUnavailable(false);
        }
      } catch {
        if (!disposed && revision === chromeRevision.current) {
          setChromeTask(null);
          setChromeUnavailable(true);
        }
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [browserLogin, pending, item.agentId, item.id]);
  const chromeReady =
    !busy &&
    !!chromeTask?.connected &&
    chromeTask.paused &&
    chromeTask.pauseState === "paused" &&
    chromeTask.handoff === item.id;
  const chromeWarning =
    chromeUnavailable || chromeTask?.connected === false
      ? "Chrome disconnected or unavailable—do not enter credentials."
      : chromeTask?.pauseState === "failed"
        ? "Pause failed—do not enter credentials."
        : chromeTask?.pauseState === "resuming"
          ? "Resuming—do not enter credentials."
          : "Pausing—do not enter credentials yet";
  async function chromeControl(operation: "focus" | "resume") {
    if (!chromeReady || chromeSharing || chromeControlling.current) return;
    chromeControlling.current = true;
    ++chromeRevision.current;
    setChromeTask(null);
    setBusy(true);
    setError("");
    try {
      await control(`/chrome/${operation}`, { agentId: item.agentId });
      if (operation === "resume") setSubmitted("completed");
      onChange();
    } catch (e) {
      setError((e as Error).message);
      setChromeTask(null);
      setChromeUnavailable(true);
    } finally {
      chromeControlling.current = false;
      setBusy(false);
    }
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
          : !chromeReady
            ? "Preparing private sign-in"
            : "Private sign-in"
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
            {chromeReady
              ? "Connected Chrome is paused and its debugger detached. Open locally in Chrome, or use full-desktop web VNC. Never enter credentials in chat; return control when finished."
              : chromeWarning}
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
              disabled={busy || !chromeReady || chromeSharing}
              onClick={() => void chromeControl("focus")}
            >
              Open in Chrome
            </button>
            <button type="button" disabled={busy || !chromeReady} onClick={() => setShareOpen(true)}>Open web VNC…</button>
            <button
              type="button"
              className="primary"
              disabled={busy || !chromeReady || chromeSharing}
              onClick={() => void chromeControl("resume")}
            >
              Return control to agent
            </button>
          </ChatFormActions>
          {shareOpen && <ChromeSharePanel agentId={item.agentId} onClose={() => setShareOpen(false)} onChange={onChange} />}
        </>
      )}
    </ChatFormCard>
  );
}
