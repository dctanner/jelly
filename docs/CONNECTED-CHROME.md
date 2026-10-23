# Connected Chrome — shared-profile local implementation

**Connected Chrome is Jelly's only browser integration.** Choose one explicitly
connected profile and site access **globally for every persistent Jelly agent**.
Agents use separate task groups and exclusive tab capabilities but share that
profile's cookies and signed-in accounts. Managed Chromium controllers, private
managed profiles and SOCKS egress have been removed. Computer control is the human’s remote full-desktop viewer, not a browser backend. Existing
Connected Chrome sessions remain pinned until explicitly closed; legacy managed
profile directories are left untouched and are no longer used.

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
   the popup. The popup shows Connecting, Connected, or a
   bounded safe failure category. Unavailable hosts retry using MV3 alarms (30 seconds
   up to five minutes between attempts). **Disconnect** persists across browser restarts;
   only **Reconnect to installed Jelly instance** clears it. Legacy `#connect` URLs
   only open status and never override Disconnect. Server-side Disconnect also records
   a durable profile block, cleared only by an authenticated explicit Reconnect.
   Failed task settlement conservatively requires the same explicit reconnect.
   Upgrade the backend, native host and extension together (extension 0.4.0/protocol 8).
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
5. In **Settings → Connected Chrome**, choose the exact connected profile, then
   **Save Chrome profile**. This is a global setting, not per-agent setup. Every
   persistent agent's next unpinned browser session uses it.

   All websites are accessible by default, including public and local/private
   services reachable from this machine, redirects, assets, frames and WebSocket
   resources, using the profile's signed-in accounts. There is no allowed-sites
   list or site-access mode; old saved site restrictions are ignored and dropped
   when settings are saved. Other websites' subresources may reach local services
   intentionally. This is not a network sandbox. Credentials in navigation URLs,
   non-web navigation and Jelly's exact control origins (including equivalent
   WebSocket endpoints) remain blocked; other ports on the same host remain
   available. DNS aliases are not an isolation boundary, and same-origin/CSRF
   protections do not prevent all cross-site side effects. A disconnected selected
   profile never falls back to another profile or managed browser. Already
   allocated sessions keep their profile; stop the agent and use **agent menu →
   Computer control → Advanced → Close session** to change it.

No Chrome restart, remote-debugging port, profile copy or cookie migration is
needed. Browser-on-laptop/Jelly-on-server needs a separate authenticated remote
transport; local native messaging cannot bridge machines.

## Tasks, tools and user tabs

- `browser_name_task` gives groups a short task label:
  `🔎 Jelly · Agent · Task`. Agent colors are stable; groups are per task/window.
  New task tabs are background tabs. Use Computer control to select a tab on the
  remote computer. Human regrouping/group deletion never transfers a lease.
- `browser_open`, `browser_tabs`, `browser_snapshot`, `browser_screenshot`, exact
  `browser_click`/`browser_fill`, bounded `browser_scroll`, `browser_select`,
  referenced `browser_key` and `browser_wait_for` are supported. Keys are semantic
  button activation or element-scoped key events, not OS/global shortcuts or
  trusted general keyboard emulation. Select takes an option value; snapshots
  do not expose selected form values. Waits support bounded visible text,
  untruncated text absence, or DOM readiness, never arbitrary evaluation.
- Snapshots combine bounded visible text and exact references from authorized
  same-process and cross-site/OOPIF documents. References bind to connection,
  session, tab, document and observation epochs. Frame origins need no site grant;
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
- Each agent automatically controls its own Jelly-created task tabs and groups on
  any website. No individual tab-grant workflow exists. Personal tabs and
  other agents’ tabs cannot be claimed, even by hidden popup RPCs. Group membership is
  organization, not authority; reconnect never reclaims stale groups, tabs or capabilities.
- Popups are adopted only from an exclusively leased opener during an authorized
  run, after installing policy and checking the destination. Adopted popups get
  fresh capabilities and task groups; protected-destination/failed popup adoption pauses the
  task and does not disclose its content. **Chrome can start popup networking
  before its creation notification**; see the rollout gate below.

