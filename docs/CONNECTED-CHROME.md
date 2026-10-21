# Connected Chrome — shared-profile local implementation

**Connected Chrome** is a separate browser target, not a managed controller.
Choose one explicitly connected profile and site access **globally for every
persistent Jelly agent**. Agents use separate task groups and exclusive tab
capabilities but share that profile's cookies and signed-in accounts. Managed
Playwright/AgentBrowser profiles, SOCKS egress and VNC remain available and
unchanged. Existing sessions remain pinned until explicitly closed.

The local implementation has real headed-Chrome coverage, including two agents,
two profiles/instances, frames and handoffs. It is still experimental: **this is
not a claim that every signed-in-profile security/hardening requirement is
complete**. See remaining rollout gates below. Installing into the user's normal
profile and activating the global setting are separate, explicit operator steps
after review; tests never modify the normal profile or live Jelly settings.

## Setup (Linux or macOS, same OS user and machine)

1. Start the intended Jelly instance. It creates private
   `<dataDir>/chrome-bridge/` (0700), `pairing.json` and `bridge.sock` (0600).
   Never display or copy `pairing.json`: it contains the instance grant.
2. Run `bun run build:chrome`. In the **chosen Chrome profile**, open
   `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
   select the absolute `dist/chrome-extension` directory.

   Jelly's own fixed public manifest key gives the reproducible development ID
   **`mikadpfmkipiafkemjplldmfckomphcf`**, independent of the checkout/build path.
   The key was generated for Jelly; it is not OpenAI's identity. No private
   signing key is committed or retained and this is not a Web Store signature.

3. Install Jelly's separate native host, explicitly selecting the instance and
   Chrome **user-data root** (the directory containing `Default`, not `Default`):

   ```sh
   bun run chrome:install-host --data-dir /absolute/jelly/data \
     --chrome-config /absolute/chrome-user-data
   ```

   For the normal Linux installation the latter is ordinarily
   `~/.config/google-chrome`. On macOS use
   `~/Library/Application Support/Google/Chrome` (quote the absolute path):

   ```sh
   bun run chrome:install-host --data-dir /absolute/jelly/data \
     --chrome-config '/Users/your-user/Library/Application Support/Google/Chrome'
   ```

   For tests always use a temporary path. The fixed
   development extension ID is the installer's default; `--extension-id ID` is
   available for a separately reviewed build. Installation creates only
   `NativeMessagingHosts/org.jelly.browser.json` and this instance's private
   wrapper/config/ID registration. It refuses another instance's existing Jelly
   manifest and preserves unrelated hosts. Moving Bun/repository requires
   reinstalling the wrapper. One host registration chooses one Jelly instance
   per Chrome user-data root; use separate roots for separate instances.

4. The extension connects automatically on load and browser startup, without opening
   the popup. The popup shows Connecting, pending private handback, Connected, or a
   bounded safe failure category. Unavailable hosts retry using MV3 alarms (30 seconds
   up to five minutes between attempts). **Disconnect** persists across browser restarts;
   only **Reconnect to installed Jelly instance** clears it. Legacy `#connect` URLs
   only open status and never override Disconnect. Server-side Disconnect also records
   a durable profile block, cleared only by an authenticated explicit Reconnect.
   Failed task settlement conservatively requires the same explicit reconnect.
   Upgrade the backend, native host and extension together (extension 0.3.2/protocol 7).
   Reload the unpacked extension after the backend update; mixed protocol versions
   refuse pairing, with no fallback. Existing persistent Disconnect intent is retained.
   Transport recovery always creates a new generation, never reclaiming old task tabs.
   Server Disconnect records are private, bounded and atomically replaced with file
   and directory fsync. Failed replacement retains its synchronized transaction;
   capacity exhaustion writes a bounded `blockedAll` overflow marker before revocation.
   Unsafe/malformed state, pending transactions or that marker refuse bridge startup.
   Preserve these records for operator repair; do not delete them to unblock Chrome.
   Repair must retain all disconnected IDs from committed and interrupted state;
   an overflow marker means global denial, not just denial of the first overflow ID.
   Do not clear that marker merely to regain admission. Ordinary valid state uses
   explicit Reconnect to unblock only the intended profile.
   Persistence errors always revoke the affected live socket and fail closed for new
   admissions in the running bridge. If the filesystem cannot create/write any intent
   record at all, however, that new intent cannot be guaranteed across restart: repair
   storage and preserve the disconnect decision before restarting. Hardware/filesystem
   failures that lose even synchronized writes are also outside the guarantee.
5. In **Settings → Browser target**, choose Connected Chrome, the exact connected
   profile, and **Site access**. Choose **Approved sites only** with exact HTTP/HTTPS
   origins (one per line), or **Unrestricted web (HTTP and HTTPS)** with no
   origin list, then **Save browser target
   and site scope**. This is a global setting, not per-agent setup. Every
   persistent agent's next unpinned browser session uses it.

   Approved-site scope accepts exact canonical HTTP/HTTPS origins, including local
   services and literal IPs, without wildcards. Approve required asset and identity-provider
   origins deliberately. Unrestricted web allows public and local/private services
   reachable from this machine, redirects, assets, frames and WebSocket resources
   without an origin allowlist, using the profile's signed-in accounts. Other websites'
   subresources may now reach local services intentionally. This is not a network
   sandbox. Both modes reject credentials in navigation URLs, non-web navigation and
   Jelly's exact control origins (including equivalent WebSocket endpoints); other ports
   on the same host remain available. DNS aliases are not an isolation boundary, and
   same-origin/CSRF protections do not prevent all cross-site side effects. A
   disconnected selected profile never falls back to another profile or managed
   browser. Already allocated sessions keep their target/profile/sites; stop the
   agent and **Close / Reset pinned target** to change those choices, including
   switching between approved-site and unrestricted access. Existing settings
   without a site-access mode retain approved-site behavior.

No Chrome restart, remote-debugging port, profile copy or cookie migration is
needed. Browser-on-laptop/Jelly-on-server needs a separate authenticated remote
transport; local native messaging cannot bridge machines.

## Tasks, tools and user tabs

- `browser_name_task` gives groups a short task label:
  `🔎 Jelly · Agent · Task`. Agent colors are stable; groups are per task/window.
  New task tabs are background tabs. Only explicit **Open in Chrome** focuses a
  tab/window; Jelly enables it only after acknowledged pause. Human regrouping/
  group deletion never grants or transfers a lease.
- `browser_open`, `browser_tabs`, `browser_snapshot`, `browser_screenshot`, exact
  `browser_click`/`browser_fill`, bounded `browser_scroll`, `browser_select`,
  referenced `browser_key` and `browser_wait_for` are supported. Keys are semantic
  button activation or element-scoped key events, not OS/global shortcuts or
  trusted general keyboard emulation. Select takes an option value; snapshots
  do not expose selected form values. Waits support bounded visible text,
  untruncated text absence, or DOM readiness, never arbitrary evaluation.
