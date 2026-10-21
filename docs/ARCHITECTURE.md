# Jelly architecture

## Runtime boundaries

```text
React browser client
    | JSON requests + resumable server-sent events
Bun HTTP server
    | JellyService: runs, lifecycle, event publication
    | Harness: Pi AgentSession + provider + explicit tools
    | Store: bun:sqlite
SQLite: instance / agents / runs / messages / events / interventions
```

One data directory defines one instance. The instance UUID is created once and survives restarts. The default server binds to `127.0.0.1`. With `JELLY_TAILSCALE=1`, startup discovers explicit Tailscale IPs and creates additional native HTTP listeners sharing the same service, session state, fetch and WebSocket handlers. It never binds LAN or wildcard addresses. Network membership remains the access boundary; application-level remote owner authentication is still planned.

## Persistence contract

SQLite owns durable Jelly application state and parent model transcripts. The subagent package owns its child session/artifact files. Schema v4 adds archiving, working-context checkpoints and a paginated timeline separate from the retained replay log. The schema is versioned with `PRAGMA user_version`; startup applies initial schema creation transactionally and enables foreign keys, WAL, and a busy timeout. Indexed agent/time queries support snapshots; a partial unique index prevents concurrent active runs for one agent.

Each accepted prompt has a run ID and client-supplied request ID. Repeating the same request returns the existing run; reusing that ID with a different prompt or agent returns 409. Different agents may work concurrently.

The accepted user message, run, status, and initial events are committed together before execution starts. Pi `message_end` events persist raw messages. Tool start/end and turn completion create durable activity events. UI projections omit internal model thinking and partial text. Terminal run state and its event commit together. Events publish only after their database writes complete.

Schema v7 adds `pending_messages`, keyed by the client's request ID. Messages accepted during a run default to `queue`; successful run completion starts the next pending message in FIFO order. `steer` messages are submitted to Pi's core steering queue and become durable user transcript messages when Pi emits `message_start`. Promotion changes a pending message to `steer` without creating a second message. Snapshots include the selected agent's pending messages independently of paginated history. Pending messages arriving during startup or teardown remain tracked until consumed or started in a subsequent run. Stop, failure, and restart cancel pending messages with visible unsent entries; they never silently restart work.

Pi's `SessionManager.inMemory()` loads the latest successful working-context checkpoint from SQLite, retaining compaction summaries, entry IDs, kept messages and context edits. Legacy conversations bootstrap from completed raw messages. Checkpoints commit atomically with successful terminal run state; failed/cancelled/interrupted runs cannot replace them. Pi is responsible for the execution loop and tool semantics; parent sessions do not write a second transcript. Jelly identity, profile instructions and tool policies are appended to Pi's default system prompt, retaining upstream tool-use rules and documentation guidance. Harness intentionally passes an empty `systemPrompt`: in Pi 0.87.1 this bypasses `SYSTEM.md` discovery (nullish fallback) without replacing the default sections (truthy custom-prompt check). The supported `appendSystemPromptOverride` places Jelly policy before discovered `APPEND_SYSTEM.md` instructions; project context and skills follow through Pi's normal composition. Standard extensions, skills, prompts and context files are discovered, all built-in and registered tools are enabled, and project resources are trusted by default. Pi automatic compaction is enabled for model sessions. Summarized prefixes leave the working checkpoint while full raw messages and activity remain in SQLite.

Cancelled, failed, and interrupted runs stay visible in the activity history but are excluded from future model context. This avoids replaying unmatched tool calls or incomplete answers. The client can send a new message to continue with the last successful context. A user should restate any needed instructions from an interrupted run. There is no automatic rerun of tools.

On restart, previously running records become interrupted, with a durable interruption event and visible status. A graceful shutdown cancels active runs. Client disconnection never stops a run.

## Client protocol

All API responses use JSON except the event stream and VNC WebSocket. Errors have `{ "error": "message" }` and an appropriate HTTP status. JSON mutation bodies are limited to 64 KB.

