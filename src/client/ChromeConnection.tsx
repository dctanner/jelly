import { useEffect, useRef, useState } from "react";
import { api, control } from "./api";
import type { Snapshot } from "../shared/types";
import type { ChromeProfile } from "../shared/chrome-protocol";
import { ChromeSharePanel } from "./ChromeSharePanel";
export interface ChromeStatus {
  browserTarget?: "managed" | "chrome";
  selectedProfile?: string;
  desktopShared?: boolean;
  profiles: ChromeProfile[];
  task: {
    profile: string;
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
  const [target, setTarget] = useState(data.config.browserTarget ?? "managed");
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
  const shareAgent = agentId || data.agents?.[0]?.id;
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
        setError("Chrome status unavailable—do not enter credentials.");
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
    setView((previous) =>
      previous?.agentId === agentId
        ? {
            ...previous,
            status: {
              ...previous.status,
              task: previous.status.task
                ? {
                    ...previous.status.task,
                    paused: false,
                    pauseState: "pausing",
                  }
                : null,
            },
          }
        : null,
    );
    try {
      await control(
        `/chrome/${operation}`,
        operation === "settings"
          ? {
              browserTarget: target,
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
          `Chrome control failed—do not enter credentials. ${(e as Error).message}`,
        );
      }
    } finally {
      scope.controlling = false;
      if (scopeRef.current === scope) setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <h3>Browser target</h3>
      <p className="settings-footnote">
        One global choice for all persistent Jelly agents. Connected Chrome uses
        your explicitly selected Chrome profile; all agents share its signed-in
        accounts, with separate task groups and exclusive tab permissions. Local
        machine only; not a network sandbox. Managed browsers remain available.
        Signed-in rollout still requires the safety review in
        docs/CONNECTED-CHROME.md.
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
            unrestricted internet, and save once for all agents. No profile
            copying, Chrome restart flags or debugging port.
          </li>
        </ol>
      </details>
      <label className="chat-form-field">
        <span>Browser target</span>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value as "managed" | "chrome")}
        >
          <option value="managed">Managed browser (default)</option>
          <option value="chrome">Connected Chrome · experimental</option>
        </select>
      </label>
      <label className="chat-form-field">
        <span>Chrome profile</span>
        <select value={profile} onChange={(e) => setProfile(e.target.value)}>
          <option value="">Choose an explicitly connected profile</option>
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
            Unrestricted internet (HTTP and HTTPS)
          </option>
        </select>
      </label>
      {siteScope === "internet" && (
        <p className="chat-form-hint">
          Every persistent agent can use public websites with this profile’s
          signed-in accounts. Jelly, local/private addresses and internal
          browser pages remain blocked.
        </p>
      )}
      {siteScope === "approved" && (
        <label className="chat-form-field">
          <span>Approved exact HTTPS origins (one per line)</span>
          <textarea
            rows={4}
            value={origins}
            onChange={(e) => setOrigins(e.target.value)}
            placeholder="https://example.com"
          />
        </label>
      )}
      <p className="chat-form-hint">
        Global scope applies to new sessions for every persistent agent.
        Existing sessions keep their target, profile and approved sites until
        closed. Grant existing user tabs explicitly in the extension popup;
        their groups are preserved and they are never automatically closed.
        Paused handoffs require a follow-up browser run and explicit Resume.
        Child browser tools, free-form input and file artifacts remain
        unavailable.
      </p>
      <button
        className="primary"
        disabled={busy}
        onClick={() => void act("settings")}
      >
        Save browser target and site scope
      </button>
      {!status.task && data.selectedAgentId && (
        <button disabled={busy} onClick={() => void act("close")}>
          Reset pinned target (when idle)
        </button>
      )}
      {shareAgent && <button disabled={busy} onClick={() => setShareOpen(true)}>Connected Chrome web VNC…</button>}
      {shareOpen && shareAgent && <ChromeSharePanel agentId={shareAgent} onClose={() => setShareOpen(false)} onChange={() => { if (scopeRef.current) void load(scopeRef.current); void refresh(); }} />}
      {status.task && (
        <div className="chat-form-group">
          <h4>This agent’s pinned Chrome session</h4>
          <p>
            {status.task.profile} ·{" "}
            {status.task.connected
              ? status.task.pauseState === "pausing"
                ? "Pausing—do not enter credentials yet"
                : status.task.pauseState === "resuming"
                  ? "Resuming—do not enter credentials"
                  : status.task.pauseState === "failed"
                    ? "Pause failed—do not enter credentials"
                    : status.task.paused
                      ? "Paused"
                      : "Connected"
              : "Disconnected"}{" "}
            · {status.task.tabs.length} task tabs
          </p>
          <p>
            {status.task.siteScope === "internet"
              ? "Unrestricted internet (HTTP and HTTPS)"
              : status.task.origins.join(", ")}
          </p>
          {["pause", "resume", "disconnect", "close"].map((op) => (
            <button
              key={op}
              disabled={
                busy ||
                !!status.desktopShared ||
                (op === "resume" &&
                  (!status.task?.connected || !status.task.paused))
              }
              onClick={() => void act(op)}
            >
              {op[0]!.toUpperCase() + op.slice(1)}
            </button>
          ))}
          {status.task.tabs.map((tab, i) => (
            <div key={tab}>
              Task tab {i + 1}{" "}
              <button
                disabled={
                  busy || !status.task?.connected || !status.task.paused
                }
                onClick={() => void act("focus", tab)}
              >
                Open in Chrome
              </button>
              <button
                disabled={
                  busy ||
                  !status.task?.connected ||
                  status.task.pauseState !== "active"
                }
                onClick={() => void act("deliverable", tab)}
              >
                Keep as deliverable
              </button>
              <button
                disabled={
                  busy ||
                  !status.task?.connected ||
                  status.task.pauseState !== "active"
                }
                onClick={() => void act("handoff", tab)}
              >
                Retain for follow-up handoff
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
