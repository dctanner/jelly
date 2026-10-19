# Trusted apps in Jelly

Apps (`/apps`) is a private launcher for owner-trusted web apps. **Add app** needs only a name and browser-reachable HTTP(S) URL. Every tile opens `/apps/:id`, displaying that exact registered URL in an iframe. No proxy, deployment pipeline, runtime adoption, new-tab mode, fallback or app SDK is involved. Apps independently own hosting, authentication, updates, persistence and availability. Registration is not a health or embedding check: Jelly never fetches the destination from its server.

## Trust boundary

> Only add apps you trust. Apps sharing Jelly's hostname may receive or interfere with Jelly cookies. Tailscale protects network access, not isolation between apps.

Cookies are not port-scoped. Same-host app servers can receive matching Jelly cookies, **including HttpOnly cookies**, and can set conflicting cookies. A compromised registered app can threaten Jelly session confidentiality, integrity and availability. Browser origin separation between ports is not cookie separation; a same-origin frame can access Jelly itself. The sandbox is a practical navigation restriction, not an isolation guarantee for trusted software.

This owner-controlled deployment is not suitable for public catalogs, untrusted apps or mutually untrusted users. Tailscale encrypts peer traffic and limits network reachability, but supplies neither app authorization nor a browser secure context for HTTP. Do not add public tunnels, Funnel, LAN or wildcard listeners.

Jelly retains its session authentication, CSRF, exact control-host/origin checks and HttpOnly/SameSite cookies (Secure and `__Host-` on HTTPS). Registering an app never adds its origin to Jelly's control allowlist. Jelly itself remains unframeable (`frame-ancestors 'none'`, X-Frame-Options DENY). These protections do not undo the accepted same-host server cookie trust.

## Registration and preferences

HTTP and HTTPS URLs are accepted, including same-host different-port, Tailscale DNS and Tailscale IP destinations. Paths are preserved. Credentials, query strings and fragments are rejected to avoid storing bearer tokens or login secrets; use a clean entry URL. Never put secrets in paths, descriptions or other metadata either. Known Jelly `/apps` destinations are rejected to prevent recursive viewers. URLs are not silently rewritten: **localhost on a phone means the phone**, not Jelly's host.

Stable IDs/slugs, names, descriptions, raster icons, project/builder/source attribution, explicit stars, paginated history and viewer-corner preferences remain useful. Name/URL-only registration always creates a new app with a bounded, unique slug; it never replaces a similarly named app. An explicit ID or slug identifies an update, retaining stars, history and attribution unless explicitly changed. Names support up to 100 characters and descriptions support ordinary line breaks. New apps are never automatically starred. Only owner-requested stars use `apps_set_starred`.

New apps are requested in ordinary agent conversations; Apps has no separate build button or creation wizard. **Edit with agent** prepares an unsent draft for an existing registered app in a normal agent conversation. Adding an existing app must not trigger service adoption, rebuilding or hosting changes. Ask separately before changing independently operated services.

**Remove from Apps** only unregisters metadata, stars and visit history. It never stops/uninstalls the independently hosted service, deletes its source/data, or affects other apps. Service cleanup remains the owner's separate responsibility.

## Viewer and compatibility

A persistent, accessible **Back to Apps** control remains outside the frame, respects safe areas and a configurable corner, and explicitly returns to `/apps` with scroll and originating tile focus restored. Internal frame navigation does not change the viewer URL or record additional visits. Viewer entry records one visit per navigation; retry does not add visits.

The iframe permits scripts, forms, same-origin application storage/cookies and downloads. Streaming and WebSockets connect directly from the app to its own services. Top navigation and popups are not granted; camera/microphone/geolocation/fullscreen/payment/USB/clipboard permissions are denied by default. These are practical restrictions, not protection from malicious trusted same-origin apps.

Embedding is not universally compatible:

- An app's CSP `frame-ancestors` and X-Frame-Options must permit Jelly. Configure the app; Jelly never strips or bypasses its headers.
- HTTPS Jelly cannot embed HTTP apps. Configure HTTPS hosting for the app or use HTTP Jelly on the trusted private network; there is no downgrade/fallback launch mode and no built-in TLS provisioning.
- Framed login, third-party-cookie restrictions and OAuth flows requiring popups/top-level navigation may be incompatible. Configure the app's authentication, not Jelly's control policy. Some apps will remain unsupported.
- The browser must reach the URL. Check app uptime, Tailscale connection/ACLs and device-specific hostname access. Local server health does not prove remote-device availability.

Load events can fire for blank/denied frames and do not prove rendering. Jelly cannot diagnose every cross-origin error. The viewer does not show a timed embedding-help overlay or help menu item. Registration and mixed-content errors still offer recovery guidance; Jelly never claims successful rendering, auto-launches a new tab or substitutes a proxy.

## Tools and HTTP API

