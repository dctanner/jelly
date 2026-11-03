import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { api, control } from "./api";
import {
  PEEKABOO_INSTALL,
  PEEKABOO_URL,
  type DesktopStatus,
} from "../shared/desktop";

export function DesktopConnection() {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    try {
      setStatus(await api<DesktopStatus>("/desktop"));
      setError("");
    } catch {
      setError("Could not check Mac status.");
    }
  }
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, []);
  async function act(path: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      setStatus(await control<DesktopStatus>(`/desktop/${path}`, body));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const missing = status?.permissions.filter((p) => !p.granted) ?? [];
  return (
    <section className="settings-section desktop-settings">
      <h3>Mac control · Peekaboo</h3>
      <div className="settings-group">
        <label className="settings-row desktop-toggle">
          <span>Let agents control this Mac</span>
          <input
            type="checkbox"
            role="switch"
            checked={status?.enabled ?? false}
            disabled={busy || !status}
            onChange={(e) => void act("settings", { enabled: e.target.checked })}
          />
        </label>
      </div>
      {status && !status.platformSupported ? (
        <p className="settings-footnote">Mac control needs Jelly running on a Mac.</p>
      ) : status && !status.installed ? (
        <div className="settings-description">
          <p>Install Peekaboo:</p>
          <pre className="desktop-install">
            <code>{PEEKABOO_INSTALL}</code>
          </pre>
          <p>
            <a href={PEEKABOO_URL} target="_blank" rel="noreferrer">
              More about Peekaboo
            </a>
          </p>
        </div>
      ) : (
        <div className="settings-group" aria-live="polite">
          <div className="settings-row">
            <span>Peekaboo</span>
            <span className="row-value">
              {status ? `Installed${status.version ? ` · ${status.version}` : ""}` : "Checking…"}
            </span>
          </div>
          {status?.permissions.map((permission) => (
            <div className="settings-row" key={permission.name}>
              <span>{permission.name}</span>
              <span className="row-value">
                {permission.granted ? (
                  <Check size={16} aria-label="Granted" />
                ) : (
                  <X size={16} aria-label="Missing" />
                )}
              </span>
            </div>
          ))}
          {missing.length > 0 && (
            <button
              type="button"
              className="settings-row"
              disabled={busy}
              onClick={() => void act("permissions")}
            >
              Grant permissions…
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
