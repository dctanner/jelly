# macOS setup: user service and Claude Code

Run Jelly as a **LaunchAgent in your logged-in user session**, not as a system
LaunchDaemon, when using your existing Claude Code subscription login.

A LaunchDaemon can have `UserName` set to your account and still run in the
**System** launchd/security session. That does not give it the same Keychain
access as Terminal. The observed failure is: `claude auth status` says signed in
in Terminal, but the same executable, user and config directory report signed
out inside Jelly. Moving Jelly to `gui/<uid>/com.jelly.server` resolved this;
copying credentials or signing in again was unnecessary.

A LaunchAgent starts **at user login**, not before login at boot. Logging out
stops it. This setup is not an unattended, pre-login server configuration.

## 1. Prepare the checkout and Claude login

Use Terminal in the Mac's logged-in desktop session, as the account that will
run Jelly. Do not run the following setup as root or with `sudo`.

```sh
cd /absolute/path/to/jelly
bun install
bun run build
command -v bun
command -v node
```

Install Claude Code if needed, then check the **same executable Jelly will use**.
For Claude's native installer, the usual path is:

```sh
"$HOME/.local/bin/claude" --version
"$HOME/.local/bin/claude" auth status
```

If it really is signed out in Terminal, run
`"$HOME/.local/bin/claude" auth login` and complete Claude's own sign-in flow.
Jelly requires a subscription login, not just an API-key login. Never paste
credentials into Jelly or copy Claude's tokens into Jelly's auth files.

Launchd does not source `.zshrc`, `.zprofile` or other interactive shell startup
files. Set an **absolute** executable path in the checkout's ignored `.env.local`
if Claude is not on the service PATH (replace `you` with your account name):

```dotenv
PI_CLAUDE_CODE_COMMAND=/Users/you/.local/bin/claude
```

Do not rely on `~` or `$HOME` expansion in a plist. Use
`PI_CLAUDE_CODE_CONFIG_DIR` only if you intentionally use a nondefault Claude
config directory; normally leave it unset. Restart the service after changing
its environment, then refresh Claude in Settings. `.env.local` is loaded from
the service's working directory, which must be this checkout.

## 2. Create the user LaunchAgent

The following creates `~/Library/LaunchAgents/com.jelly.server.plist`, **without
starting or stopping anything**. It refuses to overwrite an existing user
plist. If this machine has a legacy Jelly LaunchDaemon, it copies its command,
environment, log paths and data settings after verifying the account and
checkout. Otherwise it creates a production service for the current checkout.
It does not copy your shell's API keys or Claude credentials.

If a user plist already exists, inspect and update it instead of rerunning the
creation block. Do not display credential-bearing environment values in chat.

Run from the checkout:

```sh
/usr/bin/python3 - <<'PY'
import os, pathlib, plistlib, pwd, shutil

assert os.getuid() != 0, "Run as your logged-in user, not sudo/root"
home = pathlib.Path.home()
repo = pathlib.Path.cwd().resolve()
assert (repo / "src/server/index.ts").is_file(), "Run from the Jelly checkout"
assert (repo / "dist/index.html").is_file(), "Run bun run build first"
user = pwd.getpwuid(os.getuid()).pw_name
bun = shutil.which("bun")
node = shutil.which("node")
assert bun and node, "Bun and Node.js must be available in this Terminal"
legacy = pathlib.Path("/Library/LaunchDaemons/com.jelly.server.plist")
target = home / "Library/LaunchAgents/com.jelly.server.plist"
assert not target.exists(), "User plist already exists; inspect it instead"

if legacy.exists():
    service = plistlib.loads(legacy.read_bytes())
    assert service.get("Label") == "com.jelly.server"
    assert service.get("UserName") == user, "Legacy service uses a different user"
    assert pathlib.Path(service["WorkingDirectory"]).samefile(repo), "Different checkout"
else:
    logs = home / "Library/Logs/Jelly"
    logs.mkdir(parents=True, exist_ok=True)
    service = {
        "Label": "com.jelly.server",
        "ProgramArguments": [bun, "src/server/index.ts"],
        "WorkingDirectory": str(repo),
        "EnvironmentVariables": {"NODE_ENV": "production"},
        "StandardOutPath": str(logs / "server.log"),
        "StandardErrorPath": str(logs / "error.log"),
        "Umask": 0o077,
        "ThrottleInterval": 10,
    }

for key in ("UserName", "GroupName", "SessionCreate"):
    service.pop(key, None)
service.update(RunAtLoad=True, KeepAlive=True, LimitLoadToSessionType="Aqua")
env = service.setdefault("EnvironmentVariables", {})
env.update(HOME=str(home), USER=user, LOGNAME=user)
# Preserve existing service settings; add native CLI and version-managed runtimes.
paths = [str(home / ".local/bin"), str(pathlib.Path(bun).parent),
         str(pathlib.Path(node).parent),
         *env.get("PATH", os.environ.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")).split(":")]
env["PATH"] = ":".join(dict.fromkeys(p for p in paths if p))
target.parent.mkdir(parents=True, exist_ok=True)
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "wb") as output:
    plistlib.dump(service, output)
print("Created", target, "— not started yet")
PY

plutil -lint "$HOME/Library/LaunchAgents/com.jelly.server.plist"
```