## Human use, sign-in and settlement

Human computer control is **advisory**, not an automation permission latch.
Browser results (including screenshot context) report `humanUsing`. A human may
be signing in or using the computer, but agents can continue useful browser work.
A disconnected viewer, failed native cleanup, an orphaned share after restart,
or stale human-use status cannot block browser tools. Agents should re-observe
pages changed by the human. Connection loss, explicit Disconnect, revoked tabs,
control-endpoint denial, stale references and secret-field protections remain enforced.

`request_browser_login` opens a scoped tab and waits for its explicit request.
Its card offers Computer control and **Done** / **Cancel**, without credentials
in chat or a claimed debugger-detached privacy lock. Done resolves that exact
request and tells the requesting agent the human has finished. It works without
an active run or Chrome connection. Stale cards cannot complete a newer request;
late open/mark responses cannot resurrect cancelled status.

On settlement, temporary tabs normally close. While human-use status is set,
owned tabs are retained so settlement does not close tabs the human is using.
`browser_keep_tab` deliverables are released open; handoff tabs remain reserved.
Later runs can use valid retained tabs without mandatory Resume. Real debugger
cleanup failures remain security faults, not human-use status; reconnect/close
the affected session rather than blindly reenabling invalid tabs. Personal tabs
are never automatically closed. Advanced Close session is available when idle.

Native Mac desktop private handoffs remain a separate exclusive security system;
Computer control does not make native desktop automation permissive.

Disconnect, worker termination, browser/server restart and tab replacement revoke
capabilities; there is no mutation replay or automatic authority reconstruction
from numeric IDs. Transport reconnects automatically unless explicitly disconnected;
agent sessions never renew automatically, even on the next run. The single routine
recovery path is the no-argument **`browser_reconnect`** tool. Expiry errors direct
the agent to call it after the pinned Chrome profile's transport reconnects.

The tool drains previously admitted work, rechecks current run/cancellation and
native-private authority, then creates a fresh empty task identity on the **same
profile**. It does not reconnect the extension, clear
pairing blocks, adopt existing tabs, navigate, send input or replay a previous
operation. Work queued under the old identity is rejected. A healthy session is
left unchanged. The agent must reopen the desired page with `browser_open`, take
a new `browser_snapshot`, and verify any unconfirmed action's outcome rather than
repeat it. Existing personal/deliverable tabs and other agents' sessions are not
reset. There is no background task-renewal path or shell/API recovery shortcut.

An absent/revoked profile, pending sign-in request, native-private handoff or
security/cleanup failure remains blocked. Operator **Reconnect** in the extension
and/or completion of the relevant private handback may be required; the agent
tool cannot manufacture that consent. Advanced idle-only **Close session** remains
for operator repair and intentional profile changes, not routine
agent-session recovery.

Startup reconciles only cleanup: detach this extension's old
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

## Computer control (Linux local X11)

**Settings → Computer control**, the individual **agent menu → Computer control**,
and Connected Chrome settings open the same `ComputerControlPanel`, with one
global viewer state and owner. Agent context only selects its pinned computer;
it does not create a per-agent computer session. Global settings work without a
selected agent. With no configured/pinned profile, an installed owned desktop
can be used before pairing. A pinned/unavailable computer never silently switches
to another desktop. When only the global configured profile is disconnected,
**Use installed computer** explicitly selects the installed desktop before
**Take control**; it does not change browser configuration or an agent’s pin.
Browser profile/site configuration remains separate.

Opening the panel does not capture anything. **Take control** starts the remote
viewer; **Done** stops local input and notifies sign-in requests on that computer
bound when control was taken. Newer requests and requests on another computer are
never completed by an older viewer action. A stable Take identity binds Done,
reconnect and unmount independently of rotating socket/ticket generations.
Reconnect and cleanup retry appear only when relevant. No local-machine “Open in
Chrome” path or tab-capability/pause/resume controls are exposed. The agent entry
adds a collapsed Advanced browser-session settings/repair section; Close session is
server-enforced idle-only and does not close the computer viewer.