- Snapshots combine bounded visible text and exact references from authorized
  same-process and cross-site/OOPIF documents. References bind to connection,
  session, tab, document and observation epochs. Frame origins must be granted;
  hidden/clipped frames, srcdoc, object/embed and author shadow roots (open or
  closed) fail closed. The isolated extension uses Chrome's
  `chrome.dom.openOrClosedShadowRoot` on a bounded light-DOM scan; it rejects
  the entire document rather than inspecting private root contents. Missing API
  support also fails closed. A secret field anywhere makes the whole tab unobservable. Actions
  cannot use another document's/agent's stale reference.
- Screenshots return PNG tool image content, never base64 text in model output.
  Screenshots with detected secret/nonempty/contenteditable fields or any author
  shadow root are rejected. Stable closed-root fields cannot bypass these guards;
  transient rendering/capture races remain a separate, unresolved rollout gate.
  Large images fail at the bounded cap rather than exporting to disk.
- Each agent automatically controls its own Jelly-created task tabs and groups within
  its approved site scope. No individual tab-grant workflow exists. Personal tabs and
  other agents’ tabs cannot be claimed, even by hidden popup RPCs. Group membership is
  organization, not authority; reconnect never reclaims stale groups, tabs or capabilities.
- Popups are adopted only from an exclusively leased opener during an authorized
  run, after installing policy and checking the destination. Adopted popups get
  fresh capabilities and task groups; unapproved/failed popup adoption pauses the
  task and does not disclose its content. **Chrome can start popup networking
  before its creation notification**; see the rollout gate below.

## Pause, private handoffs, settlement and recovery

`request_browser_login` opens a scoped task tab, marks it for retained handoff,
pauses and detaches before waiting. During reservation/open/mark/drain the inline
`ChatFormCard` says **Pausing—do not enter credentials yet**. **Open in Chrome**
and **Return control to agent** stay disabled until live task state confirms the
matching handoff's reservation and extension pause acknowledgement. Failure and
disconnection never advertise private-safe state. **Open in Chrome** focuses the
real local task tab; **Open web VNC…** opens the full-desktop viewer described
below, with a normal **Take control** action. Neither launches or copies Chrome.
Enter credentials only after the relevant pause acknowledgement. Approved site
restrictions remain during handoff. Resume invalidates observations; secret-field
pages remain blocked until the fields disappear.

The extension popup always offers **Pause all agents locally** and **Disconnect**.
Local pause revokes authority before notifying Jelly, drains already-dispatched
isolated scripts/captures/tab mutations and waits for debugger attachment/detachment. An action
already admitted before pause may complete before acknowledgement; its result is
revoked and it is never replayed. **Wait for paused status before entering
credentials.** Server authority revocation is separate from acknowledged pause;
settings and the extension popup show **Pausing—do not enter credentials yet**
while draining, not **Paused**. Jelly's settings also expose per-task
pause/resume/focus/disconnect.
Debugger attachment is cleared only after confirmed detach or tab removal;
rejected detach reports **Pause failed**, never acknowledged **Paused**. Retry
pause explicitly or close the affected tab; do not enter credentials after a
failed or uncertain transition. Resume removes the human-safe indicator before
dispatch and displays **Resuming—do not enter credentials** until acknowledgement.
Late responses cannot undo a newer pause, and failed resume never restores a safe
indicator. Settings, cards and the packaged popup discard superseded status reads.
Native pause/end preempt queued work; cancellation/timeouts disconnect, making
in-flight mutation outcomes indeterminate. Debugger conflict/cancellation pauses,
with no automatic reattachment until explicit resume.

After the complete Jelly run settles and children are disposed:

- Temporary agent tabs close.
- Deliverables (`browser_keep_tab`, default `mark: "deliverable"`) remain open
  without a lease/debugger and with task restrictions removed.
- Agent tabs marked `handoff` remain reserved and paused across follow-up runs.
  All private-control pauses, including protective pauses after debugger conflicts
  or tab replacement, preserve temporary agent tabs if the run settles before
  resume, so settlement cannot close a tab during private human work. The human
  can keep using the open tab while agent observations and input stay revoked.
  Resuming restores those implicitly preserved tabs' normal temporary cleanup.
  The same task/profile persists but the next run gets new run authority. Start
  a follow-up browser run, then explicitly **Resume**; old-run tools are rejected.
  A follow-up that never uses the browser does not discard a retained handoff.
- User tabs always remain open and are released, even during automatic cleanup.
- Closing an idle retained session releases retained tabs as well; it does not
  silently retarget another active session.
- Human closure of the last idle retained tab removes the extension session, so
  repeated Close/Reset cycles do not exhaust its task capacity.

Disconnect, worker termination, browser/server restart and tab replacement revoke
capabilities; there is no mutation replay or automatic authority reconstruction
from numeric IDs. Transport reconnects automatically unless explicitly disconnected;
close/reset the lost Jelly session and
allocate anew. Startup reconciles only cleanup: detach this extension's old
sessions and remove its stale per-tab rules; never close/reclaim leftover tabs.
They cannot be reclaimed through the popup. Navigation,
frame-document changes, detach and handoff invalidate references; group deletion
only discards organizational metadata. Cleanup cannot guarantee closing temporary
tabs after transport has vanished.

Debugger cleanup obligations are separate from tab leases and are persisted in
extension session storage **before** an attachment attempt. Disconnect revokes
all authority but does not forget a rejected or uncertain detach. Reconnect
refuses pairing until cleanup is confirmed, and quarantined tabs cannot be
adopted. Worker recreation reloads these cleanup-only IDs; it never reconstructs
a lease. If the popup reports unresolved debugger cleanup, retry Reconnect after
closing DevTools/cancelling the debugger, or close the affected task tab. A generic
detach rejection is not treated as success; another attached debugger may cause
conservative refusal. Legacy installations lacking this metadata quarantine their
old per-tab rule targets until cleanup rather than assuming they are safe.

## Human-only web VNC (Linux local X11)

The sign-in card, **Settings → Browser target → Connected Chrome web VNC…**, and
**Computer** open the shared viewer. The viewer resolves the agent's pinned
browser target, not just the current global setting. Opening the panel does not
start capture; its normal **Take control** action starts sharing.

**Current user direction supersedes the earlier consent-form design:** this is
the user's owned machine, so the deliberate authenticated **Take control** action
is sufficient authorization. There is no extra consent checkbox, approval dialog,
confirmation token or “approve whole desktop” step. The capture-scope and input-
cleanup descriptions are informational, not another permission gate. Settings
polling never starts a share.