`instance_info` reports `/apps` and capabilities `{supported:true, presentation:"trusted-iframe", registrationOnly:true, warnings:[…]}`. These are launcher capabilities, not claims of service health or isolation.

| Tool / action | HTTP route | Behavior |
| --- | --- | --- |
| `apps_list` | `GET /api/apps?q=&after=&limit=` | Starred and paginated unstarred history (default 30, maximum 100) |
| `instance_info` / capabilities | `GET /api/apps/capabilities` | Trusted launcher capability/trust notice |
| `apps_get` | `GET /api/apps/:id` | Metadata; tool includes viewer URL |
| `apps_register` | `POST /api/apps/register` | Name + URL; optional ID/slug/description/icon/project/builder/source/corner |
| `apps_set_starred` | `POST /api/apps/:id/star` `{starred:boolean}` | Explicit idempotent preference |
| Viewer entry | `POST /api/apps/:id/launch` `{navigationId:string}` | Deduplicated visit intent |
| `apps_remove` | `POST /api/apps/:id/remove` `{}` | Unregister metadata only; no uninstall parameter |
| Icon | `POST /api/apps/:id/icon` / `GET /api/apps/:id/icon` | App-owned PNG/JPEG/WebP, at most 1 MiB; private authenticated reads |

All reads require a session; all mutations also require CSRF. Agent tools use the same registry service, not a second database client. Deployment/control/log tools, release manifests, observers, gateways and templates have been removed.

## Verification

`bun run test:apps` covers registry/API/security/tools/icons/client/native networking. `bun run test:apps-browser` uses disposable Chromium fixtures at desktop and phone widths: direct iframe URLs, scripts/forms/streaming/WebSockets, reloads/internal navigation, back/scroll/focus, framing failures, login guidance, mixed HTTPS/HTTP and downtime. Tests demonstrate accepted same-host HttpOnly cookie sharing using temporary credentials, without logging values. Network fixtures bind random ports on loopback and discovered Tailscale IPv4/IPv6 addresses, never the live service port, covering shared HTTP/SSE/VNC WebSocket handlers and native Vite finite streaming/HMR. Tailscale networking tests skip when discovery is unavailable. Private instance/configuration/socket directories are excluded from Vite watching as well as HTTP serving. An initial in-process infinite-SSE teardown probe did not drain; a separate disposable native dev-launcher subprocess subsequently exited cleanly on SIGTERM with an active SSE client, using temporary data and random ports. The in-process fixture limitation is not evidence of a production failure. Chromium/OpenSSL are fixture dependencies, not production TLS requirements. `bun run check` remains the integration gate.

The operator confirmed an empty registry and no installed app/gateway services for this change. Migration/restore and legacy compatibility were explicitly skipped; no live database or service lifecycle is changed during implementation. Existing unused physical tables in an old empty database are not adopted or queried. Fresh databases contain only Apps metadata, visits and icons. Unrelated schema migrations are preserved.

Wealthboard at `http://box.tailbfab3f.ts.net:3007` is the intended first real acceptance case, **not automatically registered**. After reviewed activation, the owner should register it and observe embedding locally and on a separate Tailscale device. Real phone/Safari/PWA, third-party-cookie/OAuth configurations, remote-device reachability and live activation remain unverified until actually observed.

## Jelly activation helper

`scripts/restart-when-idle.sh` supports Linux/systemd and macOS/launchd. Run it
**outside Jelly's service**, from a separate systemd user unit on Linux or a
separate terminal/launchd job on macOS, never inline from an agent run. It polls
every five seconds for up to 30 minutes, respecting owner-managed restart holds
in the checkout's `.jelly/restart-holds` and the configured data directory's
`restart-holds`, and checks running runs through read-only SQLite.

Linux retains the `jelly.service` restart and legacy `jelly-dev.service`
migration. macOS reads the port and data directory from
`/Library/LaunchDaemons/com.jelly.server.plist`, requires that it belongs to this
checkout, and uses `launchctl kickstart -k system/com.jelly.server`. Run
`sudo /bin/bash scripts/restart-when-idle.sh` from a separate terminal, or grant
noninteractive sudo for that launchctl command to the helper's user. The helper
never prompts for a password. Direct launchctl/systemctl restarts and crash
recovery bypass the helper's idle checks; it does not alter service configuration.

Readiness checks the service state and both loopback and connected private
Tailscale HTTP, including public `/api/health`, without reading unauthenticated
private state. Tailscale discovery uses a portable Python subprocess timeout; GNU
`timeout` is not required. Verification is from this host, not an independent
remote peer. The Linux default port is 5173; macOS uses the plist's `JELLY_PORT`
(5173 if unset). `JELLY_RESTART_PORT` (1–65535) and `JELLY_DATA_DIR` can override
the helper's port and data directory when they match the installed service.
Neither changes the server's configuration. Disconnected Tailscale, invalid
settings, failed restart privileges or failed health is not reported as verified.
Tests use copied helpers, temporary databases/plists and fake service-manager
commands; they never restart the live service.
