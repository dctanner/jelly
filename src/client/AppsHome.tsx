import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle, Plus, Search, SearchX, Star } from "lucide-react";
import type { AppRecord } from "../shared/apps";
import { appsApi } from "./api";
import { appFocusId } from "./apps-navigation";
import { AppActions } from "./AppActions";

export function AppIcon({ app }: { app: AppRecord }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [app.iconAssetId]);
  const hue =
    Array.from(app.id).reduce((sum, letter) => sum + letter.charCodeAt(0), 0) %
    360;
  // Asset URLs are registry-owned IDs, never app-supplied HTML or image origins.
  return (
    <span
      className="app-icon"
      style={{ backgroundColor: `hsl(${hue} 35% 38%)` }}
      aria-hidden="true"
    >
      {app.iconAssetId && !failed ? (
        <img
          src={`/api/apps/${encodeURIComponent(app.id)}/icon?asset=${encodeURIComponent(app.iconAssetId)}`}
          alt=""
          onError={() => setFailed(true)}
        />
      ) : (
        Array.from(app.name.trim())[0]?.toUpperCase() || "J"
      )}
    </span>
  );
}

function historyTime(app: AppRecord) {
  if (!app.lastOpenedAt) return "Not opened yet";
  const minutes = Math.max(
    0,
    (Date.now() - Date.parse(app.lastOpenedAt)) / 60000,
  );
  if (minutes < 1) return "Opened just now";
  if (minutes < 60) return `Opened ${Math.floor(minutes)}m ago`;
  if (minutes < 1440) return `Opened ${Math.floor(minutes / 60)}h ago`;
  return `Opened ${Math.floor(minutes / 1440)}d ago`;
}
export function sortApps(apps: AppRecord[]) {
  const starred = apps
    .filter((app) => app.starredAt)
    .sort(
      (a, b) =>
        b.starredAt!.localeCompare(a.starredAt!) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const history = apps
    .filter((app) => !app.starredAt)
    .sort(
      (a, b) =>
        (b.lastOpenedAt ?? b.createdAt).localeCompare(
          a.lastOpenedAt ?? a.createdAt,
        ) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  return { starred, history };
}

export function AppsHome({
  active,
  focusAppId,
  revision,
  changedApp,
  onLaunch,
  onDetails,
  onEdit,
  onAdd,
  onRemove,
}: {
  active: boolean;
  focusAppId: string | null;
  revision: number;
  changedApp: AppRecord | null;
  onLaunch: (app: AppRecord) => void;
  onDetails: (app: AppRecord) => void;
  onEdit: (app: AppRecord) => void;
  onAdd: () => void;
  onRemove: (app: AppRecord) => void;
}) {
  const [apps, setApps] = useState<AppRecord[]>([]);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [after, setAfter] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [starErrors, setStarErrors] = useState<
    Record<string, { message: string; starred: boolean }>
  >({});
  const [pendingStars, setPendingStars] = useState<Set<string>>(new Set());
  const pending = useRef(new Set<string>());
  const generation = useRef(0);
  const pages = useRef(1);
  const scroller = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(0);
  const focus = useRef<{ id: string; action: string } | null>(null);
  const restoringHome = useRef(false);
  const appsRef = useRef(apps);
  appsRef.current = apps;
  const refreshNeeded = useRef(false);
  const [starRevision, setStarRevision] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 180);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    pages.current = 1;
  }, [search]);
  async function load(signal?: AbortSignal) {
    if (pending.current.size) {
      refreshNeeded.current = true;
      return;
    }
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      let result = await appsApi.list({ q: search, limit: 30 }, signal);
      let records = [...result.starred, ...result.history];
      for (let page = 1; page < pages.current && result.after; page++) {
        result = await appsApi.list(
          { q: search, after: result.after, limit: 30 },
          signal,
        );
        records.push(...result.starred, ...result.history);
      }
      if (
        restoringHome.current &&
        focusAppId &&
        !records.some((app) => app.id === focusAppId)
      ) {
        try {
          const origin = await appsApi.get(focusAppId, signal);
          if (search) {
            setQuery("");
            setSearch("");
            return;
          }
          records.push(origin);
        } catch {
          if (!signal?.aborted && request === generation.current) {
            setAnnouncement(
              "The originating app is no longer available in Apps.",
            );
            focus.current = null;
            restoringHome.current = false;
            document
              .getElementById("apps-home-title")
              ?.focus({ preventScroll: true });
          }
        }
      }
      if (request !== generation.current || signal?.aborted) return;
      if (restoringHome.current && focusAppId)
        focus.current = { id: focusAppId, action: "launch" };
      restoringHome.current = false;
      setApps(
        Array.from(new Map(records.map((app) => [app.id, app])).values()),
      );
      setAfter(result.after);
      setLoaded(true);
    } catch (error) {
      if (request === generation.current && !signal?.aborted)
        setError((error as Error).message);
    } finally {
      if (request === generation.current && !signal?.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    // Keep Home mounted and its pages/scroll while the viewer is open. Inactive
    // registry events are recovered on return, without creating launch events.
    if (!active) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
      generation.current++;
    };
  }, [active, search, revision, starRevision]);
  useEffect(() => {
    if (changedApp)
      setApps((current) =>
        current.some((app) => app.id === changedApp.id)
          ? current.map((app) =>
              app.id === changedApp.id
                ? {
                    ...changedApp,
                    ...(pending.current.has(app.id)
                      ? { starredAt: app.starredAt }
                      : {}),
                  }
                : app,
            )
          : search
            ? current
            : [...current, changedApp],
      );
  }, [changedApp]);
  useLayoutEffect(() => {
    if (!active) return;
    if (scroller.current) scroller.current.scrollTop = scrollTop.current;
    restoringHome.current = !!focusAppId;
    if (focusAppId) focus.current = { id: focusAppId, action: "launch" };
  }, [active, focusAppId]);
  useLayoutEffect(() => {
    if (!active || !focus.current) return;
    const target = document.getElementById(
      appFocusId(focus.current.id, focus.current.action),
    );
    if (target) {
      target.focus({ preventScroll: true });
      focus.current = null;
    }
  }, [apps, active, focusAppId]);
  async function loadMore() {
    if (!after || busy) return;
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await appsApi.list({ q: search, after, limit: 30 });
      if (request !== generation.current) return;
      setApps((current) =>
        Array.from(
          new Map(
            [...current, ...result.starred, ...result.history].map((app) => [
              app.id,
              app,
            ]),
          ).values(),
        ),
      );
      setAfter(result.after);
      pages.current++;
    } catch (error) {
      if (request === generation.current) setError((error as Error).message);
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  async function star(app: AppRecord, starred: boolean, restoreFocus = false) {
    if (pending.current.has(app.id)) return;
    restoringHome.current = false;
    generation.current++;
    setBusy(false);
    pending.current.add(app.id);
    setPendingStars(new Set(pending.current));
    setStarErrors((current) => {
      const next = { ...current };
      delete next[app.id];
      return next;
    });
    const before = app.starredAt;
    const wasFocused =
      restoreFocus || document.activeElement?.id === appFocusId(app.id, "star");
    if (wasFocused) focus.current = { id: app.id, action: "star" };
    setApps((current) =>
      current.map((item) =>
        item.id === app.id
          ? { ...item, starredAt: starred ? new Date().toISOString() : null }
          : item,
      ),
    );
    setAnnouncement(`${app.name} ${starred ? "starred" : "unstarred"}.`);
    try {
      const updated = await appsApi.star(app.id, starred);
      if (document.activeElement?.id === appFocusId(app.id, "star"))
        focus.current = { id: app.id, action: "star" };
      setApps((current) =>
        current.map((item) => (item.id === app.id ? updated : item)),
      );
    } catch (error) {
      if (document.activeElement?.id === appFocusId(app.id, "star"))
        focus.current = { id: app.id, action: "star" };
      setApps((current) =>
        current.map((item) =>
          item.id === app.id ? { ...item, starredAt: before } : item,
        ),
      );
      setStarErrors((current) => ({
        ...current,
        [app.id]: { message: (error as Error).message, starred },
      }));
      setAnnouncement(
        `Could not save ${app.name}'s star. Previous state restored.`,
      );
    } finally {
      pending.current.delete(app.id);
      setPendingStars(new Set(pending.current));
      if (refreshNeeded.current && !pending.current.size) {
        refreshNeeded.current = false;
        setStarRevision((value) => value + 1);
      }
    }
  }
  const grouped = sortApps(apps);
  function renderApp(app: AppRecord, tile: boolean) {
    return (
      <li
        key={app.id}
        className={tile ? "app-tile" : "app-history-row"}
        data-app-id={app.id}
      >
        <button
          className="app-launch"
          id={appFocusId(app.id)}
          aria-label={`Open ${app.name}`}
          onClick={() => onLaunch(app)}
        >
          <AppIcon app={app} />
          <span className="app-launch-copy">
            <strong>{app.name}</strong>
            {!tile && <span className="app-launch-meta"><span>{historyTime(app)}</span></span>}
          </span>
        </button>
        <div className="app-row-actions">
          <button
            className="app-action"
            id={appFocusId(app.id, "star")}
            aria-label={`${app.starredAt ? "Unstar" : "Star"} ${app.name}`}
            aria-pressed={!!app.starredAt}
            aria-busy={pendingStars.has(app.id)}
            onClick={() => void star(app, !app.starredAt)}
          >
            <Star
              size={18}
              fill={app.starredAt ? "currentColor" : "none"}
              aria-hidden="true"
            />
          </button>
          <AppActions
            app={app}
            onDetails={() => onDetails(app)}
            onEdit={() => onEdit(app)}
            onRemove={() => onRemove(app)}
          />
        </div>
        {starErrors[app.id] && (
          <p role="alert" className="app-star-error">
            {starErrors[app.id]!.message}{" "}
            <button
              onClick={() =>
                void star(
                  appsRef.current.find((item) => item.id === app.id) ?? app,
                  starErrors[app.id]!.starred,
                  true,
                )
              }
            >
              Retry star for {app.name}
            </button>
          </p>
        )}
      </li>
    );
  }
  return (
    <div
      className="apps-home"
      ref={scroller}
      onScroll={() => {
        scrollTop.current = scroller.current?.scrollTop ?? 0;
      }}
    >
      <div className="apps-home-content">
        <header className="apps-home-header">
          <h1 id="apps-home-title" className="destination-title" tabIndex={-1}>
            Apps
          </h1>
          <button type="button" className="apps-add" onClick={onAdd}>
            <span>
              <Plus size={17} strokeWidth={2.4} aria-hidden="true" />
              Add app
            </span>
          </button>
        </header>
        <label className="apps-search">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">Search apps</span>
          <input
            type="search"
            placeholder="Search apps"
            value={query}
            onChange={(event) => {
              restoringHome.current = false;
              focus.current = null;
              setQuery(event.target.value);
            }}
          />
        </label>
        <span className="sr-only" role="status">
          {announcement}
        </span>
        {error && (
          <p role="alert" className="error-text apps-error">
            {error}{" "}
            <button className="secondary" onClick={() => void load()}>
              Retry apps
            </button>
          </p>
        )}
        {!loaded && busy && (
          <p role="status" className="apps-loading">
            <LoaderCircle className="spin" size={22} aria-hidden="true" />
            Loading apps…
          </p>
        )}
        {loaded && !apps.length && !search && (
          <section className="apps-empty">
            <img src="/brand/jelly-mark.png" alt="" />
            <h2>Your apps live here.</h2>
            <p>Add a trusted app to get started.</p>
          </section>
        )}
        {loaded && (apps.length > 0 || !!search) && (
          <>
            {grouped.starred.length ? (
              <section aria-labelledby="apps-starred-heading">
                <h2 id="apps-starred-heading">Starred</h2>
                <ul className="apps-starred-grid">
                  {grouped.starred.map((app) => renderApp(app, true))}
                </ul>
              </section>
            ) : (
              <p className="apps-star-hint">
                <Star size={16} aria-hidden="true" />
                Star apps to keep them here.
              </p>
            )}
            {grouped.history.length > 0 && (
              <section aria-labelledby="apps-history-heading">
                <h2 id="apps-history-heading">History</h2>
                <ul className="apps-history-list">
                  {grouped.history.map((app) => renderApp(app, false))}
                </ul>
              </section>
            )}
            {!grouped.starred.length && !grouped.history.length && search && (
              <div className="apps-no-results">
                <SearchX size={30} aria-hidden="true" />
                <p>No apps match your search.</p>
              </div>
            )}
            {after && (
              <button
                className="secondary apps-load-more"
                disabled={busy}
                onClick={() => void loadMore()}
              >
                {busy ? "Loading…" : "Load more apps"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