| Method | Route                      | Behavior                                                                                      |
| ------ | -------------------------- | --------------------------------------------------------------------------------------------- |
| GET    | `/api/health`              | Health and instance ID                                                                        |
| GET    | `/api/state?agentId=…`     | Instance, agent list, selected agent activity/runs, connection availability, and event cursor |
| GET    | `/api/events?after=N`      | Durable activity events after cursor N, followed by live updates                              |
| POST   | `/api/agents`              | Create `{name, instructions?, color?}`                                                  |
| PATCH  | `/api/agents/:id`          | Update profile; rejects edits while running                                                   |
| POST   | `/api/agents/:id/messages` | Accept `{text, requestId, mode?: "queue" \| "steer"}`; return run metadata for immediate sends or pending message metadata |
| POST   | `/api/agents/:id/steer`    | Promote a pending message with `{messageId}` |
| POST   | `/api/agents/:id/stop`     | Stop the active run                                                                           |
| PUT    | `/api/config`              | Persist access mode, model and reasoning effort                                               |

Event frames have `id`, `event: activity`, and a JSON payload with `id`, `agentId`, `runId`, `type`, `data`, and `createdAt`. The `Last-Event-ID` header takes precedence over the `after` query on reconnect. Heartbeats keep idle connections open. Slow clients are disconnected and can replay from their last event ID.

Event types: `agent_created`, `agent_updated`, `config_changed`, `message`, `run_started`, `tool_started`, `tool_completed`, `turn_completed`, `run_completed`, `run_failed`, `run_cancelled`, and `run_interrupted`. `agent_archived`, `agent_restored`, `compaction_started` and `compaction_completed` also mark activity boundaries. No text-delta events cross the client boundary.

Clients first load a snapshot containing the latest 100 activity entries, then subscribe after its cursor. Older history uses `/api/agents/:id/history?before=N` with a stable exclusive event-ID cursor; each page includes associated runs and intervention records. SSE retains the latest 10,000 event IDs and replays batches of 512 with a one-MiB queue threshold. A cursor older than retained events or ahead of the instance receives `event: reset`; the client reloads its snapshot and reopens the stream. The separate timeline preserves all agent activity. The React client refreshes snapshots at activity boundaries and after reconnecting; snapshots remain authoritative. Themes and selected-agent preference are browser-local. Draft text remains in memory per agent until sent.

## Agent lifecycle and ownership

`POST /api/agents/:id/archive` and `/restore` preserve profiles, histories and working context. Archiving is rejected while the agent is running/waiting or still settling children; archived agents reject new prompts. `GET /api/agents/archived?after=ID` lists archived profiles in pages of 50. A snapshot may explicitly select an archived agent for history review, but the active sidebar filters it out.

`acquireInstance()` holds an exclusive transaction in `server-lock.sqlite` for the entire server lifetime. The directory is canonicalized to handle symlink aliases; duplicate ownership within the same process is also rejected. Startup failures and normal shutdown close the lock connection, and process death releases its OS lock. Never unlink the lock file while a server may own it.

## Providers

Pi `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` are pinned at 0.87.1. `ModelRuntime` owns model discovery, authentication, credential refresh and request dispatch. Native GPT-6 catalog entries and effort levels replace Jelly's prior compatibility overrides. SQLite schema v3 persists Astra/Sol and reasoning effort, with Astra/Medium defaults. All built-in and registered extension tools are enabled; standard resources load from the Jelly Pi directory and agent workspace. `pi-subagents` 0.71.0 supplies delegation through the native extension loader. [Capability research and integration](../plans_done/02-pi-capabilities.md) describes package selection, child lifecycle and automatic execution.

Automatic mode selects ChatGPT when configured, otherwise OpenAI API. With neither, the connection is not ready and new runs are rejected before messages or runs are persisted. Explicit modes require their selected credentials and never silently fall back. Legacy instances set to demo migrate to Automatic without changing historical conversations. No live credentials are automatically imported from unrelated applications.