**This captures and controls the entire existing X11 desktop, not only Chrome or
its authorized task tabs. Other windows, accounts, notifications and unrelated
private content may be visible and controllable.** Only the owning Jelly
control-session cookie can receive a viewer ticket. Other sessions cannot view,
control, recover or take over the private screen. No desktop pixels, OS clipboard
or file-transfer channel are exposed to models. Clipboard transfer is disabled
in x11vnc and there is no clipboard/file UI for this viewer. Native X11 input can
still operate ordinary desktop applications. Disconnect/handback cleanup releases
held keys and pointer buttons and can also release keys/buttons held on the
physical keyboard or mouse; do not hold physical inputs during cleanup.

Requirements:

- Chrome, native host and Jelly must run on the same Linux machine/OS user with
  an actual local **X11** session. The native host must inherit
  `XDG_SESSION_TYPE=x11`, local `DISPLAY=:N[.screen]`, and an absolute
  `XAUTHORITY` pointing to an owner-only authorization file (0600). These are
  checked against the native host's same-user direct Chrome browser parent using
  Linux `/proc` executable, command-line and environment evidence, never supplied
  by the model, extension or HTTP request. Browser and native host must agree on
  those environment values. A bounded same-executable descendant GPU/renderer
  must explicitly report the resolved `x11` Ozone backend. Unknown parent wrappers,
  missing/inaccessible process evidence, headless Chrome, conflicting/duplicate
  backend switches, backend environment overrides, auto/Wayland backend hints,
  noncanonical backend flags and **every `--display` / `-display` override**
  are unavailable. Chromium can flatten its command line and lose argument
  boundaries, so overrides are rejected rather than inferred—even a valid local
  override. Use Chrome's existing inherited X11 display; Jelly never relaunches
  it to change this. Missing authorization/display/backend is not guessed from
  HOME, Jelly's server environment or unrelated displays. The authorization must
  open that exact display, or sharing fails closed.
- **Wayland/XWayland, remote DISPLAY, macOS and Windows are unavailable** for web
  VNC. Local **Open in Chrome** remains available wherever Connected Chrome works;
  there is no automatic managed-browser or alternate-display fallback.
- Install `x11vnc`, `/usr/bin/python3` and `/usr/bin/flock` separately on this
  machine, with `libX11`, `libXtst` and `libXi` (XInput2). Input cleanup requires
  one enabled master pointer; multi-master/multiseat input is unavailable rather
  than guessed. x11vnc may be in `/usr/bin`, `/usr/local/bin`, or this instance's
  `runtime/usr/bin` (the existing desktop dependency bundle). No dependency is
  installed automatically and no normal signed-in profile is modified by tests.
  Reload/reconnect the unpacked extension after upgrading protocol versions.

Take control first reserves an exclusive, persisted instance-wide privacy latch.
All connected profiles freeze, drain observations/input and acknowledge confirmed
extension debugger detachment before x11vnc starts. New allocations, cached tools,
begins, resumes and new profile connections remain blocked for this instance;
Jelly desktop-provider work must also drain and stay excluded. Unrelated model
work may continue. x11vnc uses one 0600 Unix socket in a 0700 private runtime,
with both IPv4/IPv6 RFB TCP listeners disabled, `-norc`, `-nosel` and
`-clear_keys`. It never
launches Chrome/Xvfb, copies a profile, changes website zoom, resizes or focuses
Chrome. Tickets expire after 30 seconds, are single-use, owner/epoch/profile-
generation bound, and require the existing cookie/CSRF/origin controls. RFB
forwarding rechecks authority in both directions. The viewer fits the actual
framebuffer; the managed browser's fixed 1280×800 mobile crop is not applied.

**Return control**, or closing the owning panel (Escape/backdrop/swipe included),
drops old VNC sockets/input and confirms graceful process exit plus key/button
cleanup before unfreezing. A fixed bounded packaged X11 helper releases and
verifies held keyboard and XInput pointer-button state; it never reads typed
text, screenshots or clipboard contents. It binds only to the previously native-
attested display, authorization hash and X-server socket identity.
Only the selected current valid task may resume; all other tasks remain paused
and need their own explicit Resume. Idle/settled retained tasks need a new
browser run before Resume. Website sign-ins, the Chrome process/profile and
user tabs are preserved. A network disconnect stops x11vnc, clears held keys AND
buttons, and leaves the latch and tasks paused. **Reconnect desktop** explicitly
starts a fresh VNC process only after confirmed cleanup; it never replays input.
Unexpected process death or uncertain input cleanup requires **End failed share
without viewing**, which cannot resume the old task. After confirmed VNC/input
cleanup, this cleanup-only path freezes and checks every still-connected profile
generation, but does not demand acknowledgements from already-disconnected/lost
tasks. Lost tasks remain revoked and require ordinary Close/Reset before future
use; no old task resumes. A current peer's failed freeze acknowledgement still
keeps the privacy latch. Normal Take control/Reconnect never use this exception.
If the original display or
authorization binding changed, tools stay latched and operator repair is required;
no unrelated/reused display is guessed. Failed handback keeps
the panel open with a retryable error. Detach failure, profile loss, privacy-
exclusion loss and stale requests never create a human-safe state or silently
resume automation. If cleanup is uncertain, tools stay blocked and operator
repair may be required; do not enter credentials after a failed transition.

The latch survives a Jelly restart and control-cookie expiry. An orphaned share
has **no viewing or takeover path**. A fresh authenticated session may explicitly
choose **End orphaned desktop share without viewing**. Cleanup proves the old
VNC process has ended using the parent-death child shim and an inherited
private lock, never by killing a saved/reused numeric PID. The fixed cleanup
helper then verifies/releases held keys/buttons against the original persisted
native display binding. A changed X-server socket or authorization refuses
cleanup rather than touching another desktop. If either proof fails, the
latch remains. Successful orphan cleanup cannot restore old tabs, task authority
or auto-resume an old run; future connections require normal fresh authorization.
Owner expiry does not bypass freeze acknowledgement: cleanup must confirm every
currently connected peer before reopening automation admission. A restart with no
connected peers can complete without restoring any old authority.
It does not reset or close the user's real Chrome. Do not delete the latch or
runtime to bypass a failed cleanup check.

This privacy barrier governs Jelly-provided Connected Chrome and desktop-provider
authority **in this instance**. It is not isolation from unrestricted same-user
shell/filesystem access, unrelated X clients, other applications or other Jelly
instances. It cannot prevent OS actions available through the shared desktop.
No real personal desktop or remote device is claimed verified.

## Optional owned virtual-X11 desktop — existing profile, extension-only automation

