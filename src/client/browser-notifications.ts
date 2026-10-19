import { readPreference, savePreference } from "./theme";
import type { AgentNotification, AgentRecord } from "../shared/types";

const changedEvent = "jelly:notifications-changed";
export function notificationSupport(): "supported" | "insecure" | "unavailable" {
  if (!window.isSecureContext) return "insecure";
  return typeof window.Notification === "function" ? "supported" : "unavailable";
}
export function notificationsEnabled(instance: string) {
  return !!instance && readPreference(`jelly.notifications.${instance}`, "off") === "on";
}
export function setNotificationsEnabled(instance: string, enabled: boolean) {
  savePreference(`jelly.notifications.${instance}`, enabled ? "on" : "off");
  window.dispatchEvent(new window.Event(changedEvent));
}
export function watchNotifications(update: () => void) {
  window.addEventListener(changedEvent, update);
  window.addEventListener("storage", update);
  window.addEventListener("focus", update);
  document.addEventListener("visibilitychange", update);
  return () => {
    window.removeEventListener(changedEvent, update);
    window.removeEventListener("storage", update);
    window.removeEventListener("focus", update);
    document.removeEventListener("visibilitychange", update);
  };
}

/** No transcripts, commands, handoff details or model errors on the lock screen. */
export function agentNotificationText(agent: AgentRecord, event: AgentNotification) {
  return event.type === "run_completed"
    ? { title: `${agent.name} finished`, body: "Open Jelly to see the result." }
    : { title: `${agent.name} needs attention`, body: "Open Jelly to review what’s needed." };
}
export function notificationAgentId(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = /^\/agents\/([^/?#]+)$/.exec(url);
  try { return match ? decodeURIComponent(match[1]!) : null; }
  catch { return null; }
}

let worker: Promise<ServiceWorkerRegistration> | undefined;
async function notificationWorker() {
  if (!worker) {
    worker = navigator.serviceWorker.register("/notifications-sw.js", { scope: "/" }).then(registration => {
      if (registration.active) return registration;
      const installing = registration.installing ?? registration.waiting;
      if (!installing) throw new Error("Notification worker unavailable.");
      return new Promise<ServiceWorkerRegistration>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          installing.removeEventListener("statechange", update);
          error ? reject(error) : resolve(registration);
        };
        const update = () => {
          if (installing.state === "activated") finish();
          else if (installing.state === "redundant") finish(new Error("Notification worker unavailable."));
        };
        const timer = setTimeout(() => finish(new Error("Notification worker timed out.")), 10000);
        installing.addEventListener("statechange", update);
        update();
      });
    }).catch(error => { worker = undefined; throw error; });
  }
  return worker;
}
export async function showBrowserNotification(
  title: string,
  body: string,
  url: string,
  tag: string,
  onClick: () => void,
  shouldShow: () => boolean = () => true,
) {
  if (!shouldShow()) return;
  if (notificationSupport() !== "supported" || window.Notification.permission !== "granted")
    throw new Error("Allow notifications in this browser’s site settings first.");
  const options: NotificationOptions = { body, tag, icon: "/brand/jelly-icon-192.png" };
  if ("serviceWorker" in navigator) {
    try {
      const registration = await notificationWorker();
      if (!shouldShow()) return;
      await registration.showNotification(title, { ...options, data: { url } });
      return;
    } catch {
      // Desktop browsers can still notify when worker registration is disabled.
    }
  }
  if (!shouldShow()) return;
  const notification = new window.Notification(title, options);
  notification.onclick = () => {
    notification.close();
    window.focus();
    onClick();
  };
}

/** Cross-tab claim under Web Locks; tags also replace duplicates on older browsers. */
export async function claimAgentNotification(instance: string, event: AgentNotification) {
  const key = `jelly.notifications.delivered.${instance}.${event.agentId}`;
  const claim = () => {
    const previous = Number(readPreference(key, "0"));
    if (Number.isSafeInteger(previous) && previous >= event.id) return false;
    savePreference(key, String(event.id));
    return true;
  };
  return navigator.locks
    ? navigator.locks.request(`jelly.notifications.${instance}`, claim)
    : claim();
}
