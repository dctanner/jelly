# Pi capabilities and package research

Researched and integrated on 23 September 2026.

## Decision

Use Pi's native shell/filesystem tools and its package system for delegation. Jelly now pins `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` to **0.87.1**, the latest published SDK release checked on this date, and `pi-subagents` to **0.71.0**. No replacement filesystem tools or homemade subagent scheduler were needed. The new SDK includes the GPT-6 models and Max effort natively.

## Built-in tools

Pi supplies `read`, `write`, `edit`, `bash`, `powershell`, `ls`, `find`, and `grep`. Jelly previously passed a tools allowlist containing only its own workspace/browser/intervention tools. That allowlist is removed. All current built-ins and all registered extension/custom tools are activated. PowerShell also needs a PowerShell executable to actually run.

Pi's resource loader discovers extensions, skills, prompts and context files in Jelly's Pi directory and agent workspace. Jelly loads the bundled delegation package explicitly. The default configuration trusts project resources and runs tools without confirmation, as requested. Working directories organize files; they do not restrict filesystem access. See [Pi settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md) and [SDK integration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md).

## Subagent options researched

Downloads below are npm's counts for 23 August–21 September 2026, retrieved on 23 September. They measure downloads, not unique people or product quality.

| Option                                                                                                                              |     Downloads in period | Assessment                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)                                                               |                 455,454 | Selected: largest usage among the compared packages; foreground/background child sessions, workflows, cancellation, structured status and host integration.      |
| [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)                                                                |                  38,189 | Established alternative with parallel agents, steering, workflows and event-bus integration. Latest checked: 0.19.0, requiring Pi >=0.84.0.                      |
| [pi-sub-agent](https://pi.dev/packages/pi-sub-agent)                                                                                |                     538 | Small subprocess-based extension; single, parallel and chain execution. Latest checked: 0.1.5, documented Pi >=0.74 requirement.                                 |
| [Pi's official subagent example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent) | Not separately packaged | Upstream example with isolated child processes and cancellation. Useful fallback, but maintaining a fork would add work already handled by the selected package. |

Sources for counts: [pi-subagents npm statistics](https://api.npmjs.org/downloads/point/2026-08-23:2026-09-21/pi-subagents), [tintinweb npm statistics](https://api.npmjs.org/downloads/point/2026-08-23:2026-09-21/@tintinweb/pi-subagents), [pi-sub-agent npm statistics](https://api.npmjs.org/downloads/point/2026-08-23:2026-09-21/pi-sub-agent). The [Pi package gallery](https://pi.dev/packages/pi-subagents) independently displayed approximately 455.5K monthly downloads for the selected package. Popularity is evidence for ecosystem adoption, not proof of compatibility.

## Integration

Jelly uses Pi's new `ModelRuntime` for model access, OAuth login/refresh, API-key storage and logout. The existing auth.json shape remains supported. Startup is asynchronous. The previous custom GPT-6 registration and Max-effort mapping are removed. SQLite still owns Jelly's parent conversations and activity; the subagent package owns child session/artifact files.

`pi-subagents` loads through `DefaultResourceLoader.additionalExtensionPaths`, then binds in headless print mode. Its current public execution interface uses `workflowScript`/`runs.run`; older examples using top-level `agent` and `task` do not describe this release. Jelly favors foreground delegation, enables the complete registered toolset immediately, and initializes package authority decisions to `auto`. Built-in child-role overrides enable the full built-in tool list and inherit reasoning effort instead of the package's role-specific defaults. Parent model inheritance is retained.

Jelly's small event bridge projects child status transitions into SQLite/SSE without text deltas, waits for launched background work before completing a parent run, and sends package stop requests on cancellation. Extension shutdown runs before session disposal. See the package's [host integration API](https://github.com/nicobailon/pi-subagents/blob/main/docs/extension-api.md) and [observability documentation](https://github.com/nicobailon/pi-subagents/blob/main/docs/observability.md).

The server sets `PI_CODING_AGENT_DIR` to Jelly's data directory and identifies the installed SDK root for child processes. Package defaults live in `.jelly/settings.json` and `.jelly/extensions/subagent/config.json`; user edits to existing files are preserved. A normal npm installation uses Node for detached background runners, so Node must be available alongside Bun. Pi packages are described by a `pi` manifest and may also be installed with the standard Pi package manager into this directory. See [Pi package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

## Automatic execution

Jelly adds no tool approval prompts. Sudo first executes with non-interactive authentication. Only the specific sudo password-required response opens private password entry; a failed command is not automatically retried. Website login remains a human credential handoff when needed. These are authentication requirements, not general approval gates. Full shell/file access runs with the Jelly OS user's privileges; the managed-browser handoff does not isolate the desktop from arbitrary same-user shell commands.

## Verification

The upgrade is covered by existing model/effort, OAuth, credential persistence, conversation/restart, browser handoff and React tests. New integration coverage executes native file operations and bash (including a path outside the default workspace), runs the real subagent extension against a local Responses server, verifies model/effort and full child tools, cancels a foreground child, and verifies successful background completion. Sudo tests cover automatic execution and no retry after an ordinary command failure.
