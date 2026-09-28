import { useRef, useState, type FormEvent } from "react";
import {
  ShieldCheck,
  Monitor,
  Check,
  AlertCircle,
  LoaderCircle,
  ChevronDown,
} from "lucide-react";
import type { Intervention } from "../shared/types";
import { control } from "./api";
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
    <section
      className="intervention-card"
      aria-label={
        item.kind === "sudo" ? "Sudo authentication" : "Browser login"
      }
    >
      <div className="intervention-title">
        {item.kind === "sudo" ? (
          <ShieldCheck size={18} />
        ) : (
          <Monitor size={18} />
        )}
        <strong>
          {item.kind === "sudo"
            ? "Administrator password required"
            : "Sign in through the browser"}
        </strong>
        <span>{item.status}</span>
      </div>
      <p>{String(item.payload.reason)}</p>
      {item.kind === "sudo" ? (
        <>
          <pre>
            {[
              item.payload.executable,
              ...((item.payload.args as string[]) ?? []),
            ]
              .map((v) => JSON.stringify(v))
              .join(" ")}
          </pre>
          <small>Working directory: {String(item.payload.cwd)}</small>
          {pending && (
            <form onSubmit={(e) => void act(true, e)}>
              <label>
                Sudo password
                <input
                  ref={password}
                  type="password"
                  autoComplete="off"
                  maxLength={1024}
                  disabled={busy}
                  aria-label="Sudo password"
                />
              </label>
              <p className="subtle">
                Used for this command only. Never sent to the agent or saved by
                Jelly. The operating system requires authentication for this
                command.
              </p>
              <div className="intervention-actions">
                <button className="primary" disabled={busy}>
                  {busy ? "Running…" : "Authenticate and run"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act(false)}
                >
                  Deny
                </button>
              </div>
            </form>
          )}
        </>
      ) : (
        <>
          <p className="subtle">{String(item.payload.url)}</p>
          {pending && (
            <div className="intervention-actions">
              <button
                className="primary"
                onClick={() => {
                  onComputer();
                  setBrowserOpened(true);
                }}
              >
                Open browser
              </button>
              <button disabled={busy} onClick={() => void act(false)}>
                Deny
              </button>
            </div>
          )}
        </>
      )}
      {item.status === "failed" && (
        <p className="error-text" role="alert">
          {String(item.result?.stderr || "The command failed.")} Ask the agent
          to try again.
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