This is a **separate, explicit owner installation**, not native Wayland capture
or a managed-browser fallback. An independent user service runs a private Xvfb
and standard Openbox window manager plus ordinary headed Chrome using the
**existing selected user-data root/profile in place**. No profile is copied;
there is no Playwright, CDP/debugging port or AgentBrowser controller attached to
this Chrome. Browser automation still uses only Jelly's extension/native host.
The existing GNOME/Wayland session is unchanged. Existing unowned-X11 admission
and managed desktop paths remain separate.

The display, window manager and Chrome persist across viewer close and Jelly
server restart. Only the disposable VNC/input and optional OS-auth helper belong
to the share. The service does not automatically restart on failure. Its private
instance/config hash, generation, runner/X-server/window-manager/Chrome
PID/start/executable identities, exact Chrome root/profile/X11 arguments,
SingletonLock owner, X socket identity and authorization hash are rechecked.
Setup pins the canonical same-user nonsymlink root **and profile directory** by
device/inode (not directory ctime). Every launch and runtime check revalidates
both. Missing, substituted or symlinked directories refuse rather than letting
Chrome silently create another profile. Legitimate directory contents can change.
A native-host hello for this route must match the launcher's **exact direct
Chrome parent** and inherited X display/authorization. It does not waive the
legacy descendant-process attestation for arbitrary existing browsers. A changed
or unavailable binding refuses sharing/handback; no saved numeric PID is used to
kill a replacement process.

### Owner setup and controlled relaunch (not performed by tests/agents)

Install Xvfb, Openbox, x11vnc, GTK4/Python GI and the X11 cleanup dependencies
above separately. Openbox is required for normal focus between Chrome and OS
authentication windows; bare Xvfb is not sufficient for that workflow. Setup
neither installs packages nor starts/enables/stops any unit. Start Jelly once to
create its private bridge, and keep the native host installed for the exact
existing Chrome root. Build/reload the extension for protocol **v6**.

```sh
bun run chrome:setup-desktop --data-dir /absolute/jelly/data \
  --chrome-root /absolute/existing/chrome-user-data --profile Default
```

If login-keyring authentication is actually needed, add
`--keyring-control /verified/same-session/keyring/control` and
`--bus unix:path=/verified/same-session/bus`. These are **owner-selected metadata
paths**, never HTTP/model parameters or credentials. Do not guess another user's
session. A direct foreground socket must attest to the same live same-UID
Secret-Service daemon. Socket-activated/protected daemons use the distinct v2
proof below; a same-UID socket peer is not sufficient. Without this option no
auth helper is started.
Optional owner-only CLI paths select the Chrome/Openbox executable, HOME and
unit directory; public requests cannot change these. No password/grant is stored
in the new unit/config/desktop identity manifest.

Setup finishes validation/attestation before installation writes, stages its
known files, and rolls back only its own inode-checked artifacts on failure.
Failed attestation can be retried without a stuck empty directory; unknown
existing artifacts are never removed. It writes a 0600 private config/launcher and creates
`jelly-owned-chrome-<instance-id-without-dashes>.service` in the user unit directory.
It refuses overwriting an existing installation. **Parent/operator alone** should
validate the exact old setup unit, executable/root/profile, PID/start and exclusive
profile ownership; save unsaved work before a controlled close and relaunch.
For this owner's separately recorded setup, the only eligible old unit is
`jelly-connected-chrome-1792238225.service`; this stage did not query, stop or
restart it. Before a parent-controlled close, the owner CLI can explicitly record
`--previous-pid PID --previous-unit EXACT.service --previous-invocation HEX_ID`.
This is **read-only predecessor-only** proof, never a unit operation or general
automation fallback: expected exact unit/Invocation, MainPID/ExecStart PID,
cgroup, executable/start and typed switches must match. Explicit root/profile
mismatches and unsafe single/double-dash aliases still reject; flattened `/proc`
commands supply denials/counts, not guessed values. When Chrome erases its initial
HOME/environment, selected-root ownership instead requires its exact same-host
SingletonLock, unchanged artifact identities, and the exact **LISTENING kernel
Unix inode** owned by that main PID. This kernel inode is not the filesystem
socket inode; both and the pinned directories are checked separately before/after.
No cookie target/content or protected memory is read. Raw argv/environment is
never output or persisted.
This proves root ownership, not sole use of one profile's windows or preservation
of unsaved work. Parent must freshly recheck expected metadata/listener immediately
before any exact-unit stop; unknown or changed evidence remains a blocker.

Never close unrelated Chrome or manually delete profile locks. Duplicate runners,
unknown/different-host/live/reused owners or changed Singleton metadata refuse.
Only unchanged artifacts of a previously recorded owned browser, with its exact
same-host lock PID and conclusively absent original PID(s), may be left for
**native Chrome itself** to retire normally. Chrome starts without a URL using
`--no-startup-window`; the fixed popup URI is requested only after new direct-child,
profile and display ownership is verified, then rechecked. Forwarded/exited or
mismatched launches acquire no authority; no arbitrary startup URL is replayed.

After review and deliberate authorization, the operator can daemon-reload and
start the **printed new unit**; enabling it at login/boot is another explicit
operator choice. Relaunch can lose unsaved forms/tabs/download state, and normal
Chrome changes to the existing profile persist. Session restoration is not an
unsaved-state guarantee. This is not a command to restart the user's general
Chrome session or the OS compositor.

### Pre-pair private entry and handback

Open **Settings → Browser target → Connected Chrome web VNC…**. The installed
owned desktop can offer **Take control with zero paired profiles**, independently
of the current managed-browser selection. No capture starts on polling/opening.
Take itself authorizes the operation—no extra checkbox. If a selected profile
and the installed owned desktop both exist, the informational **Desktop source**
selector explicitly identifies the target; unavailable selected-profile Take
stays disabled until a different available source is explicitly chosen. The
label, enabled state and request route always match; there is no silent switch.
Cookie/CSRF/origin,
owner/generation tickets, one viewer, Unix-only RFB, all-Connected-Chrome and
native-desktop freeze/drain, no model pixels/input, and no clipboard/file export
remain the existing share boundary.

