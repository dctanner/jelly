# Computer use for Jelly on macOS — research and recommendation

> Historical research. Managed-browser code referenced below has since been
> removed. Connected Chrome is now the only browser integration; native Mac
> desktop tools use Peekaboo separately. See [Connected Chrome](CONNECTED-CHROME.md)
> and [Peekaboo](PEEKABOO.md) for current behavior and setup.

Researched **2026-10-11**. “Hermes” means **NousResearch Hermes Agent**. This is documentation/source research, not a Mac runtime benchmark. No drivers were installed, permissions granted, application code changed, or services restarted.

## Recommendation

**Build browser-first computer use, with Peekaboo as the first macOS desktop provider and TryCua Cua Driver as an optional alternative.** Keep the provider boundary small and replaceable. Do not build a new screenshot/mouse/keyboard engine, import an entire competing agent framework, or silently switch providers after an uncertain action.

Use the narrowest reliable surface:

1. Native APIs, application CLIs, or scoped connectors when available.
2. Browser DOM/accessibility tools for websites; Connected Chrome for explicitly authorized signed-in browsing.
3. App/window-scoped desktop accessibility plus screenshots for native UI.
4. Foreground pixel input only when needed, explicitly authorized, and nobody is competing for control.

**Why Peekaboo first:** macOS-specific breadth (menus, dialogs, windows, Dock, accessibility, capture), CLI/MCP/Swift integration options, MIT licensing, a signed companion app, and OpenClaw's default Mac provider. Current Peekaboo supports background actions too; it is not merely a foreground mouse driver. This is an integration-fit judgment, not a demonstrated win in success rate or latency.

**Why keep CUA:** Hermes provides a strong reference implementation of session lifecycle, approvals, background-first observation/action/verification, and structured refusals. Cua Driver provides a cross-platform contract and SDK option. If one desktop backend across Mac/Windows/Linux becomes the priority, CUA is the stronger architectural candidate, subject to platform/action-specific testing and pinned versions.

## How OpenClaw does it

The normal desktop path is a built-in `computer` tool routed through `computer.act` and `screen.snapshot`, to the Gateway desktop or a paired computer node. On macOS:

- **Peekaboo is the default provider.** Native services are embedded in OpenClaw.app; built-in computer actions do not shell out to `peekaboo` or traverse its CLI bridge socket.
- **CUA is a selectable alternative** when the driver is bundled. OpenClaw.app starts a private embedded daemon directly so it stays in the app's macOS permission responsibility chain.
- Provider capability descriptors determine which actions are exposed. Provider changes invalidate the execution generation; individual failures do not trigger fallback to the other provider.
- Coordinates and elements refer to delivered observations, with display/window/generation checks. A dispatched event is not necessarily a confirmed application effect.
- Accessibility and Screen Recording belong to **OpenClaw.app** for these managed integrations. The native Peekaboo input path also checks Event Posting.

Several other integrations are deliberately separate:

| Surface | Appropriate use |
| --- | --- |
| Built-in `computer` + native Peekaboo | Normal OpenClaw agent control of a paired Mac |
| Bundled `peekaboo` skill + installed CLI + PeekabooBridge | Broad Mac automation through the app's permission-aware broker |
| Direct `cua-driver mcp` | Low-level upstream driver tools in an MCP-capable runtime |
| Codex Computer Use plugin | Specifically when Codex app-server owns the agent harness and native tool calls |
| Browser plugin / `browser-automation` skill | Website work, with separate managed or explicitly attached signed-in browser profiles |

**Best OpenClaw setup for Mac:** start with built-in Peekaboo computer use and browser automation; add the bundled Peekaboo CLI skill for broader native operations. Use CUA only for a specific capability need. Codex Computer Use is useful for a Codex-native setup, not a generic prerequisite for GPT models.

Safety difference worth preserving: OpenClaw's managed Mac CUA daemon deliberately bypasses CUA approvals and relies on authorization above it (tool exposure, pairing/command policy, local control setting, OS grants). Ordinary enabled computer input has no per-action confirmation. Do not copy that bypass into Jelly without owning an equivalent policy boundary.