## 3. Start it, or migrate the old system service

**Run these commands in a separate Terminal, outside Jelly.** Stop development
servers and wait for Jelly's active runs and restart holds to finish. Direct
launchctl commands do not wait for idle and can interrupt running work.

For a **fresh installation**, skip straight to the user-service startup below.
For a **migration**, first disable and unload the old system service:

```sh
sudo launchctl disable system/com.jelly.server
sudo launchctl bootout system/com.jelly.server
```

Do not continue if either command fails unexpectedly. Verify that
`launchctl print system/com.jelly.server` reports that the service cannot be
found. Keep the original plist for rollback; disabling prevents it from starting
again at boot. **Never run both services against the same database.** No database
or credential migration is needed when the working directory and data settings
are preserved.

Start the user service **without sudo**, from the logged-in user's Terminal:

```sh
launchctl enable "gui/$(id -u)/com.jelly.server"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.jelly.server.plist"
launchctl print "gui/$(id -u)/com.jelly.server"
curl --fail http://127.0.0.1:3100/api/health
```

Use your configured port if different from 3100. Confirm `state = running`, open
Jelly, refresh **Settings → Claude Code**, then explicitly select the Claude
subscription provider for a new agent. Automatic mode currently selects ChatGPT
or OpenAI API, not Claude. An existing provider-locked agent does not switch just
because Claude becomes available.

Fresh-install logs are `~/Library/Logs/Jelly/server.log` and `error.log`; a
migration preserves the old service's log paths. Health checks from this Mac do
not prove remote-device/Tailscale reachability—verify that separately.

### Restart and updates

From the checkout in a separate Terminal:

```sh
/bin/bash scripts/restart-when-idle.sh
# Only when interrupting active work is intentional:
/bin/bash scripts/restart-when-idle.sh --force
```

The helper prefers the user plist, restarts `gui/<uid>/com.jelly.server` without
sudo, and refuses to proceed while the system service is still loaded. It also
accepts differently capitalized paths when they identify the same checkout.
`--force` ignores active runs and restart holds, but retains service and health
checks. The helper checks both local and private Tailscale HTTP; disconnected
Tailscale can cause readiness verification to fail even if local Jelly works.
See [restart details](APPS.md#jelly-activation-helper).

After Bun/Node upgrades, check the absolute executable paths in the plist/PATH.
To apply edits to the **plist itself**, wait for idle, then `bootout` the user
service and `bootstrap` it again; `kickstart` alone does not reload the plist.
Changes only to `.env.local` require an ordinary restart.

### Rollback if startup fails

Stop/unload the user service before restoring the old system service. If it is
already absent, confirm that with `launchctl print`; do not ignore an unexpected
unload failure and start a second server.

```sh
launchctl bootout "gui/$(id -u)/com.jelly.server"
launchctl disable "gui/$(id -u)/com.jelly.server"
mv "$HOME/Library/LaunchAgents/com.jelly.server.plist" \
   "$HOME/Library/LaunchAgents/com.jelly.server.plist.disabled"
sudo launchctl enable system/com.jelly.server
sudo launchctl bootstrap system /Library/LaunchDaemons/com.jelly.server.plist
```

Only use this rollback if a legacy system plist was retained. It restores the
old service arrangement, including its possible Claude/Keychain limitation.

## Troubleshooting “Setup required”

1. **Executable missing:** check the absolute `PI_CLAUDE_CODE_COMMAND`, execute
   `--version`, and restart after fixing PATH or `.env.local`.
2. **Terminal signed in, Jelly signed out:** compare the executable, OS user,
   `HOME` and Claude config directory. Then check whether Jelly is loaded under
   `system/com.jelly.server` rather than `gui/<uid>/com.jelly.server`. A matching
   username alone is not sufficient. Inside a Jelly agent, `launchctl managername`
   reports the service's session; running it in Terminal only describes Terminal.
3. **User service still signed out:** ensure the intended user is logged in and
   their login Keychain is available/unlocked. Resolve any macOS Keychain prompts
   privately. Do not dump tokens, weaken Keychain access controls or replace
   credentials to work around the session boundary.
4. **Wrong auth/backend:** Jelly refuses conflicting `ANTHROPIC_API_KEY`,
   `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY` and
   enabled Bedrock/Vertex/Foundry overrides for the subscription provider. Remove
   unintended overrides from the service environment and restart. Do not print
   their values during diagnosis.
5. **Stale UI:** refresh Claude status after the service restarts. A local HTTP
   health check proves server readiness, not Claude subscription readiness.
