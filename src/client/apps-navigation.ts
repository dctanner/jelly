import { useEffect, useState } from "react";
import { requestId } from "./request-id";
import { readPreference, savePreference } from "./theme";

export type AppDestination = "agents" | "apps" | "todos" | "viewer";
export interface AppsLocation {
  destination: AppDestination;
  appId: string | null;
  todoId: string | null;
  /** Todos list filter from `/todos?agent=<id>`. */
  todoAgentId: string | null;
  agentId: string | null;
  navigationId: string;
  focusAppId: string | null;
  explicit: boolean;
}

export function readAppsLocation(): AppsLocation {
  const path = window.location.pathname;
  const state = window.history.state ?? {};
  const viewer = /^\/apps\/([^/]+)(\/.*)?$/.exec(path);
  const todo = /^\/todos(?:\/([^/]+))?\/?$/.exec(path);
  const agent = /^\/agents\/([^/]+)\/?$/.exec(path);
  const search = new URLSearchParams(window.location.search);
  const queryAgent = search.get("agentId");
  let appId: string | null = null;
  let agentId: string | null = null;
  try {
    appId = viewer ? decodeURIComponent(viewer[1]!) : null;
    agentId = agent ? decodeURIComponent(agent[1]!) : queryAgent;
  } catch {}
  const destination = appId
    ? "viewer"
    : todo ? "todos" : path === "/apps" || path === "/apps/"
      ? "apps"
      : "agents";
  const navigationId =
    typeof state.jellyAppNavigationId === "string"
      ? state.jellyAppNavigationId
      : requestId();
  if (appId && state.jellyAppNavigationId !== navigationId)
    window.history.replaceState(
      { ...state, jellyAppNavigationId: navigationId },
      "",
    );
  return {
    destination,
    appId,
    todoId: todo?.[1] ?? null,
    todoAgentId: todo ? search.get("agent") || null : null,
    agentId,
    navigationId,
    focusAppId:
      typeof state.jellyFocusAppId === "string" ? state.jellyFocusAppId : null,
    explicit:
      !!viewer ||
      path.startsWith("/agents") ||
      (destination === "apps" || destination === "todos") ||
      !!queryAgent,
  };
}

export function useAppsNavigation(instanceId: string) {
  const [location, setLocation] = useState(readAppsLocation);
  const [restored, setRestored] = useState("");
  useEffect(() => {
    const pop = () => setLocation(readAppsLocation());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (!instanceId || restored === instanceId) return;
    setRestored(instanceId);
    if (
      !location.explicit &&
      ["apps", "todos"].includes(readPreference(`jelly.destination.${instanceId}`, "agents"))
    ) {
      const saved = readPreference(`jelly.destination.${instanceId}`, "agents");
      const next = { ...window.history.state, jellyDestination: saved };
      window.history.replaceState(next, "", `/${saved}`);
      setLocation(readAppsLocation());
    }
  }, [instanceId, restored, location.explicit]);
  useEffect(() => {
    if (instanceId && restored === instanceId)
      savePreference(
        `jelly.destination.${instanceId}`,
        location.destination === "viewer" ? "apps" : location.destination,
      );
  }, [instanceId, restored, location.destination]);
  function navigate(
    destination: "agents" | "apps" | "todos",
    focusAppId: string | null = null,
  ) {
    const state = destination === "agents" ? { ...window.history.state } : {};
    delete state.jellyAppNavigationId;
    delete state.jellyFocusAppId;
    const next = {
      ...state,
      jellyDestination: destination,
      jellyFocusAppId: focusAppId,
    };
    window.history.pushState(next, "", `/${destination}`);
    setLocation(readAppsLocation());
  }
  function viewer(appId: string, navigationId: string) {
    const next = {
      jellyDestination: "viewer",
      jellyAppNavigationId: navigationId,
    };
    const url = `/apps/${encodeURIComponent(appId)}`;
    window.history.pushState(next, "", url);
    setLocation(readAppsLocation());
  }
  return {
    location,
    navigate,
    viewer,
    destinationReady:
      location.explicit || (!!instanceId && restored === instanceId),
  };
}

export function appFocusId(appId: string, action = "launch") {
  return `jelly-app-${encodeURIComponent(appId)}-${action}`;
}