When configured and locked, a small native GTK password entry appears **inside
that owned private X11 desktop only**, never in a transcript/web form. The human
enters the OS login-keyring password there, not in chat. It sends only the
existing daemon's standard password-checked login UNLOCK operation, with no item
access, generic control operations, password changes, custom decryption or
password-store weakening. The canonical login collection must already exist.
Wrong passwords remain locked; already-unlocked keyrings request no password.
The direct v1 binding checks daemon PID/start/executable, SO_PEERCRED/control
socket and Secret-Service unique owner. The separate **systemd-socket v2** binding
requires an authenticated same-user manager owner/PID/start, active exact
`gnome-keyring-daemon.socket` Stream Listen endpoint, socket→service and reverse
unit relationships, socket/service InvocationIDs, trusted root-owned service
Exec identity/MainPID/ExecPID/cgroup/start and matching Secret-Service PID/UID/owner.
The peer must be that recorded manager, not merely another same-user process.
If a user-manager reload has cleared the per-command ExecStart PID, an active
simple service additionally needs readable live executable/file identity matching
the trusted service binary, and that same MainPID must own the exact inherited
kernel listener. Unreadable executable metadata, a missing listener or another
recorded PID refuses authentication; this is not a same-user fallback.
Service and D-Bus owner must already be active **before Unix connect**; no
Start/activation is requested. Kernel endpoint and generations are rechecked
before/after native auth and at handback, including after delayed unfreeze ACKs.
The protected path uses process stamps plus trusted unit Exec metadata, never
protected memory/environ, dumpability changes or elevation. GTK's live watcher
and exact boundary checks perform full proofs; RFB chunks use cached attestation
with cheap PID/start/endpoint checks, never a full helper fork per chunk.
Credentials are not
arguments, environment, manifests, files, stdout, history or clipboard exports.

The qualified installed daemon is GNOME Keyring **50.0**. Its `--start --unlock`
flags are explicitly incompatible, and standalone `--unlock` does not invoke the
already-running daemon; the helper therefore implements only the native fixed
UNLOCK framing used by its existing control client. A missing/different daemon,
collection or ambiguous response refuses; no authentication is replayed. This
qualifies login-keyring authentication, not arbitrary OS/portal prompts on the
original GNOME desktop.

Click **Connect** once in Chrome's extension popup. An owned connection can stay
authenticated but **unpublished**, with no instance/RPC/task/lease authority,
until verified handback. It must acknowledge debugger cleanup; a missing/refused
pending-peer acknowledgement cannot publish it or bypass the privacy latch.
Return control first closes viewer admission, drains/stops the auth helper,
confirms helper/VNC process and input cleanup, verifies the daemon/owned display
binding and current peer acknowledgements, then publishes pending connections
and reopens automation admission without replay. Monotonic deferred-admission,
failure and share/owner/generation epochs fence every async handback boundary;
an admitted-then-dropped peer cannot disappear from a list and erase failure.
Failed/closed/revoked stopping transitions retain the durable latch. No old task
resumes implicitly.

Network/owner loss stays private. Normal shutdown uses a queued GTK main-context
stop, allowing an already-admitted bounded native unlock to finish before helper
exit. Unknown auth outcome or forced helper death remains durably latched for
operator repair. A hard Jelly crash with a surviving auth cleanup obligation is
also conservatively latched, not guessed safe. An orderly interrupted share can
use cleanup-only orphan handback without viewing; it preserves the owned display,
Chrome profile and process. Do not delete the latch/runtime to bypass refusal.

### Owned-X11 qualification and limits

`bun run test:chrome-owned-vnc` builds and runs actual noVNC/ordinary headed
**Chrome for Testing** against only a temporary existing profile, private
activation-free D-Bus and private GNOME Keyring. Playwright controls the disposable
viewer UI only, never this headed Chrome. The fixture uses the installed
root-owned Chrome sandbox helper, not `--no-sandbox`. Openbox must be installed;
fixture-only `JELLY_FIXTURE_OPENBOX`, `JELLY_FIXTURE_WM_LIBRARY` and
`JELLY_FIXTURE_WM_DATA` can select an extracted temporary package without a host
install. No package is installed automatically. `bun run test:chrome-os-auth`
separately exercises wrong/correct synthetic passwords and identity refusal.

The real fixture covers zero-profile Take, native GTK authentication through VNC,
explicit deferred pairing, held-input/helper/socket/process cleanup, native
extension navigation with a synthetic retained cookie, owned Chrome/Xvfb
persistence across Jelly restart, controlled owned-stale stop/relaunch with the
same disk cookie/extension profile ID but new owned/connection generations,
cleanup-only orphan recovery, conflicting lock/runner refusal, and private daemon
loss retaining the latch. No Chrome lock is manually removed. Unit/client tests cover unpublished/no-RPC authority,
missing pending ACK, owner expiry, CSRF/origin/arbitrary-path refusal and no web
password form. No actual owner's normal profile, real keyring, systemd unit,
personal desktop, remote device or live activation was used or claimed verified.
Stable Chrome is the production default but the extension-loading end-to-end
fixture uses Chrome for Testing; actual normal-profile activation remains a
separate parent/operator review and validation step.

**Actual first migration remains unqualified:** disposable owned-record stale
recovery now passes after SIGTERM leaves all three Singleton artifacts and every
original owned PID disappears. Synthetic cookie metadata is observed committed
before stop; the reopened ordinary browser then sends that cookie. The new
read-only initial-unit attestor now also proves an actual private Chrome's
selected-root kernel listener with erased/flattened initial environment and
synthetic unit metadata. No host unit query or real-profile action was performed.
The auth fixture covers both foreground and genuinely inherited listener modes
with private D-Bus/systemd metadata simulation, including protected-exe refusal
simulation, wrong/correct native passwords, changed generations and inactive
service refusal **before any control connect**. Parent must still qualify actual
metadata on the exact recorded setup unit and active keyring socket/service
before any migration/authentication; private simulations are not host acceptance.

Latest independent-review-fix checks: owned native/noVNC/private-auth fixture
exit **0** (230 s bound), twice through the full workflow: v1 direct and v2
inherited-listener bindings, including positive owned-stale disk reopen and the
actual erased-environ predecessor listener test. Standalone private OS-auth exits
**0** (45 s); targeted bridge/share/native/API/client/owned tests **62 pass, 0 fail**
(130 s, plus eight synthetic unit-data cases inside a test); existing X11/noVNC
exits **0** (190 s); managed viewport exits **0** (120 s); TypeScript exits **0**;
`check:full` exits **0** (600 s), **594 tests pass plus both builds**.

The separate optional managed `test:desktop` remains failing: latest bounded
isolated run exits **1**, **4 pass, 2 fail** (AgentBrowser action rejection and
login-persistence 30000ms timeout). Earlier runs also had spawn/Xvfb failures.
These are unresolved; this is not an all-green managed-suite claim, and no
managed controller/test code was changed to hide them. Optional noVNC/auth suites
are not part of `check:full` and were actually run separately. Two intermediate
review-fix runs safely refused handback while the stricter fences exposed an old
viewer-disconnect status overwrite and missing restored-orphan provider lease;
both now have deterministic regressions and the final real fixtures pass.
No new native-Wayland experiments were run in this follow-up.