**The viewer covers the full computer, including other windows and notifications,
not just a browser tab. Browser agents may continue; this is not an exclusive
privacy lock.** No file transfer. Viewer pixels are not sent to the model, but
normal scoped browser tools remain usable and their existing secret-field
suppression still applies.

**Mobile viewer:** portrait phones get a height-filled desktop and a **Pan**
slider above it to reach the left and right edges. The slider supports touch and
keyboard input without sending those actions to the computer. It uses the actual
desktop aspect ratio; desktop and landscape layouts fit the whole screen.
This changes only the local view, not the remote resolution or website zoom.
Held viewer keys are released when focus moves to local controls; the slider
must not leave modifiers or ordinary keys held on the computer. Panning resets
on disconnect or Done. Clipboard controls remain outside the clipped desktop.

**Compact mobile controls and keyboard:** while connected, the phone toolbar
uses accessible icon buttons and keeps Done visible; the information button
reopens the full-computer access notice. The notice is always shown before Take.
The viewer fills the space left below the compact controls and adjusts to the
phone keyboard's visible viewport without reconnecting.

**Show keyboard** opens the device keyboard for the focused remote field.
Tap the remote computer to choose another field without dismissing that keyboard.
Committed Unicode/composition text, Backspace and Enter are sent as balanced
remote key events; Esc, Tab and arrow buttons provide common non-text keys.
**Hide keyboard** (or Escape on a physical keyboard) closes the local keyboard.
Shift+Tab returns to local controls. Typed text has no Jelly API, transcript,
storage or React-state path; temporary input is cleared on commit and dismissal.
Device keyboards and remote applications may retain text independently.
Disconnect or Take replacement discards unfinished composition; it is never
replayed. For clipboard or long text, use **Paste to computer** instead.
Actual OS-keyboard behavior still requires device-specific Safari/Android checks.

**Human-only text transfer:** the connected toolbar offers **Paste to computer**
and **Copy from computer**. Paste reads this device’s clipboard only on that
click, transfers UTF-8 text, confirms it by native readback, then sends Ctrl+V to
the still-connected computer. A real Ctrl/Command+V paste into the focused viewer
uses the paste event’s text without requesting clipboard permission. Ctrl+Shift+V
(or **Paste into a terminal** in **Text options**) deliberately uses the terminal
shortcut. No text is typed through keyboard emulation. **Send without pasting**
updates only the computer clipboard. There is no automatic synchronization or
paste on reconnect; remote apps still decide how a paste is handled.

Transfers support empty text, newlines and Unicode, up to **256 KiB UTF-8**;
images/files, invalid UTF-8 and oversized contents are rejected, never truncated.
The native dependencies are `/usr/bin/xclip` for foreground ownership and the
existing Python/libX11 runtime for an on-demand reader, using only `CLIPBOARD` /
`UTF8_STRING` on the original attested X11 display. The reader validates actual
SelectionNotify success and exact property type/format, including bounded INCR
chunks, before emitting any UTF-8 text. Failed conversion is never treated as
empty text. Every helper verifies the expected Jelly parent before and after
installing SIGKILL parent-death protection.
No PRIMARY selection, polling or passive RFB clipboard export is enabled;
x11vnc retains `-nosel`. Both directions are explicit cookie/CSRF-protected POSTs
bound to the active owner, Take identity and exact connected generation. Helpers
are size/time bounded, writes serialized and confirmed, and helpers are killed
and drained when the viewer is revoked. Clipboard failure does not block browser
tools or bypass held-key cleanup.

Where browser permissions or plain HTTP prevent clipboard APIs, **Text options**
provides local textareas for manual paste/send and select/copy. Safari-style copy
starts a promised ClipboardItem in the click gesture; a denied write leaves a
manual-copy result instead. Text is not logged, stored by Jelly, sent to models,
or placed in chats/status/events. Drafts survive retries but transfer fields clear
on disconnect, Done, Take replacement and panel unmount. This does **not** erase
native OS clipboards: computer apps and clipboard managers may retain copied
text. Copying text into a remote page can of course make it visible to that page
and its existing scoped browser tools. No agent clipboard tool is provided.

