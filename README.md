# Jelly

<p align="center">
  <a href="https://dctanner.github.io/jelly/">
    <img src="docs/images/jelly-mobile-preview.jpg" width="360" alt="Watch Jelly’s launch reel: open-source agents on your hardware, with real mobile UI, private browser handoffs, and sudo.">
  </a>
  <br>
  <a href="https://dctanner.github.io/jelly/">Watch the 29.5-second launch reel</a> · <a href="https://dctanner.github.io/jelly/media/jelly-mobile.mp4">MP4</a>
</p>

Real mobile UI with demonstration data and an original soundtrack; sudo execution and website sign-in are simulated.

A local-first workspace for persistent AI agents. Give each agent a name, instructions, and a project folder, then chat through a simple web interface.

Built with Bun, React, SQLite, and the [Pi agent harness](https://github.com/earendil-works/pi).

- Persistent conversations, project workspaces, and background agent runs
- File editing, shell tools, subagents, and MCP connections
- Browser control with private sign-in handoffs; Linux desktop support
- Administrator commands via `request_sudo`, with private password handoffs
- File uploads, inline images, and downloadable artifacts
- ChatGPT subscription or OpenAI API access (required)

## Quick start

Requires [Bun](https://bun.sh) **1.3.9+** and **Node.js 24+** (for subagent runners and CLI dependencies). Linux is required for the managed browser desktop and sudo handoffs.

```sh
git clone https://github.com/dctanner/jelly.git
cd jelly
bun install
bun run dev
```

Open **http://127.0.0.1:5173**. **A ChatGPT subscription or OpenAI API key is required to run agents.** Connect your account or add a key in Settings before sending a message. Automatic mode prefers ChatGPT, then an API key; there is no no-key demo mode. Model availability depends on your account.

Select **GPT-6 Astra Ultrafast** in Settings → Model or the composer's model menu
for eligible ChatGPT subscriptions (Pro 500 or Enterprise) or OpenAI API access.
This requests Astra with `service_tier: "ultrafast"`; standard Astra remains the
default. [Ultrafast has higher API pricing and separate limits](https://developers.openai.com/api/docs/guides/ultrafast-mode).
Account-access errors are surfaced rather than silently falling back to standard.
The selection covers chat turns, tool continuations, naming, and compaction;
Pi subagents still use their own service-tier settings (they inherit Astra and effort,
not Jelly's Ultrafast selection).

Optional environment settings are documented in [`.env.example`](.env.example). Put local values in `.env.local`, which is ignored by Git. Set `FIRECRAWL_API_KEY` to enable web search and fetching.

### Production

```sh
bun run build
bun start
```

Open **http://127.0.0.1:3100**. Stop development first; both modes use API port 3100 by default. Production has no hot reload—restart after code changes when agents are idle. Development backend reloads interrupt active runs; set `JELLY_WATCH_API=0` to disable them.

ChatGPT sign-in uses a one-time device code. Open the approval link shown in Settings, enter the code, and Jelly connects automatically. This works over Tailscale without a localhost redirect. If needed, enable device-code login in your ChatGPT security settings or ask your workspace admin.

### Optional browser desktop

On Debian/Ubuntu x86-64, with Google Chrome or Chromium already installed:

```sh
bun run setup:desktop
```

Set `JELLY_BROWSER_PATH` if the browser is outside its usual system location.

### Administrator commands

Agents can use `request_sudo` to run commands with root privileges—for example, to install packages or manage system services. If your sudo policy permits, the command runs immediately. Otherwise, Jelly shows the command for review and asks for your password in a private authentication card, never in chat. The password is not sent to the model or saved by Jelly.

Requires Linux, `sudo` with askpass support, and `/usr/bin/python3`.

## Security and local data

**Jelly is a trusted-user tool, not a sandbox.** Agents can execute shell commands and access files with your OS user's permissions, without per-tool approval. Sudo commands run immediately when your policy permits; otherwise Jelly requests private authentication.

Keep Jelly on loopback or a trusted Tailscale network. Do not expose it directly to the public internet. Anyone with network access to the app may gain control of its tools. `bun run dev:tailscale` enables private tailnet access.

Conversations, credentials, browser profiles, and artifacts live in `.jelly/` by default. User-wide MCP configuration and OAuth caches live in `~/.jelly/`. Neither belongs in source control. Stop Jelly before backing up its instance data. Model conversations are sent to your chosen provider; local storage does not mean local inference.

## Development

```sh
bun run check   # TypeScript, tests, and production build
```

Tests use temporary data and deterministic fixtures; no paid model calls are required. See [architecture](docs/ARCHITECTURE.md), [design](docs/DESIGN.md), and the [roadmap](ROADMAP.md).

## License

[MIT](LICENSE). Bundled fonts and dependencies retain their own licenses, including noVNC (MPL-2.0).

### Clipboard during browser control

In **Agent computer**, choose **Take control**. Once connected, **Paste to remote**
reads this device's text clipboard and pastes into the focused remote field.
**Copy from remote** copies the remote clipboard back to this device; first select
and copy text inside the remote browser. If browser permissions or HTTP prevent
clipboard access, Jelly provides a private manual paste/select-and-copy form.

Clipboard transfers are text-only, limited to 12,000 characters, and available
only to the controlling window. They are not sent to agents, chat history, or logs.
Returning control clears the remote clipboard; it does not clear this device's
clipboard. The desktop runtime now requires `xclip`; run `bun run setup:desktop`
to update an older installation if it is not already installed on the host.

## Automatic agent names

The top-left **+** immediately creates and opens **New Agent**, without a form.
It inherits the current project (or gets a private workspace outside a project).
Before the first message, click the centered name or avatar to edit it in place.
Name edits save with Enter or on blur (Escape cancels); avatar changes save when selected.
After the first message, the pill moves to the header and opens the profile edit form
directly. The separate options button still exposes workspace and agent actions.
When its first message is sent, Jelly makes
one small, tool-free OpenAI request through the selected ChatGPT subscription or
API connection to suggest a sea-themed name related to that message. The new name
appears in the agent list and conversation header before the agent begins work.

Editing and saving the name before sending the first message opts out—even if you
change it back to **New Agent**. Editing only instructions or the avatar does not.
Existing agents retain their names. Naming failures/timeouts keep **New Agent** and
do not stop the task or retry the naming request on subsequent messages.

### Independent agent browsers

Each agent opens its own browser window, profile, and private desktop on demand.
Normal runs reuse that agent's browser; other agents have separate tabs, focus,
clipboard and human-control state. The Computer panel follows the selected agent;
a login handoff opens the requesting agent's browser. Switching agents disconnects
the old viewer and clears the panel's private clipboard text, but does not return
human control. Return control explicitly when finished signing in.

At most eight browser sessions can be allocated at once. **Close browser session**
releases an agent's desktop resources (return human control first); opening it again
reuses its profile. Server shutdown also closes all desktops. New isolated profiles
live under `browser-sessions/<hashed-agent-id>/`; existing `browser-profile` and
`browser-home` data is retained untouched, not copied. You may need to sign in again.

Stop prevents queued browser actions from executing and discards cancelled results.
An action already sent to Chromium may still finish; Stop cannot undo navigation,
clicks, typing, or their website side effects.