## GNOME Wayland qualification — not enabled

The existing X11 backend above does **not** capture a GNOME Wayland desktop.
An inherited XWayland `DISPLAY` is not evidence of native desktop ownership;
Jelly does not use it as a fallback, restart Chrome, move/copy its profile, switch
sessions, or enable a remote-debugging port. Managed-browser VNC is a different
desktop and cannot unlock the existing profile's OS keyring.

An isolated GNOME Shell/Mutter **50.1** qualification fixture now exercises the
real same-user `org.gnome.Mutter.RemoteDesktop` and associated `ScreenCast`
`RecordArea` APIs, private PipeWire, bounded in-memory frames, and native
keyboard/pointer events in a disposable GTK window. Its target is the compositor
it just spawned, checked against both D-Bus unique owners/PIDs/UIDs and Wayland
socket peer credentials. The compositor starts with **zero monitors**. A separate
standalone fixed-mode `RecordVirtual` session creates its fixture-owned monitor
without an input session or PipeWire consumer; human `RecordArea`/input objects
are separate. The monitor survives human-session teardown and explicit provider
Stop removes only its own monitor, returning to zero. This happens **only in the
disposable fixture**, never on the host. It has no production route, viewer,
RFB listener, clipboard/file channel, or model image/input interface.

**Capture and native input work in that fixture; secure handback is not yet
qualified, so production GNOME Wayland web control remains unavailable.** A
fixture-only native-dispatch delay proves that release-method acknowledgements,
`Stop`, `Closed`, and session-object removal can all precede actual Shift and
pointer-button releases. Process exit or a delay is not a replacement for input
drain. A real already-selected capture-idle query can sample a new native cursor
position while compositor events are still pending: a single full frame/marker is
not a consumer drain proof. A second distinct fresh full-frame roundtrip, with
capture-consumer reconnect to the **same** PipeWire stream, passes in the fixture,
including a static desktop (no animation required). However, DEFAULT-priority
backend handling queues events into a **separate Clutter stage queue**. It is not
yet proven that the returned second buffer requires a new stage paint after that
queue drains, rather than previously queued producer work. Neither passing
fixture observations nor cursor pixels qualify this causal gap.

Independent source review also rejects two shortcuts: `RecordMonitor` can use a
detached full-frame idle capture, so fresh full-buffer metadata does not identify
a post-drain paint; and an owned Wayland client's delivered pointer witness can
precede older Shell/grab/panel events in the separate stage queue. Neither alone
is a stage-consumer fence. Constructing a **new capture stream only after a
causally established native-release marker** is a distinct, unimplemented avenue,
not a qualified protocol. Reconnecting the fixture's consumer only confirms its
local GStreamer NULL state, not an acknowledged producer disable/re-enable or
frame-clock identity. Passing this diagnostic must not enable production Take,
handback, reconnect or deferred Chrome pairing on Wayland.

Fixed English (UK) EVDEV tests verify actual compositor keymap/a11y guards,
reference-counted Shift, repeat deduplication and exact-code releases after a
layout change. Unsupported symbols or changed configuration permanently reject
subsequent input, including Enter. These are qualification helpers, not enabled
production input support.

**The unresolved blocker is normal handback, not optional orphan recovery.**
Normal-only support is acceptable once sound; unknown cleanup must remain latched
for operator repair, without clearing reconnect/resume/cleanup actions or an
automatic compositor restart. No native-Wayland backend or native-Wayland pre-pair UI/Connect publication
is enabled; the optional owned-X11 route above is separate. A future reviewed Take may provision an owner-scoped monitor only in
the same verified compositor when there is no existing area, retaining a
monitor-only provider after fully revoking human streams/input. It must not
reconfigure physical displays, restart Chrome, or touch another session. Take
itself is the authorization; no extra consent checkbox is intended.

Run the opt-in diagnostic (it requires no sudo and never uses a personal Chrome
profile or the active desktop):

```sh
bun run test:chrome-wayland-qualification
```

Installed dependencies used: `gnome-shell` 50.1 with Mutter 50.1, `pipewire`,
`wireplumber` (policy-only profile, no hardware monitors), `gstreamer1.0-pipewire`,
`python3-gi`, `python3-gst-1.0`, `gir1.2-gst-plugins-base-1.0`,
`gir1.2-gtk-4.0`, `dbus`, `gcc`, `pkgconf`, and `libglib2.0-dev`. The harness
clears the environment, uses temporary HOME/config/data/runtime directories and
an activation-free private D-Bus for both session/system lookups, and requests
software rendering. It never connects to the real session/system bus, display,
PipeWire socket, secret service, or physical input seat. Its compiled input-delay
shim is temporary and loaded **only** into its new headless compositor. Frames
are checked in memory; output contains only fixture booleans/metadata, never
screenshots or typed text. A passing diagnostic explicitly reports
`production_cleanup_qualified: false`; it is not a deployment qualification.

### Existing Chrome and the private OS keyring

A locked OS keyring can prevent the already-running normal Chrome profile from
finishing initialization/pairing. The human must unlock it in the **existing
native desktop's OS dialog**, not a Jelly chat/transcript form, then explicitly
Connect the extension. Never send a keyring password in chat. Jelly does not
read/decrypt/unlock keystores, type chat credentials, suppress mandatory OS
permission prompts, or change Chrome's password-store/security settings. The
isolated fixture encountered no interactive permission prompt; that says nothing
about the real desktop's OS policy. Any prompt there must be handled privately
by its owner. The owned-X11 option above provides a separate route for the
existing profile and attested login-keyring daemon, not capture of those existing
GNOME/Wayland dialogs. Actual owner setup/relaunch/authentication remains private
operator work after review; tests never perform it.

## Security boundary and remaining rollout gates

Protocol v7 has schema-validated methods/identities, explicit pinned site-access mode, pairing grant, extension ID,
instance/profile/connection generation binding, bounded pending requests and event
rates. Pause progress/failure/acknowledgement events also bind to the current run.
Older protocol versions are rejected: reload the unpacked extension when idle
after updating Jelly, then reconnect explicitly; no old capability is restored.
Native frames use a 32-bit little-endian length (supported Linux machines
are LE) with a **768 KiB** ceiling, below Chrome's 1 MiB limit; PNG base64 is capped
at **650,000 characters**. Slow readers time out; no mutation is retried. There is
no artifact chunking. Native stdout is frames only; diagnostics omit grants/page
content. Owner-only sockets/configuration are an OS-user boundary, not a sandbox
against unrestricted same-user shell/filesystem access.