The deterministic model exists only under `tests/fixtures/` and is explicitly injected by tests and the disposable design-preview script. Production has no scripted provider, demo mode, or environment-variable bypass. Tests still execute `instance_info`, emit real lifecycle events, and supply previous conversation context. The mock Responses server tests the actual OpenAI API and ChatGPT adapters separately, including request authentication, every offered model/effort combination, tool schema, and history transmission.

## Subagent observability

`Harness` binds a functional RPC extension UI, making Jelly an interactive Pi
host rather than a headless print invocation. Notifications/status/widgets are
bounded; unsupported dialogs cancel explicitly. This avoids the package's
headless `agent_end` drain. Launches default to `async:true` through Jelly's
wrapper, including existing installations; explicit `async:false` wins. New
package configs seed the same default without rewriting existing files.

`SessionWork` observes package lifecycle events, foreground tool updates and the
versioned session-scoped status RPC. Non-overlapping polling normally runs every
three seconds, backing off to thirty seconds on errors. Workflow files enrich
identity/session metadata; canonical snapshot activity overlays materialized
resumed children. Status reads require bounded regular files, matching run/session
ownership and stable no-follow descriptors. Missing/failed reads remain unknown,
not completed, and do not suppress other roots or periodic model checkpoints.

The same bounded projection feeds browser cards and a model-visible custom
message every `JELLY_SUBAGENT_HEARTBEAT_MS` (default 300000; range 1000–3600000).
Only one checkpoint can be pending; an idle parent wakes, while a busy one receives
it at a safe boundary. User steering remains enabled during child settlement.
Pi owns execution, supervisor delivery, native completion batching and descendant
liveness through `@agegr/pi-web/session-liveness/v1`. Jelly also accounts for its
own model continuations before disposing the parent. Notification ownership and
cancellation ownership are separate: workflow-owned children do not require
independent completion events, but remain stoppable after their workflow dispatch
finishes. A missing completion event can be reconciled with canonical terminal
status and an explicit parent wake, never silent success.

Schema v11 adds `subagent_views`: one compact snapshot plus a private source map
per Jelly run. Public cards use opaque IDs, capped at 128; raw session/artifact
paths and metadata errors are not public fields. A lane keeps its card identity
across attempts; a new concrete child run replaces its transcript source and
retired-attempt updates cannot reopen it. `subagents_updated` invalidates the
roster over SSE. Status/widget snapshots stay in bounded replay, not the permanent
chat timeline; full child transcripts remain package-owned files.

Both APIs require a control-session cookie and exact agent/run/child membership:

- `GET /api/agents/:agentId/runs/:runId/subagents`
- `GET /api/agents/:agentId/runs/:runId/subagents/:childId/transcript?before=N`

Clients never submit paths. The transcript adapter validates trusted canonical
roots, regular JSONL files and no-follow/stable descriptors; it reads at most
256 KiB and returns at most 100 entries/64 KiB with exclusive byte cursors.
It projects finalized assistant text, provider-exposed thinking and tool
arguments/results, excluding user/system/custom context, hidden/redacted
reasoning and signatures. Explicit paths in displayed tool content are retained.
Forked/headerless transcripts fail closed because the installed format provides
no authoritative inherited-context boundary. Inspection currently discovers
sessions under Jelly's configured child-session root; custom external session
directories, expired files and missing output produce explicit unavailable states.

The client renders one roster per run outside generic work disclosure. Expanded
transcripts alone poll; collapse/navigation/terminal-parent transitions cancel
reads. Stable IDs preserve disclosure state, older pages preserve scroll, and
nonoverlapping live tails reset to a contiguous excerpt with a valid cursor.
Paging is bounded to five earlier requests and 1000 visible entries. Historical
unsettled children become unknown after parent interruption, not falsely complete.
An opaque file/session generation scopes transcript byte IDs and resets excerpts
when a resumed attempt changes the source, even if byte offsets collide.