Sources: [OpenClaw computer use](https://docs.openclaw.ai/nodes/computer-use), [Peekaboo bridge](https://docs.openclaw.ai/platforms/mac/peekaboo), [Codex Computer Use](https://docs.openclaw.ai/plugins/codex-computer-use), [browser](https://docs.openclaw.ai/tools/browser).

## How Hermes does it

Hermes's recommended desktop integration is its built-in **`computer_use` toolset**, backed by **`cua-driver` over stdio MCP**. Its wrapper exposes Hermes actions such as capture/click/type/key, translates snapshot element indices to opaque driver tokens, and returns screenshots plus accessibility information.

- Background-first window actions avoid changing the real cursor/frontmost application where supported. The documented ladder is element action → fresh verification → pixel action → explicitly approved foreground escalation.
- Desktop-wide input is not equivalent to background window-targeted input. Background operation is not guaranteed for every app, gesture, or Space.
- On macOS, grants belong to the signed **CuaDriver.app**, bundle ID `com.trycua.driver`, rather than Hermes. Private runtimes launch through that app identity.
- Hermes applies its own mutation approvals. Foreground and background grants are separate; unattended actions needing unanswered approval fail closed.
- Standard, bounded-manifest, and explicit unrestricted/YOLO modes are launch choices. Runtime calls cannot widen them.
- Browser page content now uses the separate **browser toolset**, normally `browser_exec` through Browser Use CLI/browser-harness. Native browser chrome/dialogs can still need desktop tools.
- Alternate computer providers are supported through `ctx.register_computer_use_provider()` and `computer_use.backend`, but a plugin interface alone is not evidence of a better third-party provider.

**Best Hermes setup:** built-in `computer_use` + bundled Hermes computer-use skill + separate browser automation. Add CUA's platform skill pack for troubleshooting/deep context, but continue calling the Hermes wrapper vocabulary. Raw CUA MCP is an alternative for low-level needs, not an extra requirement. Verify actual skill installation with the installed driver's help/status: upstream and Hermes documentation disagree about automatic Hermes detection.

Hermes's real-profile browser option copies authentication data into a separate profile snapshot. That is a different trust model from controlling explicitly authorized tabs in Jelly's Connected Chrome; it should not be adopted accidentally.

Sources: [Hermes computer use](https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use), [Hermes skill](https://github.com/NousResearch/hermes-agent/blob/79b45d1647f6b5680768d851c4c406e8cc550a1e/skills/autonomous-ai-agents/computer-use/SKILL.md), [browser](https://hermes-agent.nousresearch.com/docs/user-guide/features/browser), [provider plugin interface](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins#computer-use-backend-plugins).

## Shortlist for Jelly

| Option | Best fit | Important limits | Verdict |
| --- | --- | --- | --- |
| **Peekaboo CLI/MCP + signed app** | Mac-native desktop UI and shortest Mac pilot | macOS 15+; background availability depends on operation/target; matching CLI/host capabilities matter; Accessibility, Screen Recording, and synthetic-input permission checks | **First candidate/default Mac provider** |
| **TryCua `cua-driver mcp`** | Cross-platform desktop contract, structured effect/refusal evidence, bounded runtime policy | macOS 14+ per quickstart; private SkyLight API dependence; canvas/game/off-Space/minimized-window limits; checked release tags are prereleases | **Optional provider; first choice if cross-platform contract dominates** |
| **Macuse MCP** | User-installed native Mail/Calendar/Notes/Reminders integrations plus GUI control | Commercial app; not source-audited here; some native integrations require Full Disk Access; desktop writes use per-app consent rather than universal per-call approval | **Worth a user pilot/connector, not Jelly's embedded foundation** |
| **Codex Computer Use** | A product already running Codex app-server | Harness-specific plugin/app lifecycle; separate permissions and native policy | **Not Jelly's general backend just because Jelly uses an OpenAI model** |
| **Plain screenshot + global mouse/keyboard scripts** | Disposable, isolated GUI experiments | Competes with user input; poor targeting/state verification; no inherent lifecycle/scope controls | **Do not use as the default personal-Mac implementation** |

Peekaboo and CUA drivers are MIT. CUA's optional perception extension has an **AGPL-3.0-only detector**; do not bundle or host that extension without license review. No perception extension is required for the base driver.

Macuse currently advertises macOS 13+/Intel/Apple Silicon, a free tier of 100 calls/day and one client, and a $49 lifetime tier. These are vendor claims/current pricing, not an independent reliability endorsement. It can connect through MCP to compatible clients; no special OpenClaw/Hermes backend plugin was verified.

Sources: [Peekaboo project](https://github.com/openclaw/Peekaboo), [Peekaboo v4.9 background/foreground contract](https://github.com/openclaw/Peekaboo/blob/v4.9.0/docs/automation.md), [MCP integration](https://github.com/openclaw/Peekaboo/blob/v4.9.0/docs/MCP.md), [Cua architecture](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works), [platform support](https://cua.ai/docs/reference/cua-driver/platform-support), [permissions](https://cua.ai/docs/reference/cua-driver/permission-modes), [driver license/perception boundary](https://github.com/trycua/cua/blob/e9dc65780bdbf6e68d42aafa959c1925dbba2a56/libs/cua-driver/README.md), [Macuse desktop tools](https://macuse.app/docs/features/computer-use), [Macuse pricing](https://macuse.app/pricing).

## What Jelly already has, and what is missing

Existing code is a useful foundation, but is **not yet native Mac computer use**:

- `src/server/computer.ts:142-144` rejects non-Linux managed desktops. The current Xvfb/x11vnc display stack cannot simply be started on a Mac.
- Connected Chrome is browser-only; `docs/CONNECTED-CHROME.md:221-224` explicitly defers cross-platform installation. Its native messaging host is not a desktop input driver.
- `src/server/mcps.ts:37-45` makes MCP available through MCPorter shell calls, not native typed agent tools. Merely adding an MCP entry does not provide desktop ownership or automatically turn JSON/base64 into model image content.
- `src/server/harness.ts:206-221` has a custom-tool registration seam. `src/server/agent-tools.ts:117-132` already returns real image blocks for browser screenshots. Reuse these patterns for a first-class desktop adapter.
- `plans/04-macos.md` already leaves native packaging, runtime lifecycle, and managed computer/browser integration open.

### Suggested implementation order

1. **Pilot external signed Peekaboo.app/CLI.** Use primitive observations/actions, not Peekaboo's second autonomous model loop. Test CUA against the same tasks before finalizing the default. An externally installed driver supplies the native component; no bespoke Jelly Swift engine is required for this pilot.
2. **Port the browser layer deliberately.** Implement Mac native-host registration for Connected Chrome and a Mac-compatible managed-browser lifecycle. Native Mac browser windows are not isolated Linux desktops; make that difference explicit.
3. **Add separately named `desktop_*` tools**, backed by a selected provider. Return structured observations and image blocks; retain raw effect/refusal/retry-safety information. Do not relabel OS actions as `browser_*` or silently retry through another backend.
4. **Own shared-desktop arbitration.** Use a GUI-session-wide run lease, cancellation/drain barriers, stale observation fencing, and explicit human takeover/resume. Different agent names/cursors do not isolate a shared native desktop.
5. **Coordinate desktop and Connected Chrome.** OS automation can click extension-owned tabs or capture secrets outside the extension's redaction/site checks. Prevent conflicting control and pause all relevant paths during private login. A browser origin allowlist does not constrain arbitrary desktop input.
6. **Productize permission identity and updates.** Either keep the signed vendor app as permission owner, or embed the driver under a signed Jelly-native app/helper with a stable identity/path and verified lifecycle. Never grant broad GUI privileges to generic Bun/Node just to make a prototype work. Include doctor/status, missing-permission recovery, locked-session handling, stop/revoke, and rollback.

Use loopback/private local IPC, or authenticated Tailscale transport for a future remote Mac helper, consistent with `AGENTS.md`. A remote Jelly server must control a Mac-local component; it cannot reach the user's desktop merely because the browser client is on a Mac.

These are product controls, not a security sandbox against unrestricted same-user shell execution. Existing preauthorized bash/MCP facilities can bypass a wrapper unless an OS/process boundary also restricts them.

## Validation before selecting a release

On a real Mac, run both drivers against identical synthetic/consented tasks: Calculator result readback; TextEdit edit/save; Finder navigation and a file dialog; native app menus; Electron controls; Retina/mixed-scale display coordinates; a background target while the human types elsewhere; off-Space/minimized targets; denied permissions; cancellation; restart/stale references; two simultaneous Jelly agents; and private browser takeover.

Measure task success, confirmed state change, unnecessary focus/cursor/Space changes, screenshot/model cost, permission setup/recovery, and uncertain-action replay. Refusal can be correct behavior. Keep app-owned readback evidence; a tool returning “success” is insufficient. Do not promise background support for all apps from a marketing headline.

## Version/research caveats

Source snapshots checked:

- Hermes `79b45d1647f6b5680768d851c4c406e8cc550a1e`: [package lock](https://github.com/NousResearch/hermes-agent/blob/79b45d1647f6b5680768d851c4c406e8cc550a1e/pm/lock.json) pins **CUA 0.21.0**.
- OpenClaw `cedb310b3ab199fd5cc39957654b97a34da0b6f4`: [CUA extension manifest](https://github.com/openclaw/openclaw/blob/cedb310b3ab199fd5cc39957654b97a34da0b6f4/extensions/cua-computer/package.json) pins **CUA 0.32.0**; the Swift package lock pins **Peekaboo 4.9.0**.
- CUA `e9dc65780bdbf6e68d42aafa959c1925dbba2a56`: main version and release tags differ; the inspected **0.34.1** release is marked prerelease. Do not assign newest upstream capabilities to an older downstream pin.
- Hosted docs contain stale summaries: Hermes's broad no-foreground claims need qualification; its removed desktop browser route still appears in some bounded-browser guidance; its old no-foreground link returned 404. OpenClaw's bridge summary underdescribes the newer selectable CUA provider. Prefer version-matched schemas and test evidence.

**Bottom line:** choose **browser-first + Peekaboo desktop** for Jelly's Mac-focused starting point; retain **CUA as a pluggable cross-platform alternative**. Borrow Hermes's verification/approval discipline and OpenClaw's signed native permission hosting—not their entire runtimes or unrestricted defaults.