Permissions: nativeMessaging, debugger, tabs, tabGroups, storage, scripting,
webNavigation, declarativeNetRequest, HTTP and HTTPS hosts. Packaged isolated-world scripts
and document/lease/site checks implement observations/input, including OOPIFs;
CDP is internal for debugger lifecycle/screenshots. There are no page/content-
script control RPCs, arbitrary eval/CDP tools, cookie/password/autofill/browser-
storage reads, history/bookmarks tools or network response bodies.

Agent tab DNR restrictions are installed before first navigation. Approved-site
mode blocks unapproved main documents, redirects and subresources; unrestricted
mode blocks known local/private and Jelly/control destinations across those
request types. This is **not managed
SOCKS egress isolation**. Outstanding signed-in rollout risks include:

- Pre-notification popup traffic and service-worker/background requests without
  tab association; DNS rebinding/public aliases and sensitive control endpoints.
- Transient render/secret-field races during screenshots, unusual embedded
  documents and every debugger attach/takeover interleaving. Stable author shadow
  roots now fail closed, including closed roots; this does not prove atomic capture.
  Pre/post guards and drain barriers reduce risk but are not a proof against
  hostile pages rendering secrets between samples.
- Live tab replacement/prerender activation and full browser/server restart
  matrix (the headed suite exercises actual worker-target termination/reconnect
  and native bridge listener restart, not every application/update/restart mode). Automatic Chrome suspension with a native port
  is browser-version dependent.
- Child browser identities: **unavailable**, not parent tools. Full Pi SDK and
  extension docs and pi-subagents child launch boundary were inspected. Detached
  children load allowlisted providers in another process; parent's customTools
  are not a safe provisioning channel. A reviewed authenticated per-child IPC
  adapter with lifecycle revocation is still needed. All **persistent Jelly
  agents** share the global choice; this does not silently grant subagents access.

Separate deferred work: reviewed upload/download artifact protocol and chunking,
remote authenticated transport, side-panel chat/cursor overlays, automatic
updates, Windows installation and public Web Store distribution/signing.
No normal-profile cookie/login settings are changed. No claim is made that this
extension prevents every site-initiated download.

## Validation

### Earlier independent-review rerun (diagnostic-only Wayland delta)

This subsection records the earlier diagnostic lane; the later owned-X11
implementation and its separate qualification are described above.

All commands below were actually run with external time bounds; none restarted
Jelly or accessed the personal desktop/profile. The review found no actionable
defect in the retained diagnostic delta. No production Wayland integration or
new handback workaround was added, and no new regression was needed for a review
fix. The existing real input-delay, mapping-change and teardown regressions were
rerun rather than treating their observations as a production certificate.

| Command | Bound | Actual result |
| --- | --- | --- |
| `bun run test:chrome-wayland-qualification` | 90 s | Exit 0; synthetic native capture/input and monitor lifecycle assertions pass; `second_frame_proves_stage_consumer_drain: false`, `production_cleanup_qualified: false`. |
| `bun run test:chrome-vnc` | 180 s | Exit 0; actual disposable two-display X11 refusal and noVNC capture/input/private-control/cleanup assertions pass; fixture browsers, VNC processes, X servers and HTTP listener revoked. |
| `bun run test:desktop` | 240 s | Exit 1; 4 pass, 2 fail. VNC/private-handoff regression fails with redacted `AgentBrowser action failed`; login persistence times out at its internal 30000 ms limit. These previously reported managed failures remain unresolved. |
| `bun run test:computer-viewport` | 120 s | Exit 0; actual managed noVNC mobile panning/pointer mapping, landscape/desktop fit and handback assertions pass. |
| `bun run check` | 120 s | Exit 0; TypeScript passes. |
| `bun run check:full` | 600 s | Exit 0; 578 tests pass, 0 fail, plus client and extension builds. |

**`check:full` does not include the optional `test:desktop`, native Wayland,
Chrome noVNC or managed viewport commands above.** Its passing managed API/browser
coverage does not erase the two standalone managed failures. There is still no native-Wayland RFB/viewer path to test, no host-compositor/
PipeWire attestation or native-Wayland pre-pair bootstrap, and no qualified
native-Wayland process-death/restart fencing. These are this-host
fixtures only: production Wayland control remains blocked and no personal-desktop
or remote-device acceptance or activation is claimed.

The VNC fixture verifies OS process and listener revocation before reporting
successful completion. Its test-only teardown bounds Playwright shutdown and may
terminate only the original disposable Chrome PID after rechecking process start
time, user, executable and temporary profile. This is not production behavior:
Connected Chrome handback never closes or terminates the user's Chrome. After
all assertions and cleanup proofs pass, the fixture exits explicitly to avoid
Bun retaining phantom Playwright/WebSocket handles.

`bun run check` runs TypeScript only. `bun run check:full` runs TypeScript,
server/client/managed regressions and both builds before deployment.
`bun run test:chrome` runs protocol/native/API/share-latch tests and real **headed Chrome for
Testing** via extension → native host → private socket. It uses only temporary
profiles, temporary host installs and local fixture sites. Playwright's private
pipe provides fixture/human inspection and worker termination, not Jelly browser
actions. `JELLY_EXTENSION_BROWSER_PATH` can select a compatible executable;
Xvfb or DISPLAY is required on Linux; macOS uses its normal headed display.
Disposable fixtures use production address policy; no local-address bypass is compiled.

`bun run test:chrome-vnc` builds the client and exercises disposable authenticated
Xvfb + existing headed Chrome + native host + x11vnc + actual noVNC. It verifies
two-display regressions (Chrome on `--display=:B` or `-display=:B` while inheriting
`DISPLAY=:A` refuses capture of either desktop), normal same-display native attestation,
direct Take control without an extra approval step, real desktop pixels/pointer/keyboard input, all-task
blocking, private owner exclusion, no RFB TCP listeners/clipboard export, actual
framebuffer fit on mobile, disconnect/reconnect, failed Escape handback, stale
generations, process loss, held Shift AND mouse-button cleanup after abrupt
WebSocket loss and unexpected kill, confirmed input cleanup before reconnect or
selected-task resume, and
unchanged Chrome PID/profile/cookies. A real killed-parent fixture verifies the
inherited cleanup lock refuses a live process and permits cleanup-only orphan
handback after parent death, including refusal when the old authorization binding
has changed. It requires the local Linux desktop dependencies
plus Chrome for Testing and xclip; it never uses a personal profile or restarts
Jelly. `bun run test:computer-viewport` separately checks the managed VNC/mobile
behavior. These this-host fixtures do not replace personal-desktop or real
phone/Tailscale/HTTPS-device validation.