Only the owning authenticated control-session cookie can receive single-use,
short-lived generation-bound tickets. CSRF and same-origin checks remain. Other
control sessions cannot view, reconnect, take over, or end its viewer. The native
host attests the exact local X11 display and private authorization. Wayland,
remote displays, macOS and Windows are not supported by this viewer; no fallback
or public listener is opened. Native RFB is Unix-socket only. The separate native
Mac desktop automation controls are not a Computer control destination.

Closing an owned viewer stops input and sends Done. Cleanup failure does not trap
the panel or block agents: the durable native cleanup obligation is retained and
shown as **Retry cleanup** next time. Disconnect/owner expiry revoke old tickets
and input; reconnect requires verified teardown. Cleanup verifies process exit,
private runtime/guard locks, original display authorization and held key/button
release. It may release physical keys/buttons on that display too. A restarted
share is orphaned and permits cleanup without viewing, never ownership transfer.
Uncertain native authentication or input cleanup still requires operator repair;
never delete the latch/runtime to bypass it. These obligations gate **viewer
reuse**, not browser automation. Native Mac private-work exclusion stays intact.

### Shared-memory lifetime and explicit repair

Capture always uses x11vnc `-noshm` (ordinary X11 image transfers). Its MIT-SHM
buffers otherwise survive forced termination on hosts with the default
`kernel.shm_rmid_forced=0`; repeated crashes or parent-death tests can exhaust the
System V segment limit even when RAM and disk space remain available. Avoiding
these allocations is the permanent fix, not a larger limit or a cleanup timer.
It may cost additional image-copy CPU; display identity, Unix-only transport,
clipboard isolation and strict input teardown are unchanged. A SIGKILL still
requires the existing cleanup proof; this does not classify it as a clean exit.

For existing abandoned allocations, run the metadata-only repair as the
ordinary owning user, **without sudo**:

```sh
python3 scripts/cleanup-orphaned-shm.py
# Inspect the dry run, then explicitly apply:
python3 scripts/cleanup-orphaned-shm.py --apply --report /tmp/shm-repair.json
```

This Linux/util-linux helper only selects current-user-owned and -created,
private-key, mode-0600 segments with no attachments, at least five minutes since
any recorded activity, and both creator and last-user PIDs demonstrably gone.
It rechecks every ID and all metadata immediately before removal. Active,
named, foreign-user, recent, changed and uncertain segments are preserved; no
contents are read, no processes are killed and no kernel policy is changed.
Report files are new and owner-only. This is an explicit repair tool, never an
automatic background sweeper. A nonzero exit may mean partial cleanup; consult
the report rather than broadening the selection.

`bun run test:chrome-shm` covers repair policy without mutating real IPC.
`bun run test:chrome-vnc` checks live capture and verifies no capture-owned SysV
segments remain through viewing, reconnect, forced kill and real parent death.

## Optional owned virtual-X11 desktop — existing profile, extension-only automation

This is a **separate, explicit owner installation**, not native Wayland capture
or a managed-browser fallback. An independent user service runs a private Xvfb
and standard Openbox window manager plus ordinary headed Chrome using the
**existing selected user-data root/profile in place**. No profile is copied;
there is no Playwright, CDP/debugging port or AgentBrowser controller attached to
this Chrome. Browser automation still uses only Jelly's extension/native host.
The existing GNOME/Wayland session is unchanged. Existing unowned-X11 admission
remains a separate, explicitly selected sharing source.

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

### Pre-pair computer access and cleanup

Open **Settings → Computer control**. With no configured/pinned profile, the
installed owned desktop offers **Take control** even with zero paired profiles.
Opening/polling never starts capture. The viewer uses the same cookie, CSRF,
origin, owner/generation, Unix-only transport and input cleanup protections as
an already paired computer. Browser work is not frozen and profiles are not
withheld from publication. Native Mac desktop exclusion is separate.

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
before/after native auth and at viewer cleanup.
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

