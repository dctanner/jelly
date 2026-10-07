# Browser controllers

Settings → Browser controller selects **Playwright** or **AgentBrowser** globally.
New and upgraded installations default to AgentBrowser. The choice is saved in
SQLite, not browser local storage. An already allocated agent browser session
keeps its controller, including during agent work or private human control.
Return human control, close the browser session, and reopen it to apply a changed
choice. Closing the viewer alone does not close the session. A service restart
also applies the saved choice to newly allocated sessions.

## Profiles and privacy

Both controllers use the existing Jelly-managed Chromium profile:
`<dataDir>/browser-sessions/<sha256(agentId)>/browser-profile`.
The separate browser home and profile directories are private (0700). Different
agents and different Jelly data directories never share these directories.
There is no profile migration, cookie export, native `--restore` state file, or
copy into a second backend-specific profile. Existing sign-ins remain where they
are. Chromium restores the last session, including session cookies; individual
websites can still expire or revoke logins.

Closing a session or shutting down Jelly closes its daemon, Chromium and desktop,
and removes its temporary sockets/display files, **not** its persistent profile.
Archive/restore retains profiles as before. Jelly currently has no agent-deletion
API; this change does not add one or silently destroy archived agents' logins.
Do not manually remove profile directories while their session is running.

## Actual controller boundary

`agent-browser` is pinned to **0.38.2**. Jelly starts its packaged Linux native
Rust binary in daemon mode and uses the same newline-delimited Unix-socket JSON
protocol as the upstream CLI (`cli/src/commands.rs`, `connection.rs`, and
`native/daemon.rs` at tag `v0.38.2`). This is a version-specific integration, not
an invented JavaScript API or a relabeled Playwright controller. Upgrades need
protocol review and the real-browser integration test.

AgentBrowser actually performs navigation, coordinate mouse clicks, focused
keyboard insertion/key presses, and scrolling. Before each operation Jelly
selects the exact Playwright page's CDP target ID; native pin-tab mode prevents
falling through to another tab when that target disappears. No raw native
snapshot, console output, error text, URL inventory, or credential data is
returned to the model.

Playwright continues to launch persistent headed Chromium on Jelly's isolated
X display, block service workers, enforce managed-browser request routing,
provide screenshots and bounded/redacted observations, own tabs and exact-node
references, and implement safe referenced clicks/fills/uploads. Private login
navigation and VNC remain in the existing bridge. In particular, the native
controller never receives local upload paths or native credential-vault commands.
This deliberate hybrid preserves existing tools and upload/secret-field checks.

## Isolation and lifecycle

Chromium's additional CDP listener and the native daemon's streaming listener
bind to loopback only. Every managed Chromium, including Playwright-selected
sessions, uses a mandatory loopback SOCKS5 TCP egress gate. Chromium's implicit
localhost bypass is explicitly disabled; there is no DIRECT fallback, and QUIC
is disabled. The process-wide reference-counted registry denies every agent's
controller ports and every egress listener, regardless of hostname or IPv4/IPv6
alias. New registrations also close existing connections to the protected port.
Existing Jelly protected origins and HTTP/WebSocket route checks remain in place.

The network gate is necessary because Playwright `context.route()` only sees the
first request in a redirect chain. SOCKS sees the connection to each redirected
destination, including from pre-existing workers, restored tabs and new tabs.
Responses are not fetched, interpreted, or buffered: HTTP, HTTPS, WS/WSS,
streaming, uploads, downloads, cookies and login redirects stay end-to-end.
Chromium still verifies TLS certificates. Handshakes and DNS/connect attempts
are bounded; only SOCKS CONNECT is supported, not BIND or UDP ASSOCIATE.
This protects TCP control endpoints, not a general browser network sandbox:
WebRTC can still emit UDP/STUN traffic, which cannot speak to these TCP-only
listeners. A real WebRTC TURN/TCP test verifies the TCP gate is used.

CDP and native stream ports are reserved and registered before their processes
can listen. Reservations exclude already registered ports during simultaneous
Jelly starts. Chromium uses its exact reserved port. AgentBrowser receives
`AGENT_BROWSER_STREAM_PORT`; if upstream falls back to an unexpected port, Jelly
protects that actual port, kills the daemon, and fails startup before attaching
Chromium. There remains an OS bind-handoff race if an unrelated local process
claims a released reservation. Local processes already have direct access to
loopback endpoints and are outside the managed-page threat model; unexpected
native fallback is never accepted as a working session.

Native commands use a Unix socket inside the session's random 0700 temporary
runtime directory, never a shared default daemon. The daemon gets an allowlisted
environment and private HOME, without ambient plugins, configs, cloud providers,
credential stores, or automatic state restore.

The daemon is a managed child using Jelly's existing Linux parent-death shim.
It has a 10-second startup deadline, 35-second per-command transport deadline,
bounded responses, and bounded shutdown. Native failures are redacted; unavailable
or disconnected AgentBrowser does not silently fall back to Playwright actions.
A failed native session can be closed and reopened; selecting Playwright is also
an explicit alternative. All controller calls stay inside the existing serialized
operation and human-handoff gates.

The npm tarball contains platform binaries without executable bits. Jelly mirrors
the upstream launcher's executable-bit repair for its bundled binary, without
running a postinstall download or installing a second Chromium. Linux x64/arm64
(glibc or musl binary selection) is supported; only Linux x64/glibc has been tested
here. Existing desktop dependencies (`bun run setup:desktop`) are still required.

## Validation

`bun run check` includes `tests/agent-browser.test.ts`: temporary SQLite settings
migration/reopen, session selection/isolation, and a real native-controller desktop
smoke test when desktop dependencies are available. The smoke covers native
input, navigation, multiple tabs, managed headers/control-port blocking, secret
redaction, private handoff/resume, simultaneous isolated profiles, persistence
across close/reopen and controller changes, and dead-daemon fail-closed behavior.
It uses temporary profiles and a local HTTP fixture; it does not use live logins.
API and Settings UI tests cover validation, defaults, and saved selection.

`tests/browser-egress.test.ts` covers strict SOCKS parsing, denied destinations,
fragmented handshakes, binary streaming, cancellation, revocation and shutdown.
Real Chromium tests also cover same-agent/cross-agent multi-hop redirects from
both controllers, dedicated/shared workers created before port registration,
new tabs, IPv6, TLS verification, WS/WSS, uploads/downloads, streaming, sign-in
redirects, TURN/TCP and fail-closed behavior with an unavailable proxy. HTTPS/WSS
tests use an ephemeral self-signed test certificate: rejection is verified first,
and only a separate test context accepts that fixture certificate. Native stream
port-collision coverage verifies upstream fallback fails before attachment.

`bun run test:browser` runs the native/egress suite, then
`tests/browser-transport.test.ts` in a separate Bun process. This preserves every
TLS/IPv6/WebRTC assertion while avoiding an observed Bun 1.3.9 Chromium shutdown
hang when headed persistent and headless WebRTC fixtures share one process.
The browser suite also runs separately from server harness tests; both are
mandatory parts of `bun run check`.