`bun run check` includes projection/lifecycle/security/API/UI regression suites,
an injected-clock five-minute real Pi model-turn test, and local-provider tests
with real package children covering foreground, concurrency, async/resume,
cancellation, model checkpoints, user steering and supervisor wake/reply.

## Runtime boundaries and current limits

Outstanding implementation and validation are tracked in [plans/](../plans/README.md); completed delivery records live in [plans_done/](../plans_done/README.md).

- One server owns each canonical data directory via an OS-backed exclusive SQLite lock acquired before application storage/recovery; separate directories can run independently.
- Snapshot history is paginated and replay retention is bounded. Raw conversation/timeline archives remain on disk and can grow with use.
- Runs are limited to 1,000 turns or five hours, whichever comes first. Reaching either limit stops the run and its background subagent work; model token limits can also terminate a run.
- Remote access, remote server authentication, TLS and hosted multi-user isolation are outstanding. Local model credential management is available in the settings UI.
- Connected Chrome is the only browser integration, using an extension/native host on Linux or macOS. Optional human-only desktop sharing has additional Linux/X11 requirements; see [Connected Chrome](CONNECTED-CHROME.md).
- Sudo depends on the host sudo policy and askpass support; automatic execution and password entry do not sandbox the program.

## Human interventions and desktop transport

Schema version 2 adds immutable intervention payloads with requesting agent/run, kind, status, creation/expiry times, and non-secret results. Pending requests keep their Pi tool call open while the agent status is `waiting`. Sudo first attempts non-interactive execution. Only an OS password requirement opens a handoff; its single-use request is consumed synchronously before password-authenticated execution. Denial, expiry, stop, and shutdown settle the waiting tool; executing requests abort their child and settle only after it exits. Startup interrupts pending/executing records rather than replaying them. Activity boundaries add `intervention_requested` and `intervention_updated`.

The sudo executor first launches an absolute executable and argument array with non-interactive `sudo -n`. When a password is required, it uses `sudo -k -A -- …` for the authentication handoff; it does not interpolate a shell command or retry ordinary command failures. A temporary owner-only directory contains an askpass helper and Unix socket. The password travels only through that socket and the helper's pipe to sudo, once. Command stdin is `/dev/null`, including when sudo grants NOPASSWD. Password buffers are cleared on completion; JavaScript/HTTP runtime copies are transient and cannot be guaranteed to be immediately erased. The executor redacts literal password occurrences before truncating captured command output. No password-bearing request bodies are logged or persisted. Execution has a two-minute limit; detached privileged children may outlive a command and cannot be generically rolled back.

`BrowserSessions` routes exclusively to `ChromeSessions`. The selected extension profile and site scope are captured per run and pinned after a successful task allocation. Browser tools bind agent/run identity server-side and operate only on owned task tabs and exact snapshot references. Profiles share existing cookies and signed-in accounts; task capabilities are not independent account isolation. Missing/disconnected profiles fail closed, without launching Chromium or choosing an alternate backend. Stale managed settings are ignored; legacy browser-profile directories remain untouched and unused.

Private sign-in pauses browser tools until explicit human handback in Chrome or its supported human-only sharing viewer. Native Mac desktop tools remain separate. Connected Chrome sharing retains its privacy latch, input cleanup and fixed Unix-socket VNC transport; there is no managed Computer panel, coordinate browser input, upload, diagnostics or clipboard API.

Control sessions use HttpOnly, SameSite=Strict cookies plus CSRF headers on mutations. Host, Origin and Fetch Metadata checks remain in force. Chrome-share tickets are single-use, expire after 30 seconds and bind to the owning control session and sharing generation. WebSocket forwarding rechecks authority in both directions and never proxies an arbitrary host/port. See [Connected Chrome security and lifecycle](CONNECTED-CHROME.md).