Chrome connects automatically (or use Reconnect after an intentional Disconnect).
An attested owned profile is published immediately after normal authenticated
pairing and debugger cleanup, including while the human viewer is open. Done
revokes viewer admission and stops/cleans up the native helpers. It does not
freeze/unfreeze browser profiles or restore invalid task authority. Owner and
viewer-generation changes still fence asynchronous native cleanup.

Network/owner loss revokes viewer access. Normal shutdown uses a queued GTK main-context
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

The disposable fixtures cover zero-profile Take, native GTK authentication,
existing-profile persistence, exact native bindings, owner/CSRF/origin isolation,
and native cleanup. The human-use simplification requires rerunning these
optional headed fixtures before deployment; earlier exclusive-lock/publication
results do not qualify the new advisory behavior. No real-device result is
implied by this-host fixtures.

## GNOME Wayland qualification — not enabled

The existing X11 backend above does **not** capture a GNOME Wayland desktop.
An inherited XWayland `DISPLAY` is not evidence of native desktop ownership;
Jelly does not use it as a fallback, restart Chrome, move/copy its profile, switch
sessions, or enable a remote-debugging port. There is no managed-browser VNC
fallback to unlock the existing profile's OS keyring.

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
and document/lease/control-endpoint checks implement observations/input, including OOPIFs;
CDP is internal for debugger lifecycle/screenshots. There are no page/content-
script control RPCs, arbitrary eval/CDP tools, cookie/password/autofill/browser-
storage reads, history/bookmarks tools or network response bodies.

Agent tab DNR protections are installed before first navigation. All websites,
including local/private services, are accessible without an allowlist. Exact
Jelly/control destinations, credential-bearing URLs and non-web schemes are
blocked for main documents, redirects and subresources. This is **not managed
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

The advisory-control change passes `bun run check:full` in an isolated source
snapshot (TypeScript, the complete test suite, and client/extension builds).
The disposable headed Chrome/native-host fixture and actual X11 viewer fixture
pass, including browser operations during human use, mobile fit, held-key/button
cleanup, disconnect/reconnect, failed-cleanup dismissal, ownership and orphan
recovery. The owned-desktop fixture also passes both direct and systemd-socket
private-authentication variants, existing-profile persistence and native teardown.
Independent source review's handover/identity/retention findings were corrected
and covered by regressions. These checks do not activate the live service or
qualify a real remote device.

Run targeted unit/client checks for `chrome-bridge`, `chrome-api`, `chrome-share`,
`chrome-client`, `chrome-share-client`, `owned-chrome-desktop`, browser tools and
native desktop boundaries, plus `bun run check`. Before deployment run
`bun run check:full`. Optional disposable headed qualification:

- `bun tests/chrome-extension.browser.ts`: actual extension/native bridge,
  unrestricted websites/control-endpoint denial, refs, secret fields, debugger/security cleanup and retained tabs.
- `bun run test:chrome-vnc`: actual X11/noVNC input, owner isolation, advisory
  browser operation, mobile fit and teardown.
- `bun run test:chrome-owned-vnc`: owned desktop/authentication/persistence.

Tests use disposable profiles, not the normal Chrome profile. Full-desktop
fixture success is not remote-device validation. Reload the unpacked extension
after updating the backend/native host: protocol 8 removes the legacy site-scope
fields and refuses mixed-version pairing. A Chrome/profile restart is not required. Preserve intentional Disconnect.

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
(`authUncertain: false`), **Retry cleanup** can retire the
remaining latch even after that original Chrome/display has gone. This also
works for a restored clean orphan. Ordinary Done and Reconnect still
require the original live desktop; this exception grants no viewing authority.

Recovery requires explicit persisted completion fields, no outstanding helper
or transition, and the original private installation/configuration, generation
and display-binding record. Missing/malformed evidence, replaced configuration
or record, unresolved input, or uncertain authentication remain blocked for
operator repair. It never replays input or authentication, guesses a native
outcome, or touches a replacement display. Private same-user files are the trust
boundary, not protection against a malicious process rewriting files as that
same OS user. Viewer owner/generation and native privacy checks still apply.
Browser peers do not participate in viewer cleanup, and lost browser tasks are
not resumed.

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
