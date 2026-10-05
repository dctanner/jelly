# Apps — a home for things built with Jelly

Status: proposed design; no implementation or deployment yet.

## Product decisions

- Add two first-class destinations: **Apps** and **Agents**. Apps is the launcher; Agents retains the existing project/inbox/chat experience.
- `/apps` is the Apps Home Screen. Restore the last destination on ordinary visits; explicit app and conversation links take precedence. Do not unexpectedly move existing users out of Agents.
- Apps are persistent web applications, not transcript HTML previews, remote-browser sessions, or temporary development servers.
- On Linux, each managed app runs as a persistent **systemd user service**, on allocated ports, reachable locally and privately over Tailscale.
- Default launch is inside a minimal Jelly-owned app viewer. A small, always-available home control returns to Apps even if the app crashes.
- App processes survive agent completion, browser closure, and Jelly restarts. No public publishing or Tailscale Funnel.

## Home Screen

Use a spacious, responsive grid of rounded-square icons with short names underneath, rather than dashboard cards full of technical details. Start with three columns on narrow phones and adapt to available space. Follow Jelly theme, spacing, motion, and accessibility conventions.

Each tile has:

- App icon and name; a generated initial/color fallback until an icon is supplied.
- An understated status indicator only when stopped, starting, or unhealthy.
- A separate accessible overflow action for **Details**, **Open in new tab**, **Edit with agent**, **Start/Stop/Restart**, and **Remove from Apps**.
- Stable alphabetical ordering for v1; do not reshuffle tiles on every visit or health update.

The header provides Apps/Agents navigation and **Build an app**. Keep search lightweight; no folders, marketplace, widgets, or drag-and-drop ordering in v1.

Empty state: “Your apps live here. Ask Jelly to build something.” Build an app selects or creates an agent/project and opens a normal conversation with an app-building intent. It does not silently launch a model request.

Details shows description, linked project/agent, local and Tailscale URLs, service state, health-check time, and sanitized diagnostics. Technical fields are secondary. An unavailable app remains in the grid with a useful recovery screen, not a blank browser error.

Switching between Apps and Agents preserves chat drafts, selected project/agent, scroll position, unread counts, and active work. Removing or archiving the builder agent must not delete the app.

## Visiting an app and getting home

### Default: Jelly-owned viewer

`/apps/:id` opens a full-viewport, cross-origin iframe with no agent sidebar or permanent toolbar.

- A small floating **Jelly home** pill sits at the top-left, with a visible home mark and a minimum 44px hit target.
- It is rendered by Jelly, outside the iframe: the app cannot accidentally remove it or make it disappear during loading.
- It returns explicitly to `/apps`, restores grid scroll, and focuses the originating tile. Do not implement this as `history.back()`: the app may have navigated many times.
- Keep it lightly styled but discoverable. Never require a hover, swipe, long press, or undocumented keyboard shortcut.
- Respect safe-area insets. Reserve a small corner clearance in generated apps; provide a configurable alternate corner for apps whose controls conflict.
- An adjacent compact menu offers app details and **Open in new tab**. No chat composer overlays the app.
- Browser Back/Forward, reload, and deep links must work. Iframe history can affect browser Back; explicit home remains deterministic.

Generated apps receive a tiny optional Jelly bridge for readiness and internal-route reporting. Persist only validated relative routes for shareable viewer deep links; do not copy tokens or arbitrary query strings into Jelly URLs. Validate every bridge message's origin, source window, app identity, and schema. No arbitrary commands or control credentials cross this bridge.

Use sandbox and permissions-policy restrictions: allow the scripts, forms, and origin behavior needed by the app, but deny top-level navigation and unrestricted popups by default. Grant additional capabilities explicitly. Do not force existing apps to remove security headers merely to make embedding work.

### Direct access and incompatible apps

Some apps require top-level OAuth, browser capabilities, or forbid framing. Support a recorded `launchMode: direct` and a visible direct-launch fallback; iframe `load` alone is not proof that an app rendered successfully.

The generated-app template also includes a lightweight **Jelly home** link for direct visits, hidden when running in the validated viewer. Use configured local/Tailscale Jelly origins and an allowlisted return destination, never an arbitrary return URL. This makes a bookmarked app usable without first visiting Jelly.

For an imported app without the integration, open directly in a new tab and keep Apps in the original tab. Be explicit: Jelly cannot guarantee an in-page home button on an arbitrary external page. Fullscreen app content can also obscure parent UI; do not allow fullscreen by default.

## Registry and lifecycle

Add an instance-scoped SQLite app registry, accessed through a server service layer. Agents must not edit the database directly.

Suggested record:

```text
id, slug, name, description, iconAssetId
projectId?, builderAgentId?, sourceDirectory
managementMode: managed | linked
launchMode: embedded | direct
runtimePort?, gatewayPort?, unitName?, deploymentRevision?
executable?, args?, healthPath?
localOrigin?, tailnetOrigin?, allowedJellyOrigins
desiredState, createdAt, updatedAt
```

Ports, generated unit names, and canonical managed origins are server-controlled. Store secret references separately, never secret values in registry/API responses. Runtime observations (service state, HTTP health, Tailscale reachability, last error) are distinct from desired state and include timestamps.

Two entry paths:

1. **Managed app**: Jelly allocates ports and manages its unit, gateway, and health.
2. **Linked app**: register an existing private app URL without taking ownership of its service. No stop/delete-service controls until explicitly adopted.

Use transactional port reservations, per-app deployment locks, idempotent registration, and conflict checks against actual listeners. A reserved database port is not proof the OS port is free.

Lifecycle: draft → deploying → ready, with separate stopped/unhealthy/failed observations. Failed deployment keeps diagnostics and any previously working release rather than leaving an apparently healthy tile.

**Remove from Apps** unregisters only. For a managed app, explain that it will continue running. A distinct **Uninstall service** action stops/disables and removes only Jelly-owned units/gateways; source code and app data remain unless explicitly deleted in a separate operation.

## Persistent services and networking

### Runtime

- Target this instance's Linux/systemd environment first; return an explicit unsupported-platform result elsewhere.
- Generate namespaced units such as `jelly-app-<id>.service` under the user's systemd directory.
- Use a production start command, absolute executable and working-directory paths, structured arguments, escaped unit fields, `Restart=on-failure`, and bounded restart rates.
- Build and test before activation. Keep runtime data outside replaceable build artifacts and retain the last known-good release. Code rollback does not reverse database migrations; migrations need a backup/compatibility plan.
- Enable units for boot; verify user lingering rather than assuming reboot persistence. Ordinary operations use `systemctl --user`, not root.
- Keep app lifecycle independent of `jelly.service`: deploying or stopping an app must not restart Jelly or other apps.
- Detect available service-manager/Tailscale capabilities up front and return actionable errors. Do not report deployment success until health checks pass.

### Private access

- Bind the application runtime to loopback only.
- A separately managed per-app gateway exposes an allocated origin locally and on explicit Tailscale addresses. Example: `http://box.tailbfab3f.ts.net:<app-port>`.
- Do not bind wildcard/LAN addresses. No Funnel, public DNS exposure, or automatic sharing with new tailnet members.
- Derive addresses from instance configuration/Tailscale discovery, never hard-code this machine's name.
- Local Jelly opens local app origins; remote Jelly opens tailnet origins. Never hand a phone a `127.0.0.1` app URL.
- Distinguish process health, HTTP health, and external reachability. A local HTTP success is not evidence that a phone can reach the app.
- Recover forwarding after Tailscale disconnect/reconnect and address changes. Local apps should remain usable while Tailscale is unavailable.
- Preserve streaming, WebSocket upgrades, upload/download behavior, and app redirects through the gateway.
- Tailnet ACLs still determine access. Tailscale reachability is not per-app user authentication; apps with sensitive data may need their own sign-in.
- HTTP on a tailnet hostname is not a browser secure context. Apps needing secure-context APIs require private HTTPS. Never embed an HTTP app into an HTTPS Jelly viewer; add a supported private TLS configuration or use direct launch with an explicit limitation.

### Isolation is a release gate

Do **not** reverse-proxy arbitrary app HTML under Jelly's own origin (for example `/apps/:id/content`). That would give app JavaScript Jelly's browser authority.

Different ports provide different browser origins, but **cookies are not port-scoped**. Reusing the machine hostname with different ports is therefore insufficient by itself:

- The app gateway must strip Jelly control cookies before forwarding to the runtime and reject reserved Jelly cookie names in app responses.
- Isolate/rewrite app cookies per app, including collision and deletion behavior; do not expose a raw runtime port through Tailscale that bypasses this gateway.
- Audit Jelly API reads and writes for cross-origin/same-site access, CSRF, credential bootstrap, redirects, and WebSockets. Never add app origins to Jelly's trusted control-origin list.
- Constrain gateways and health probes to registered destinations; no arbitrary URL-fetch endpoint, redirect-following SSRF, path traversal, or arbitrary unit management.
- If robust cookie isolation cannot be demonstrated, require distinct app hostnames with appropriate host-only cookies before shipping managed embedding. Do not silently fall back to raw same-host TCP forwarding.