| Method | Route                            | Behavior                                                           |
| ------ | -------------------------------- | ------------------------------------------------------------------ |
| GET    | `/api/control-session`           | Establish browser session; return CSRF token                       |
| POST   | `/api/interventions/:id/approve` | Submit transient `{password}` for exactly one pending sudo request |
| POST   | `/api/interventions/:id/deny`    | Deny a pending handoff                                             |
| GET    | `/api/chrome`                   | Read connected profiles and the selected agent's task              |
| POST   | `/api/chrome/settings`          | Save the connected profile and site scope                          |
| GET    | `/api/chrome/share`             | Read human-only sharing state                                     |
| POST   | `/api/chrome/share/:operation`  | Explicit private sharing, tickets and handback                      |
| GET/WS | `/api/chrome/share/socket`      | Upgrade to the authorized Chrome desktop transport                 |

See [human intervention verification](../plans_done/02-interventions.md).

## Model connection settings

The React settings panel calls session/CSRF-protected `/api/auth/*` endpoints. `POST /api/auth/api-key` saves a literal OpenAI key through Pi’s locked credential store and selects API mode. The key is format-checked and never resolved as a command or environment-variable name. `POST /api/auth/remove` clears the selected stored provider, retaining environment-based configuration.

`POST /api/auth/chatgpt/start` selects device-code login in the installed Pi OAuth provider. A session-owned, in-memory login record exposes the status, one-time user code, and OpenAI verification URL only to its initiating browser. Pi polls OpenAI for approval; `/status` polls Jelly for completion and `/chatgpt/cancel` cancels it. No localhost callback listener or pasted callback URL is needed, including over Tailscale. Codes are cleared when login completes, expires, fails, or is cancelled. Device-code login must be enabled in the ChatGPT account security settings or workspace permissions. Only successful, non-cancelled flows persist credentials; late results after timeout/cancellation/shutdown are discarded. Raw provider failures are replaced with a generic error to avoid leaking token responses.

Credentials remain outside SQLite and durable events. Only the selected mode changes in the activity stream. The existing authenticated provider adapters use the same saved credentials on the next run. Tests cover automatic UI completion on local and Tailscale origins, private storage, session ownership, CSRF, cancellation, expiry, token redaction, and the installed Pi device-code request/poll/cancel path with mocked OpenAI responses.

## Private native HTTP listeners

Production `startApp` owns loopback and optional discovered Tailscale Bun HTTP listeners on one port. All listeners share the service, authentication/session store, exact host/origin checks, streaming events and Chrome-share WebSocket handlers. Partial startup failure closes every acquired listener and service. `scripts/serve.ts` supervises the backend only; no raw TCP piping is involved.

`bun run dev:tailscale` discovers this node's Tailscale IPs and DNS names and starts separate native Vite HTTP listeners on loopback and those explicit IPs at port 5173. The API stays on loopback at `JELLY_PORT` (3100 by default); Vite's existing HTTP/WebSocket `/api` proxy reaches it. Each Vite listener owns its native HMR WebSocket endpoint. There is no arbitrary TCP destination, LAN or wildcard listener.

The dev supervisor passes discovered origins through `JELLY_PUBLIC_ORIGINS`. Vite accepts exact configured hostnames and serves only frontend assets/SPA routes, not private data. Jelly accepts only the exact corresponding control origins and denies them to Connected Chrome tools. Session/CSRF checks remain intact; app URL registration never changes those origins. Request IDs support HTTP browsers lacking `crypto.randomUUID`. HTTP Tailscale is not a browser secure context; privately provisioned HTTPS aliases can be configured explicitly but Jelly does not provision TLS. Tailnet reachability from this host is not separate-device verification.

## Trusted Apps registry

