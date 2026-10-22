import { useEffect, useRef, useState } from "react";
import { api, control } from "./api";
import type { Snapshot } from "../shared/types";
import type { ChromeProfile } from "../shared/chrome-protocol";
import { ComputerControlPanel } from "./ComputerControlPanel";
export interface ChromeStatus {
  selectedProfile?: string;
  desktopShared?: boolean;
  humanUsing?: boolean;
  profiles: ChromeProfile[];
  task: {
    profile: string;
    humanUsing?: boolean;
    paused: boolean;
    pauseState:
      "active" | "pausing" | "paused" | "resuming" | "failed" | "disconnected";
    connected: boolean;
    tabs: string[];
    active: string | null;
    handoff: string | null;
    origins: string[];
    siteScope?: "approved" | "internet";
  } | null;
}
export function ChromeConnection({
  data,
  refresh,
}: {
  data: Snapshot;
  refresh: () => Promise<void>;
}) {
  const agentId = data.selectedAgentId ?? "";
  const [view, setView] = useState<{
    agentId: string;
    status: ChromeStatus;
  } | null>(null);
  const status =
    view?.agentId === agentId ? view.status : { profiles: [], task: null };
  type Scope = { agentId: string; request: number; controlling: boolean };
  const scopeRef = useRef<Scope | null>(null);
  const [profile, setProfile] = useState(data.config.chromeProfile ?? "");
  const [origins, setOrigins] = useState(
    (data.config.chromeOrigins ?? []).join("\n"),
  );
  const [siteScope, setSiteScope] = useState(
    data.config.chromeSiteScope ?? "approved",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  async function load(scope: Scope, afterControl = false) {
    if (scopeRef.current !== scope || (scope.controlling && !afterControl))
      return;
    const request = ++scope.request;
    const current = () =>
      scopeRef.current === scope && scope.request === request;
    try {
      await api("/control-session");
      const next = await api<ChromeStatus>(
        `/chrome?agentId=${encodeURIComponent(scope.agentId)}`,
      );
      if (current()) {
        setView({ agentId: scope.agentId, status: next });
        setError("");
      }
    } catch {
      if (current()) {
        setView(null);
        setError("Chrome status unavailable. Retry shortly.");
      }
    }
  }
  useEffect(() => {
    const scope: Scope = { agentId, request: 0, controlling: false };
    scopeRef.current = scope;
    setView(null);
    setBusy(false);
    setError("");
    void load(scope);
    const timer = setInterval(() => void load(scope), 3000);
    return () => {
      if (scopeRef.current === scope) scopeRef.current = null;
      clearInterval(timer);
    };
  }, [agentId]);
  async function act(operation: string, pageId?: string) {
    const scope = scopeRef.current;
    if (!scope || scope.agentId !== agentId || scope.controlling) return;
    scope.controlling = true;
    ++scope.request; // Revoke every GET admitted before this authority transition.
    setBusy(true);
    setError("");
    try {
      await control(
        `/chrome/${operation}`,
        operation === "settings"
          ? {
              chromeProfile: profile,
              chromeOrigins: origins.split(/\s+/).filter(Boolean),
              chromeSiteScope: siteScope,
            }
          : { agentId: scope.agentId, pageId },
      );
      if (scopeRef.current !== scope) return;
      await load(scope, true);
      await refresh();
    } catch (e) {
      if (scopeRef.current === scope) {
        setView(null);
        setError(
          `Chrome settings could not be saved. ${(e as Error).message}`,
        );
      }
    } finally {
      scope.controlling = false;
      if (scopeRef.current === scope) setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <h3>Connected Chrome</h3>
      <p className="settings-footnote">
        All agents use this profile’s signed-in accounts, with separate task tabs.
        Site access applies to new sessions. This is not a network sandbox.
      </p>
      <details>
        <summary>Connect your existing Chrome profile once</summary>
        <ol>
          <li>
            Build the unpacked extension with <code>bun run build:chrome</code>,
            then load <code>dist/chrome-extension</code> from Chrome’s
            Extensions page in the chosen profile.
          </li>
          <li>
            Install Jelly’s separate native host for this instance using the
            explicit paths in <code>docs/CONNECTED-CHROME.md</code>. Development
            ID: <code>mikadpfmkipiafkemjplldmfckomphcf</code>.
          </li>
          <li>
            Click Connect in the extension popup; compare its profile UUID and
            instance with this page.
          </li>
          <li>
            Choose the connected profile below, select approved sites or
            unrestricted web, and save once for all agents. No profile
            copying, Chrome restart flags or debugging port.
          </li>
        </ol>
      </details>
      <label className="chat-form-field">
        <span>Chrome profile</span>
        <select value={profile} onChange={(e) => setProfile(e.target.value)}>
          <option value="">Choose a connected profile</option>
          {profile && !status.profiles.some((p) => p.id === profile) && (
            <option value={profile}>{profile} · disconnected</option>
          )}
          {status.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id} · connected
            </option>
          ))}
        </select>
      </label>
      <label className="chat-form-field">
        <span>Site access</span>
        <select
          value={siteScope}
          onChange={(e) =>
            setSiteScope(e.target.value as "approved" | "internet")
          }
        >
          <option value="approved">Approved sites only</option>
          <option value="internet">
            Unrestricted web (HTTP and HTTPS)
          </option>
        </select>
      </label>
      {siteScope === "internet" && (
        <p className="chat-form-hint">
          Every persistent agent can use websites, including local/private services
          reachable from this machine, with this profile’s signed-in accounts.
          Not a network sandbox. Jelly control endpoints and non-web URLs remain blocked.
        </p>
      )}
      {siteScope === "approved" && (
        <label className="chat-form-field">
          <span>Approved exact HTTP/HTTPS origins (one per line)</span>
          <textarea
            rows={4}
            value={origins}
            onChange={(e) => setOrigins(e.target.value)}
            placeholder="https://example.com"
          />
        </label>
      )}
      <p className="chat-form-hint">
        Existing sessions keep their profile and site access until closed.
        Personal tabs are not shared. To reconnect an agent’s browser session,
        open its Computer control panel → Advanced → Close session.
      </p>
      <button
        className="primary"
        disabled={busy}
        onClick={() => void act("settings")}
      >
        Save Chrome profile and site scope
      </button>
      <button disabled={busy} onClick={() => setShareOpen(true)}>Computer control</button>
      {shareOpen && <ComputerControlPanel agentId={agentId || undefined} onClose={() => setShareOpen(false)} onChange={() => { if (scopeRef.current) void load(scopeRef.current); void refresh(); }} />}
      {status.task && <details>
        <summary>Advanced session settings</summary>
        <p>{status.task.connected ? "Connected" : "Disconnected"} · {status.task.tabs.length} tabs</p>
        <p>Close an idle session to use a different profile or site access.</p>
        <button disabled={busy} onClick={() => void act("close")}>Close session</button>
      </details>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
