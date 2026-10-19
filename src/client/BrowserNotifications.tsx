import { useEffect, useState } from "react";
import {
  notificationSupport,
  notificationsEnabled,
  setNotificationsEnabled,
  showBrowserNotification,
  watchNotifications,
} from "./browser-notifications";

export function BrowserNotifications({ instance }: { instance: string }) {
  const [, update] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => watchNotifications(() => update(value => value + 1)), []);
  const support = notificationSupport();
  const permission = support === "supported" ? window.Notification.permission : "default";
  const enabled = notificationsEnabled(instance);
  const active = enabled && permission === "granted" && support === "supported";
  async function enable() {
    setBusy(true);
    setError("");
    try {
      // Called directly from the click: browsers require a user gesture.
      const result = permission === "granted" ? permission : await window.Notification.requestPermission();
      if (result === "granted") setNotificationsEnabled(instance, true);
      else if (result === "default") setError("Permission wasn’t granted. Try again when you’re ready.");
      update(value => value + 1);
    } catch {
      setError("Could not request permission. Check this browser’s site settings.");
    } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true);
    setError("");
    try {
      await showBrowserNotification("Jelly notifications are on", "You’ll hear when an agent finishes or needs attention.", "/agents", "jelly:test", () => {});
    } catch {
      setError("Could not show a notification. Check browser and system notification settings.");
    } finally { setBusy(false); }
  }
  return <>
    <div className="settings-group settings-description">
      <strong role="status">
        {support === "insecure" ? "HTTPS required" : support === "unavailable" ? "Not supported" : permission === "denied" ? "Blocked by browser" : active ? "Notifications on" : "Notifications off"}
      </strong>
      <p>Get notified when an agent finishes, requests a private handoff or permission, or encounters an error. Alerts open the agent’s conversation.</p>
      <p>Saved immediately for this browser and Jelly instance. No message contents are included.</p>
      {support === "insecure" && <p>Notifications require HTTPS or localhost. HTTP Tailscale addresses are not supported.</p>}
      {support === "unavailable" && <p>This browser doesn’t provide notifications. On iPhone or iPad, support depends on an installed Home Screen app and HTTPS.</p>}
      {permission === "denied" && <p>Allow notifications in this browser’s site settings, then return here to enable them.</p>}
    </div>
    <div className="settings-group">
      <button type="button" className="settings-row" disabled={busy || (!enabled && (support !== "supported" || permission === "denied"))} onClick={() => {
        if (enabled) { setNotificationsEnabled(instance, false); setError(""); }
        else void enable();
      }}>
        <span>{busy ? "Please wait…" : enabled ? "Turn off notifications" : "Enable notifications"}</span>
      </button>
      <button type="button" className="settings-row" disabled={busy || !active} onClick={() => void test()}>
        <span>Send test notification</span>
      </button>
    </div>
    <p className="settings-footnote">Keep Jelly open in a tab. Alerts are suppressed while you’re focused on that agent’s conversation. Closed or suspended browsers do not receive updates; this is not background push.</p>
    {error && <p role="alert" className="error-text">{error}</p>}
  </>;
}
