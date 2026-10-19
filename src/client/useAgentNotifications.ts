import { useEffect, useRef } from "react";
import type { Snapshot } from "../shared/types";
import {
  agentNotificationText,
  claimAgentNotification,
  notificationAgentId,
  notificationSupport,
  notificationsEnabled,
  showBrowserNotification,
} from "./browser-notifications";

export function useAgentNotifications(
  snapshot: Snapshot | null,
  openAgent: string | null,
  onOpenAgent: (id: string) => void,
) {
  const current = useRef({ snapshot, openAgent, onOpenAgent });
  current.current = { snapshot, openAgent, onOpenAgent };
  const seen = useRef({ instance: "", cursor: 0 });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      // Only our same-origin notification worker can request this navigation.
      if (!(event.source instanceof ServiceWorker) ||
        event.source.scriptURL !== new URL("/notifications-sw.js", window.location.origin).href ||
        event.data?.type !== "jelly:notification-open") return;
      const id = notificationAgentId(event.data.url);
      if (id) current.current.onOpenAgent(id);
    };
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.addEventListener("message", receive);
    return () => navigator.serviceWorker.removeEventListener("message", receive);
  }, []);
  useEffect(() => {
    if (!snapshot) return;
    const { id: instance } = snapshot.instance;
    if (seen.current.instance !== instance) {
      // Initial load establishes a baseline, never replays old finished runs.
      seen.current = { instance, cursor: snapshot.cursor };
      return;
    }
    const after = seen.current.cursor;
    seen.current.cursor = Math.max(after, snapshot.cursor);
    for (const event of snapshot.agentNotifications ?? []) {
      if (!Number.isSafeInteger(event.id) || event.id <= after || event.id > snapshot.cursor) continue;
      const agent = snapshot.agents.find(agent => agent.id === event.agentId && !agent.archivedAt);
      if (!agent) continue;
      void claimAgentNotification(instance, event).then(async claimed => {
        if (!claimed) return;
        const allowed = () => {
          const latest = current.current;
          return mounted.current && latest.snapshot?.instance.id === instance &&
            latest.snapshot.agents.some(current => current.id === agent.id && !current.archivedAt) &&
            notificationsEnabled(instance) && notificationSupport() === "supported" &&
            window.Notification.permission === "granted" &&
            !(document.visibilityState !== "hidden" && document.hasFocus() && latest.openAgent === agent.id);
        };
        if (!allowed()) return;
        const { title, body } = agentNotificationText(agent, event);
        await showBrowserNotification(
          title, body, `/agents/${encodeURIComponent(agent.id)}`,
          `jelly:${instance}:${agent.id}`,
          () => current.current.onOpenAgent(agent.id),
          allowed,
        );
      }).catch(() => {
        // Notification failure must never break SSE refresh or the conversation.
      });
    }
  }, [snapshot]);
}