The live suite covers simultaneous agents and profiles/instances, foreign tab
and reference rejection, rejected personal-tab grants preserving groups, group deletion,
exact fill/click/select/key, bounded waits, native PNG, same-process and verified
OOPIF actions, secret fields in child frames, popup adoption, retained handoff
across runs, stale run rejection, zero-hit denied redirect destination, human
closure, local pause racing real queued renderer observations/screenshots/fill/
click, native version mismatch, worker termination/reconnect, native bridge
restart, stale generations, cleanup and disconnect. Closed-root secret, nonempty
and contenteditable fields are real-extension rejection regressions, including
closed secret/nonempty fields in an independently verified OOPIF. A drain test
holds delivery of real capture/fill API responses in the disposable worker with
an already-attached extension debugger: pause cannot acknowledge until released,
revoked results are suppressed, and the extension can no longer issue debugger
commands after acknowledgement. That deterministic response-delivery hold is not
a claim that admitted mutations had no side effects or that capture is atomic.
Unit/client tests additionally cover delayed open/mark/pause acknowledgement,
private-control gating, distinct failed/disconnected states, global persistence/pinning,
retained handoff routing, unsupported child identity, framing/slow peers,
installer preservation, tool-image content and handoff/settings UI. See the plan
matrix for what remains unverified; no synthetic event is presented as a real
browser replacement or signed-in-profile test.

## Uninstall and activation

Stop agent runs, disconnect locally, then use the same explicit instance/root:

```sh
bun run chrome:install-host --data-dir /absolute/jelly/data \
  --chrome-config /absolute/chrome-user-data --uninstall
```

Remove Jelly's unpacked extension in Chrome. Only this instance's native
manifest/wrapper/config/ID registration is removed; unrelated hosts, profiles,
sign-ins and Jelly data remain. Existing live native connections require explicit
disconnect (or later normal shutdown) to revoke immediately.

Activating server changes is separate from installation/global opt-in. The parent
operator should review the remaining gates, then use `AGENTS.md`'s queued idle
restart, respecting all restart holds, and verify loopback/Tailscale afterward.
Do not restart Jelly inline from an agent run. Tests do not perform activation.

### Closed owned Chrome after completed share cleanup

Closing Chrome can stop its owned X11 service/display. It is not automatically
restarted. If capture and input cleanup already completed (`runtime: null`,
`inputCleanupRequired: false`) and authentication has a known completed outcome
(`authUncertain: false`), **End failed share without viewing** can retire the
remaining latch even after that original Chrome/display has gone. This also
works for a restored clean orphan. Ordinary Return control and Reconnect still
require the original live desktop; this exception grants no viewing authority.

Recovery requires explicit persisted completion fields, no outstanding helper
or transition, and the original private installation/configuration, generation
and display-binding record. Missing/malformed evidence, replaced configuration
or record, unresolved input, or uncertain authentication remain blocked for
operator repair. It never replays input or authentication, guesses a native
outcome, or touches a replacement display. Private same-user files are the trust
boundary, not protection against a malicious process rewriting files as that
same OS user. Current peers must freshly acknowledge cleanup; owner/privacy and
bridge-generation checks still apply, deferred peers cannot bypass admission,
and lost tasks are not resumed.

After reviewed code activation, first explicitly finish cleanup without viewing.
Do not delete the latch or restart owned Chrome first: the launcher refuses an
existing share latch before replacing its binding. Only after successful latch
retirement should the owner explicitly start the owned service, then Take control
and Connect as needed. Closing Chrome before cleanup finishes may still require
operator repair; dead-display input or unknown authentication is not waived.

### Owned X11 native file picker routing

Owned Chrome now requires `/usr/bin/xdg-dbus-proxy` in addition to its existing
Xvfb/Openbox dependencies. Only that browser receives a private, per-generation
filtered bus endpoint. The allowlist is exactly `org.freedesktop.secrets`: normal
Secret Service calls, unique-owner calls, replies and signals remain available;
the shared desktop portal is invisible. Chrome therefore uses its standard GTK
file chooser on the owned X11 display (including **Load unpacked**). There is no
automatic directory selection, extension-loading flag, password-store override,
profile copying or shared portal/environment reconfiguration.

This is intentionally **not** a transparent session-bus proxy. Other desktop bus
integrations (including portal-mediated open/save/screen sharing, notifications,
and unrelated desktop services) are unavailable to this owned browser. Native
Wayland is unchanged. Authentication attestation still targets the original
configured bus and exact original keyring daemon; the proxy is not a new keyring.
The proxy PID/start/executable and private socket identity/permissions are checked
at admission and monitored by the independent launcher. Loss/replacement stops the
owned tree rather than reconnecting through the shared portal. Reverse shutdown
removes only the recorded private socket and its exact empty generation directory.

Existing config files require no migration. Old desktop records remain valid
cleanup/stale-owner evidence, but cannot authorize live viewing after this update
until the owner explicitly relaunches the owned service with fresh proxy proof.
Finish/retire any existing share using the normal cleanup flow first; never delete
a latch or Chrome lock to force the transition. Deployment must coordinate that
owned-service relaunch with Jelly activation. No service is restarted by setup.

Disposable qualification (never run against an owner's browser/bus/profile):

```sh
JELLY_AUTH_PICKER_FIXTURE=1 /usr/bin/python3 tests/connected-chrome-os-auth.py
bun tests/owned-chrome-desktop.ts
bun test --timeout 30000 tests/owned-chrome-desktop.test.ts
bun run check
```

The picker fixture uses installed stable Chrome, two temporary X11 displays, a
private original-session bus/keyring and synthetic portal owner. It verifies native
chooser placement, cancel and synthetic extension selection, Secret Service unique
owner/signal routing, synthetic Safe Storage creation, cookie persistence, and
proxy identity loss. Test-only CDP/keyboard input never reaches a live profile.
The separate owned noVNC fixture verifies private authentication, handback, proxy
loss/shutdown/relaunch and already-clean close recovery. Actual remote-device/live
picker operation still requires the owner's private VNC check after deployment.
The activation-free fixture tests forwarding/rejection of activation requests, not
starting a real user's inactive keyring.

References: Chromium's
[`SelectFileDialogLinuxPortal::OnPortalAvailable`](https://chromium.googlesource.com/chromium/src/+/main/ui/shell_dialogs/select_file_dialog_linux_portal.cc)
falls back to the Linux UI chooser when the portal is unavailable; its
[`FreedesktopSecretKeyProvider`](https://chromium.googlesource.com/chromium/src/+/main/components/os_crypt/async/browser/freedesktop_secret_key_provider.cc)
uses `org.freedesktop.secrets` (including the OTHER desktop case). See
[`xdg-dbus-proxy` policy documentation](https://github.com/flatpak/xdg-dbus-proxy/blob/main/xdg-dbus-proxy.xml)
for TALK's unique-owner, signal and activation semantics. These upstream sources
are explanatory, not a substitute for the installed-browser fixture.
