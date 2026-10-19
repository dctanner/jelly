import { useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import type { AppRecord } from "../shared/apps";
import { appsApi, recordAppLaunch } from "./api";
import { AppActions } from "./AppActions";

export function AppViewer({
  appId,
  navigationId,
  changedApp,
  revision,
  onHome,
  onLaunch,
  onChanged,
  onDetails,
  onEdit,
  onRemove,
}: {
  appId: string;
  navigationId: string;
  changedApp: AppRecord | null;
  revision: number;
  onHome: () => void;
  onLaunch: (app: AppRecord) => void;
  onChanged: (app: AppRecord) => void;
  onDetails: (app: AppRecord) => void;
  onEdit: (app: AppRecord) => void;
  onRemove: (app: AppRecord) => void;
}) {
  const [record, setApp] = useState<AppRecord | null>(null);
  const app = record?.id === appId ? record : null;
  const [apps, setApps] = useState<AppRecord[]>([]);
  // Recording a visit can move the current app ahead of a history cursor while
  // tabs are paginating. Retain registrations read during this registry load,
  // but discard this cache on refresh so removed apps do not become ghost tabs.
  const observedApps = useRef(new Map<string, AppRecord>());
  const [tabsError, setTabsError] = useState("");
  const [tabsRetry, setTabsRetry] = useState(0);
  const [error, setError] = useState("");
  const [launchError, setLaunchError] = useState("");
  const [retry, setRetry] = useState(0);
  const home = useRef<HTMLButtonElement>(null);
  const selectedTab = useRef<HTMLAnchorElement>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    home.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    observedApps.current = new Map();
    setTabsError("");
    void (async () => {
      try {
        const records = new Map<string, AppRecord>();
        let after: string | null = null;
        do {
          const page = await appsApi.list(
            { limit: 100, ...(after ? { after } : {}) },
            controller.signal,
          );
          for (const app of [...page.starred, ...page.history])
            records.set(app.id, app);
          after = page.after;
        } while (after && !controller.signal.aborted);
        if (!controller.signal.aborted) {
          for (const record of observedApps.current.values()) records.set(record.id, record);
          setApps([...records.values()]);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setTabsError((error as Error).message);
      }
    })();
    return () => controller.abort();
  }, [revision, tabsRetry]);
  useEffect(() => {
    selectedTab.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [appId, apps, app?.name]);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void appsApi
      .get(appId, controller.signal)
      .then((record) => {
        if (controller.signal.aborted) return;
        observedApps.current.set(record.id, record);
        setApps(current => [...current.filter(app => app.id !== record.id), record]);
        setApp(record);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError((error as Error).message);
      });
    return () => controller.abort();
  }, [appId, revision, retry]);
  useEffect(() => {
    if (!changedApp) return;
    if (observedApps.current.has(changedApp.id)) observedApps.current.set(changedApp.id, changedApp);
    if (changedApp.id === appId) setApp(changedApp);
    setApps(current => current.map(app => app.id === changedApp.id ? changedApp : app));
  }, [changedApp, appId]);
  useEffect(() => {
    let dead = false;
    setLaunchError("");
    void recordAppLaunch(appId, navigationId)
      .then((record) => {
        if (!dead) {
          changed.current(record);
          setLaunchError("");
        }
      })
      .catch((error) => {
        if (!dead) setLaunchError((error as Error).message);
      });
    return () => {
      dead = true;
    };
  }, [appId, navigationId]);
  // Names, not last-opened timestamps, keep tabs still when switching apps.
  const tabs = [...new Map(
    [...apps, ...(app ? [app] : [])]
      .map((record) => [record.id, record]),
  ).values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const mixed =
    !!app &&
    window.location.protocol === "https:" &&
    new URL(app.url).protocol === "http:";
  const help = (
    <>
      <p>
        A frame load does not prove the app rendered. Jelly cannot diagnose
        every cross-origin failure.
      </p>
      <ul>
        <li>
          Check the app is running and this device can reach its registered URL.
        </li>
        <li>
          The app's CSP frame-ancestors and X-Frame-Options must permit Jelly.
          Jelly does not bypass them.
        </li>
        <li>
          Framed sign-in and third-party-cookie restrictions may require changes
          to the app's authentication configuration.
        </li>
        <li>
          HTTPS Jelly requires an HTTPS app. Localhost on a phone means the
          phone; use a browser-reachable Tailscale URL instead.
        </li>
      </ul>
    </>
  );
  return (
    <section
      className="app-viewer"
      aria-label={app ? `${app.name} viewer` : "App viewer"}
    >
      <div className="viewer-content">
      {app && !mixed && !error && (
        <iframe
          key={`${app.url}-${retry}`}
          title={app.name}
          src={app.url}
          sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; fullscreen 'none'; payment 'none'; usb 'none'; clipboard-read 'none'; clipboard-write 'none'"
          referrerPolicy="no-referrer"
        />
      )}
      {(!app || mixed || error) && (
        <div className="viewer-recovery">
          <div className="viewer-recovery-content">
            <h1>{app?.name ?? "App viewer"}</h1>
            <p role={error || mixed ? "alert" : "status"}>
              {error ||
                (mixed
                  ? "HTTPS Jelly cannot embed this HTTP app. Configure HTTPS hosting for the app or use HTTP Jelly on your private network."
                  : "Loading app registration…")}
            </p>
            {help}
            <div className="apps-detail-actions">
              <button
                className="secondary"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry app
              </button>
              {app && (
                <button className="secondary" onClick={() => onDetails(app)}>
                  Edit registration
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {launchError && (
        <div className="viewer-launch-error" role="alert">
          Visit could not be saved. {launchError}
          <button
            onClick={() =>
              void recordAppLaunch(appId, navigationId)
                .then((record) => {
                  changed.current(record);
                  setLaunchError("");
                })
                .catch((error) => setLaunchError((error as Error).message))
            }
          >
            Retry recording visit
          </button>
        </div>
      )}
      </div>
      <footer className="viewer-footer">
        {tabsError && (
          <p className="viewer-tabs-error" role="status">
            Could not load app tabs. {tabsError}
            <button onClick={() => setTabsRetry(value => value + 1)}>Retry app tabs</button>
          </p>
        )}
        <nav className="destination-navigation viewer-navigation" aria-label="App navigation">
          <button ref={home} className="viewer-back" aria-label="Back to Apps" title="Back to Apps" onClick={onHome}>
            <ChevronLeft size={22} aria-hidden="true" />
          </button>
          <div className="viewer-app-tabs">
            {tabs.map(tab => (
              <a
                key={tab.id}
                ref={tab.id === appId ? selectedTab : undefined}
                href={`/apps/${encodeURIComponent(tab.id)}`}
                aria-current={tab.id === appId ? "page" : undefined}
                title={tab.name}
                onClick={event => {
                  if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                    event.preventDefault();
                    if (tab.id !== appId) onLaunch(tab);
                  }
                }}
              >
                <span>{tab.name}</span>
              </a>
            ))}
          </div>
          {app && (
            <AppActions
              viewer
              app={app}
              onDetails={() => onDetails(app)}
              onEdit={() => onEdit(app)}
              onRemove={() => onRemove(app)}
            />
          )}
        </nav>
      </footer>
    </section>
  );
}