App source runs under the same OS user in v1. These browser/network boundaries do not sandbox malicious server-side code. Strong process/filesystem isolation is a separate future capability.

## Make agents Apps-aware

Add concise instance-level instructions for every agent, not only a particular project's `AGENTS.md`:

> Jelly has an Apps Home Screen. When asked to build and publish a persistent web app, inspect the Apps capabilities, build it in its project, test it, and deploy/register it using the Apps tools. Use production user services and private loopback/Tailscale access. Include Jelly home navigation. Never claim an app is live until deployment and health checks succeed. Do not auto-publish every HTML preview or unfinished prototype.

Extend `instance_info` with the Apps Home URL and supported deployment/network capabilities. Provide structured tools backed by the same service layer as the UI:

- `apps_list` / `apps_get`: registry, ownership, status, URLs, and capabilities.
- `apps_register`: create/update metadata or link an existing private app.
- `apps_deploy`: validate manifest, allocate resources, activate a release, and verify health.
- `apps_control`: start/stop/restart a Jelly-owned app.
- `apps_logs`: bounded diagnostics with best-effort redaction; warn app authors never to log secrets.
- `apps_remove`: distinguish unregistering from uninstalling.

The deployment result returns app ID, viewer URL, local/tailnet URLs, unit name, checked health, and any pending remote verification. The agent's final response links to the app tile/viewer, not just a terminal port.

Ship an app template/deployment guide covering host/port configuration, health endpoint, storage, secret references, production command, home integration, framing headers, and direct-launch fallback. Reuse `ChatFormCard`/`ChatFormActions` if an in-chat setup or privileged handoff is needed.

## Implementation map

Current anchors:

- `src/client/App.tsx`: existing history-based project/chat navigation; introduce explicit top-level destinations without breaking that state.
- New `AppsHome`, `AppViewer`, app-detail components, and shared navigation state; extend `src/client/api.ts` and `src/shared/types.ts`.
- `src/server/store.ts`: migration and app records.
- New app registry/deployment/systemd/gateway modules; `src/server/app.ts` exposes validated APIs and existing event transport carries registry/status updates.
- `src/server/harness.ts`: instance instructions and tool registration; new Apps tool definitions remain thin wrappers.
- `scripts/tailscale.ts`: useful existing address-discovery pattern, but its raw TCP forwarding is **not** the cookie-isolating app gateway.
- `docs/DESIGN.md`: document Apps navigation and the viewer home control; add a deployment guide and generated-app template.

## Delivery sequence

1. **Compatibility/security spike**: prove isolated gateway cookies, iframe permissions, WebSockets, direct OAuth fallback, and mobile viewer behavior with disposable fixture apps. Resolve hostname/HTTPS requirements before committing to networking.
2. **Registry and Home**: migration, metadata APIs, linked apps, grid, Apps/Agents navigation, details, deep links, and unavailable states.
3. **Managed deployment**: port allocation, generated user units, gateway, health observation, lifecycle operations, partial-failure cleanup, and last-good-release rollback.
4. **Agent integration**: capabilities, tools, instructions, template, Build an app/Edit with agent flows, and useful chat results.
5. **Hardening and activation**: automated checks plus real local/Tailscale and reboot validation. Document limitations before rollout.

## Acceptance checks

- Ask an agent to build an app; it appears on Apps only after explicit registration/deployment, opens on desktop and phone, and has a working home control.
- Home navigation survives app crashes, loading failures, internal navigation, reloads, direct bookmarks, and unavailable Tailscale.
- Apps/Agents navigation does not lose drafts, project scope, scroll position, or active conversations.
- App services survive agent completion, Jelly restart, and host reboot; starting/stopping one does not affect another.
- Concurrent deployments cannot claim the same ports or overwrite another app's unit. Failed deployment retains the last healthy version where feasible.
- Unregistering, uninstalling, and deleting data have different, tested effects.
- Tests prove an app cannot read Jelly APIs/control credentials, set Jelly cookies, navigate the top-level viewer, or escape the gateway's registered destination.
- Unit/API tests use temporary databases and a fake service-manager/network adapter. Real-service smoke tests use uniquely named disposable units, never the live database.
- Browser tests cover keyboard focus, three-column phone layout, safe areas, no home-control overlap, Back/Forward, frame denial, direct fallback, and WebSockets.
- Run `bun run check` before deployment. Schedule Jelly activation through the existing idle-restart helper, never restart inline; verify both loopback and Tailscale after restart.

## Deferred

Public publishing, marketplace/discovery, arbitrary remote hosting, multi-user app permissions, container isolation, native packaging, custom domains, and a visual app editor. Apps v1 is a private launcher plus reliable deployment for this Jelly instance.