Apps registers independently hosted owner-trusted HTTP(S) URLs as metadata, using `apps`, `app_launches` and `app_icon_assets`. Stable IDs/slugs, raster icons, attribution, explicit stars and history survive reopen. No app hosting, deployment, service manager, gateway, cookie rewriting, health probing or lifecycle state exists. Fresh schema creation retains unrelated versioned migrations and creates these metadata tables idempotently. The operator confirmed no existing apps/installations, so no Apps data migration or backward compatibility is supplied; old empty physical deployment tables are inert, not adopted.

React `/apps/:id` renders exactly the saved URL in an iframe. External Back to Apps restores launcher focus/scroll; only viewer entry records a deduplicated visit. The frame permits ordinary scripts/forms/storage/downloads, but denies practical top-navigation/popups and privileged feature permissions. This is not app isolation: ports separate browser origins but not cookies; same-host app servers may receive Jelly HttpOnly credentials or set interfering cookies. Apps are trusted transitively. Exact control-origin/CSRF protections and Jelly's unframeable policy remain; iframe compatibility depends on app framing headers, HTTPS and framed authentication. See [Apps product/trust contract](APPS.md).

## ChatGPT model WebSocket transport

ChatGPT subscription sessions explicitly select Pi's `websocket-cached` transport;
API-key sessions select SSE. These are server-to-model connections, not
browser-to-Jelly connections (the browser still receives durable SSE activity).

`ChatGPTTransport` assigns an ephemeral, per-agent provider session ID scoped to
one Harness. It differs from the persisted Pi conversation ID: disposing a Pi run
must not close the model connection needed by the next turn. The stream wrapper
retains Pi's authentication, request hooks and provider adapter. Pi checks request
settings and transcript prefixes before emitting `previous_response_id` with only
new input; tool results and refreshed instructions remain part of that input.
Full context is sent when continuation is unavailable or incompatible. No provider
response storage is enabled and no provider continuation state is persisted.

Failed/cancelled runs and switching an agent to a non-ChatGPT mode clear its
transport state. Idle state expires after five minutes; shutdown closes only this
Harness's connections, never another instance's. Pi handles expired response IDs,
connection renewal, and safe pre-output SSE fallback. Jelly reapplies run settings
after resource loading (which reloads settings from disk), preserving its explicit
transport and disabled automatic run-retry policy. ChatGPT responses are drained to completion before being exposed to Pi's agent
loop. A transient WebSocket disconnect (including 1006) can therefore discard
that incomplete generation and retry the same model input once via HTTP/SSE.
Completed tool results stay in the input; the whole run is never restarted, and
partial tool calls are never executed. SSE is used for the remainder of that run,
then its transport state is cleared so the next run can try WebSockets again.
Provider retries are capped at zero inside this wrapper to keep recovery bounded.
Cancellation, authentication/API errors, and a failed recovery remain hard exits.

Local WebSocket fixtures cover cross-run deltas, tool-result deltas, agent
isolation, model changes, instruction updates, reconnects, missing continuation
IDs, real abnormal 1006 termination, bounded HTTP recovery, discarded partial
tool calls, exactly-once earlier tool execution, cancellation and shutdown.
Existing HTTP fixtures verify
API-key requests and ChatGPT's pre-output SSE fallback without paid model calls.

## Subscription image generation

