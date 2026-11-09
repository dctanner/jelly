import { useEffect, useRef, useState, type FormEvent } from "react";
import type { FirecrawlStatus } from "../shared/types";
import { api, control } from "./api";

export function FirecrawlConnection({
  onDirty,
  onBusy,
}: {
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const key = useRef<HTMLInputElement>(null);
  const operationVersion = useRef(0);
  const [status, setStatus] = useState<FirecrawlStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let cancelled = false;
    const version = operationVersion.current;
    api<FirecrawlStatus>("/settings/firecrawl")
      .then((next) => { if (!cancelled && version === operationVersion.current) setStatus(next); })
      .catch((error) => { if (!cancelled && version === operationVersion.current) setError((error as Error).message); });
    return () => { cancelled = true; };
  }, []);
  async function act(operation: () => Promise<FirecrawlStatus>, message: string) {
    if (busy) return;
    operationVersion.current++;
    setBusy(true);
    onBusy(true);
    setError("");
    setNotice("");
    try {
      setStatus(await operation());
      setNotice(message);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    const value = key.current?.value ?? "";
    if (key.current) key.current.value = "";
    onDirty(false);
    void act(() => api("/settings/firecrawl", {
      method: "PUT", body: JSON.stringify({ key: value }),
    }), "Firecrawl key saved. The next web request will use it.");
  }
  return (
    <fieldset className="account-connections">
      <legend>Web research</legend>
      <div className="account-block">
        <div className="account-title">
          <strong>Firecrawl</strong>
          <span>{status ? status.configured ? "Configured" : "Not configured" : error ? "Status unavailable" : "Loading…"}</span>
        </div>
        <p className="subtle">
          Powers web search and page reading for all agents. Firecrawl usage is billed separately.{" "}
          <a href="https://www.firecrawl.dev/app/api-keys" target="_blank" rel="noopener noreferrer">Get an API key</a>
        </p>
        <form onSubmit={save}>
          <label>
            {status?.configured ? "Replace API key" : "API key"}
            <input ref={key} type="password" aria-label="Firecrawl API key"
              autoComplete="off" spellCheck={false} maxLength={1024} placeholder="fc-…"
              required disabled={busy} onChange={(event) => onDirty(!!event.target.value)} />
          </label>
          <div className="account-actions">
            <button type="submit" disabled={busy}>Save API key</button>
            {status?.configured && <button type="button" disabled={busy} onClick={() => {
              if (key.current) key.current.value = "";
              onDirty(false);
              void act(() => api("/settings/firecrawl", { method: "DELETE" }),
                "Firecrawl key removed. Web research is disabled until you save a new key.");
            }}>Remove key</button>}
          </div>
        </form>
        {status?.source === "environment" && (
          <>
            <p className="subtle">Using FIRECRAWL_API_KEY from the server environment.</p>
            <button type="button" disabled={busy} onClick={() => void act(
              () => control("/settings/firecrawl/import"),
              "Environment key saved in Settings. You can now remove FIRECRAWL_API_KEY from the server environment.",
            )}>Move environment key to Settings</button>
          </>
        )}
        <p className="subtle">
          Saved privately on this Jelly computer, never returned to the browser or stored in chat.
          Changes apply to the next web request without a restart. Requests already in progress may finish with the previous key.
          Saving does not make a paid request; the next web request checks access.
        </p>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {notice && <p className="connection-success" role="status">{notice}</p>}
    </fieldset>
  );
}
