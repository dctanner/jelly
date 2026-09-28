# Phase 2 — Administrator and browser handoffs delivered

## Implemented scope

Jelly now includes two human handoff capabilities to the local Jelly server and web client.

### Sudo escalation

Commands execute automatically with `sudo -n`. The password handoff below applies only when the OS requires authentication. Ordinary command failures return directly and are not retried. The card says **Authenticate and run**. General shell/file tools and subagents are also enabled; browser handoff controls constrain Jelly browser tools, not arbitrary same-user shell commands.

- A Pi tool executes a specific executable and argument list, working directory, and reason.
- When authentication is required, the run waits while Jelly shows a password card with the exact command and requesting agent.
- The user enters their local sudo password in a dedicated password field and chooses **Authenticate and run**, or denies the handoff.
- The server invokes sudo for that command only. No shell interpolation, reusable grant, or shared sudo session is exposed to the agent.
- The password is transient: never written to SQLite, logs, command arguments, environment variables, activity events, or model context. It is supplied to sudo's authentication input only when sudo asks for it.
- The authentication handoff is single-use and bound to the immutable command. Expired, cancelled, interrupted, and already-resolved requests cannot execute.
- The agent receives the command result or a denial/error. Password authentication failures require another explicit authentication attempt.
- Stop and server shutdown cancel pending requests. After restart, stale handoffs are interrupted and cannot run automatically.

### Browser desktop over VNC

- A Computer button opens an embedded noVNC view at any time, independently of an agent run.
- Jelly manages a private Linux desktop, a browser with an instance-specific persistent profile, and local VNC connections.
- A Pi browser-login tool opens a requested website, raises a visible handoff, and waits while the user signs in through VNC.
- Users can view the desktop, take control, and explicitly return control to the agent.
- Browser interaction tools use the same browser and profile, allowing the agent to continue after sign-in.
- While a user controls the desktop, agent browser interaction and screenshots are blocked. Typed credentials are not copied into chat or tool results.
- Control is exclusive to one browser session. View-only access is enforced by the VNC server, not just by a disabled UI toggle. Other viewers are disconnected during a private sign-in handoff.
- Refreshing or disconnecting never silently hands control back to an agent. The user explicitly resumes.

### Local security boundary

- Keep the server on loopback. Control routes require a browser control session, CSRF token, and same-origin checks.
- VNC WebSocket access uses short-lived, single-use tickets bound to that session and its access mode; do not expose a generic network proxy.
- VNC and browser debugging endpoints stay local and credentials stay out of the model context. The managed browser cannot access Jelly’s own control origins or approve its own requests.
- This local release trusts the operating-system user running Jelly. Public/remote access still requires the authentication and transport work in Phase 3.

## Delivered acceptance criteria

1. Plans and architecture document both capabilities and their limits.
2. A Pi run can pause for sudo, show the immutable command, accept password authentication or denial, and resume with the result.
3. Tests prove that passwords do not appear in persistent records or model-facing events, and cannot fall through to a command's stdin when sudo does not ask for authentication.
4. Request expiry, duplicate approval, invalid CSRF/session, cancellation, and restart recovery are handled.
5. A user can open a real VNC screen without an agent request and interact with the browser.
6. An agent-requested website handoff uses that same desktop and browser session; the user can return control and the agent can continue.
7. Tests exercise the real VNC protocol, input control, browser session continuity, and the server-enforced human-control boundary.
8. Existing Phase 1 behavior, themes, tests, and builds continue to pass.

## Verification

- `bun run check`: TypeScript, existing Pi/API/SSE/restart tests, sudo broker and intervention lifecycle tests, React approval-card and theme tests, production client build.
- `bun run test:desktop`: real Xvfb, x11vnc, Chrome, WebSocket/RFB handshake and framebuffer; verifies server-side view-only enforcement, exclusive control, viewer revocation, reconnect ownership, screenshot/action blocking, login through actual VNC input, continuation through the same browser, and cookie persistence after a Jelly restart.
- Sudo tests use an executable fixture implementing the askpass contract. They cover secret redaction, empty command stdin with/without authentication, failure, timeout, cancellation, session/CSRF/origin rejection, duplicate approvals, expiry, denial, restart interruption, and absence of passwords from SQLite/events/model history.
- Sudo password coverage uses fixtures; no successful real host password authentication is claimed. The remaining live check is recorded in [Phase 2](../plans/02-validation.md).

## Current limits

The managed desktop is Linux-only and is shared across agents in one instance. The unprivileged setup helper targets Debian/Ubuntu x86-64; Chrome/Chromium is a separate prerequisite. The browser keeps its sandbox enabled and fails with an actionable error if the host cannot support it. No personal browser profile is imported. Clipboard synchronization is disabled.

These are local capabilities; the server remains bound to loopback. Session controls do not defend against other processes running as the same OS user. Sudo grants the authority of the executable and arguments it runs, including any shell or script requested; it is not an execution sandbox. Sudo output is limited to 64,000 characters per stream, command runtime to two minutes, and requests to ten minutes. Cancel/timeout requests termination but cannot undo effects or guarantee cleanup of deliberately detached privileged children.

A browser session expires after 24 hours. If its cookie is lost while it owns control, restart Jelly to reset control ownership; browser website sessions remain in the managed profile. Restarting never re-executes a pending authentication request.