`generate_image` is a ChatGPT-only Pi tool registered by the Harness. It uses a
separate request-scoped WebSocket to the same Codex Responses endpoint, with
`ModelRuntime.getAuth` resolving/refreshing the existing subscription credential.
It requests the native `image_generation` tool with PNG output and `store:false`.
This keeps image events (not decoded by Pi's text adapter) out of the cached text
conversation socket. No API-key or HTTP fallback is performed for image jobs.
The response deadline is three minutes, with AbortSignal cancellation, frame and
aggregate byte limits, deduplication of output IDs, and a maximum of four images.
Partial-image events are ignored; files are written only after response completion.

Validated PNGs (max 20 MiB each, bounded dimensions) are saved under the instance's
private `generated-images` directory, with UUID filenames and mode 0600. A durable
`image_generated` activity contains only descriptors. A publish failure removes
new files. `GET /api/images/<uuid>.png` requires a control-session cookie, existing
host/origin checks, and refuses symlinks and non-PNG data. It uses private/no-store,
nosniff, and sandbox headers. No arbitrary filesystem path or remote URL is served.

The React gallery establishes the browser session before loading images. It has
loading/error/retry states, accessible alt text, and open/download links. Image
activity is a grouping boundary so it stays visible outside tool toggles. Markdown
embedding is restricted to the same generated-image route. Model transcripts carry
references rather than image blobs. Standard tests use deterministic local
WebSocket fixtures; a separate live smoke test generated a crab using the installed
ChatGPT subscription. Sources: [OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation).

## Fresh Session lifecycle

`POST /api/agents/:id/fresh-session` requires the control-session CSRF token and a
request ID. It creates an exclusive, cancellable run without appending a user/model
message. Repeating the request ID reuses the existing operation. Native Pi
`AgentSession.compact()` emits normal compaction activity and uses the same core
algorithm and hooks as automatic threshold/overflow compaction. Short conversations
use a temporary smaller retained-tail budget; empty/already-compacted sessions can
rotate without another summary request.

After successful compaction, Harness projects the normal working checkpoint into
a fresh in-memory SessionManager header. Disposal closes the old cached ChatGPT
transport. The new checkpoint, completed run, and durable `session_started` activity
are committed together. The next prompt creates its Pi runtime from that new
session identity and compacted context. Raw history and agent settings remain
unchanged; failure, cancellation, or shutdown never replace the prior checkpoint.
Queued prompts wait for completion, and steering is rejected during this action.

## Incremental conversation history

The client initially renders the latest bounded history snapshot. An upward scroll
near the top requests the next older cursor page and prepends it, rather than
replacing the conversation. Loaded pages and live snapshots merge by event/run ID;
current run and intervention records win. A visible activity anchor preserves the
reader's position through insertion. Requests are single-flight per navigation
generation, and late responses from a different agent selection are ignored.
Failures expose an explicit retry instead of repeatedly requesting on scroll.

Loaded history and reading positions are cached for agent switches within the tab.
While scrolled up, new messages stay at the bottom without pulling the reader away.
A 44px circular down-arrow button floats centered above the composer, has the
accessible name “Jump to bottom”, and returns to following live messages without
discarding loaded pages. The top load button remains as a keyboard-accessible
fallback and for short/non-scrollable pages.

### Stable layout while reading older messages

Image attachments reserve their frame before authentication or download starts.
New generated PNG descriptors include dimensions; legacy attachments without
metadata keep a square, uncropped contain-fit frame. Loading, errors, and retries
use the same frame, so decoding cannot push messages around. Image failures are
isolated per attachment rather than collapsing an entire gallery.

Jelly owns conversation scroll anchoring (`overflow-anchor: none`). In addition to
prepend correction, a ResizeObserver compensates for asynchronous content/viewport
changes while preserving the current visible activity, or follows the bottom when
already pinned there. Corrections preserve user movement since capture and skip
no-op scroll writes to avoid interrupting touch momentum.

`bun run test:history-scroll` builds the UI and exercises real desktop/mobile
Chromium layouts with delayed authentication, legacy/new landscape/portrait images,
failed downloads/retries, and asynchronous content growth above the viewport. It
uses temporary data and no model requests. Chrome defaults to `/usr/bin/google-chrome`
(or `CHROME_PATH`). Unit and component coverage also runs in `bun run check`.

## First-message agent naming

Schema v9 adds `agent_naming`, with persistent pending/manual/attempted/generated
states. Existing profiles are not enrolled. New placeholder profiles are pending
unless `nameEdited` records an explicit user choice. The first non-compaction run
claims the naming attempt in the same transaction that saves its first message;
queued/steering/replayed requests cannot issue a second naming call. Saving a
manual name cancels eligibility, including edits back to the placeholder.

Before creating that run's Pi session, Harness performs an isolated, tool-free
`ModelRuntime.completeSimple` call using the selected OpenAI provider/model and
existing credential refresh. It sends up to 4,000 characters of the first message,
uses minimal reasoning, a small output budget, no retries, and a ten-second timeout.
It does not use a fallback billing mode or append naming messages to model history.
Stop/shutdown cancel the call. Output must be a short plain display name; errors
leave the placeholder and allow the task to continue. A guarded database update
prevents a late result overwriting a manually saved name, then emits `agent_updated`
and builds the actual task session with the current name.

## Structured browser tools

`interventionTools` binds browser tools exclusively to the running agent's Connected Chrome session. Callers cannot select another agent. OpenAI API and ChatGPT use the same registration.

Supported tools are `browser_open`, `browser_screenshot`, `browser_snapshot`, reference-only `browser_click`, `browser_fill`, `browser_select`, bounded `browser_key`, task-local `browser_tabs`, `browser_scroll`, `browser_wait_for`, `browser_name_task`, `browser_keep_tab` and `request_browser_login`. There are no coordinate clicks, free typing, upload or diagnostics tools.

Snapshots expose bounded visible text and opaque element references without form values. References expire on navigation, tab changes and handoff; stale/foreign references fail rather than retargeting. Site-visible text can itself contain sensitive information. Never supply credentials as tool arguments: use private sign-in and explicit human handback.

The extension enforces profile generations, task-tab authority, site scope and exact Jelly control-origin denial. Operations already issued cannot be undone. See [Connected Chrome](CONNECTED-CHROME.md) for the current observation limits, input semantics, privacy boundary and cleanup behavior.

## Codex-style apply_patch

Harness registers a separate `apply_patch` tool alongside unchanged Pi native `edit` and `write`. Pi 0.87.1 advertises a FREEFORM Lark grammar on both `openai` and `openai-codex`; its internal schema has one required `patch` string. No shell or git-apply wrapper is involved. The vendored OpenAI Agents JS parser and Codex grammar retain pinned source revisions and MIT/Apache license notices under `src/server/vendor`.

```text
*** Begin Patch
*** Add File: notes.txt
+hello
*** Update File: source.ts
@@
-old
+new
*** End Patch
```

Add, update, delete and move use exact, unique, forward-only context matching without whitespace fuzz or EOF fallback. Whole-patch preflight rejects malformed/unconsumed syntax, duplicate/ancestor paths, overlapping hunks, ambiguous/stale inputs and unsupported text before mutation. Add and move destinations cannot overwrite existing entries. Existing BOM, LF/CRLF, missing final newline and POSIX modes are preserved; adds use LF and a final newline. Mixed endings, lone CR, NUL and invalid UTF-8 updates are rejected. Limits: 1 MiB patch, 1 MiB input/result file, 64 operations, 16 MiB combined before/after working set.

Paths retain full-host cwd semantics (absolute paths and `..` allowed); this is not a sandbox. Symlink path components and hardlinked sources are refused. In-process tool calls serialize and recheck identity/content, but native tools and external processes are not locked. External filesystem races, including ancestor replacement and final check-to-write/unlink intervals, remain possible.

Writes are **not transactional** and promise neither rollback nor durability. Pre-application cancellation writes nothing; cancellation or IO failure after mutation returns `partial`, completed operations and a mutation ledger (including directories, potentially truncated files and incomplete move destinations). Results contain a plain summary plus `details.status`, `changedFiles` (`path`, `kind`, optional `destination`, headerless Codex `diff`), `mutations` and optional `error`. Move-only/delete diffs are empty; metadata carries the operation. Only completed operations appear in `changedFiles`; consult the ledger for incomplete effects. The activity UI displays these details without implying atomicity. Synchronous syscalls cannot be interrupted; moves preserve modes, not ownership, ACLs, xattrs or timestamps. Standalone Pi subagent tool configuration is unchanged.
