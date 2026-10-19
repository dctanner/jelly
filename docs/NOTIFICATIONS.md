# Browser notifications

Open **Settings → Notifications → Browser notifications → Enable notifications**.
Permission is requested only when you click Enable. The preference is saved
immediately, independently for each browser/origin and Jelly instance. Use
**Send test notification** to check browser and operating-system settings.
Turn notifications off here without changing the browser's site permission.

Alerts cover completed runs, failures/interrupted runs, and pending sudo,
browser sign-in or desktop handoff requests, including agents in other projects.
Click an alert to open that agent's conversation. Names appear in alerts, but
messages, tool arguments, error details and handoff payloads do not.

Notifications are suppressed for the conversation you are currently viewing
in a focused, visible Jelly tab. Opening/reloading Jelly does not replay old
alerts. Reconnecting an already-open tab recovers the latest relevant marker
for each agent, not a backlog of every event. Archived agents are excluded.
Web Locks and browser-local delivery markers deduplicate open tabs; notification
tags provide replacement on browsers without Web Locks.

## Limitations

- Requires HTTPS or a browser-trusted localhost address. Plain HTTP over
  Tailscale does **not** support notifications. This feature does not change
  Jelly's listeners, hosting or access configuration.
- Keep Jelly open. This is not Web Push: closed browsers, sleeping devices and
  suspended mobile tabs cannot receive live updates.
- Notification API support varies. iPhone/iPad support depends on HTTPS and
  an installed Home Screen app; no real iOS delivery verification is implied.
- Browser/OS notification blocking and Do Not Disturb can hide alerts even when
  permission is granted. If permission was denied, change the browser's site
  settings first; Jelly will not repeatedly prompt.
- A small same-origin service worker delivers notifications and routes clicks.
  It does not intercept requests, cache app/private data, or subscribe to push.
  Desktop browsers fall back to the page Notification API if worker setup fails.

## Private Tailscale HTTPS

This instance uses **https://box.tailbfab3f.ts.net**. Persistent Tailscale Serve
terminates HTTPS on tailnet port 443 and proxies to `http://127.0.0.1:5173`;
Funnel/public access stays disabled. Native loopback and Tailscale HTTP listeners
are unchanged. Tailscale automatically manages the certificate; the hostname
appears in the public certificate-transparency log, not the app's contents.

The Jelly service's `https-origin.conf` drop-in sets
`JELLY_PUBLIC_ORIGINS=https://box.tailbfab3f.ts.net`, keeping host/origin checks
exact and issuing Secure, HttpOnly `__Host-` control cookies for HTTPS.
Configuration changes require an idle-safe restart, not an inline restart.

Use the HTTPS URL on a Tailscale-connected device and enable notifications there.
Browser preferences and notification permissions are separate from the old HTTP
origin; conversations and agents remain on the same instance. HTTP iframe apps
may be blocked as mixed content and need their own trusted HTTPS URLs; this setup
does not modify their registrations or hosting.

Check `tailscale serve status --json` to confirm port 443 is HTTPS with a loopback
proxy and no `AllowFunnel`. To remove only this endpoint, use
`tailscale serve --https=443 off` (with sudo if required), not `serve reset`.
