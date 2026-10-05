# Subagent progress, inspection, and parent status updates

Status: implemented and verified. Service activation is pending an idle restart.

## Delivery

- Interactive RPC host binding and async launch defaults retain Pi's native
  scheduling, supervisor channel, completion batching and liveness ownership.
- Bounded per-run rosters, session-owned transcript APIs, SQLite v11 history
  snapshots and visible extension notices are integrated.
- Five-minute model checkpoints, idle-parent steering, terminal reconciliation,
  attempt correlation and cancellation ownership have regression coverage.
- Final `bun run check` passed: **338 tests**, TypeScript and production build.
  Independent lifecycle and security/UI reviews found no remaining blockers
  after fixes and regression coverage.
- A real Chromium fixture at 390×844 verified visible cards, expanded thinking
  and tools, no horizontal overflow and no page errors.
- Inspection shows finalized provider-exposed content. Forked/headerless
  transcripts and external/custom session directories remain explicitly
  unavailable; no hidden reasoning or raw session metadata is exposed.

Implementation details and limits: [architecture](../docs/ARCHITECTURE.md#subagent-observability).
Final review workflow: `14c7a308-cbf5-4287-b1b6-399565a1edbb`;
reports are retention-managed under `.pi/subagents/artifacts/outputs/`.
The research below records the pre-implementation baseline.

Research baseline: installed Pi **0.87.1**, `pi-subagents` **0.71.0**, Jelly working tree on 2 October 2026. Installed source is authoritative here; upstream main may differ.

## Requested behavior

1. Long-running delegation must not look like a frozen chat.
2. While children are active, give the parent model a compact status digest approximately every **five minutes**, plus immediate actionable failure/supervisor notifications.
3. Show each running subagent in the conversation. Clicking it opens its task, status, provider-exposed thinking, assistant messages, and tool calls/results.
4. Handle direct children, concurrent children, dynamic workflow steps, and resumed children without duplicate cards or false completion.

## Findings

### Jelly already runs real Pi children, but loses most observability

- `src/server/harness.ts` loads `pi-subagents` through `DefaultResourceLoader` with a per-session event bus. Parent sessions use `SessionManager.inMemory()` and SQLite checkpoints. Child session/artifact files belong to the package.
- It binds extensions with `session.bindExtensions({ mode: "print" })`, without an extension UI adapter.
- Jelly's appended instructions explicitly prefer foreground workflows (`async:false`). `src/server/pi-setup.ts` also seeds `asyncByDefault:false`, `fleetView:false`, and `asyncWidget:false`. Existing configuration files are deliberately not overwritten; changing seed defaults alone will not migrate installations. The current local config also has `asyncByDefault:false`.
- `src/server/service.ts` records `tool_execution_start` and `tool_execution_end`, but **does not handle `tool_execution_update`**. Pi's foreground child progress snapshots therefore never reach the browser.
- `src/server/session-work.ts` forwards three event families: async starts, async completion, and child-status hints. Its field allowlist drops `childId`, `childRunId`, task/label, timestamps, current tool, activity, and transcript/session references. These events are not a continuous progress feed.
- `src/client/App.tsx` renders only `Subagent <agent> · <status>`. `WorkActivity.tsx` places these notes inside generic work disclosure. There is no per-child card, roster, inspection endpoint, or transcript view.

### Evidence of apparent freezing, not necessarily stopped execution

Read-only inspection of local activity metadata at approximately **12:20 UTC, 2 October** found:

- Jelly run `cde2de89-cf2f-4bc4-8c72-f0dd3ecb4eba` still marked running, with last recorded chat activity at **11:46:51 UTC**.
- Its workflow `9b4d29e1-475e-4611-b083-56ef124bc031` still reported running in its canonical `status.json`.
- The `backend` child reported completed; `mobile` reported running with activity updated around **12:20:22 UTC**.

Thus, that snapshot shows over 30 minutes of chat silence despite fresh child activity. It does not prove that every reported stuck turn has the same cause. No runs were stopped, steered, or restarted during this investigation.

### There are two separate parent-blocking mechanisms

**Foreground calls:** the parent cannot make another model request until the pending subagent tool call finishes. A timer can update the browser, but a steering message cannot make the model execute in the middle of that tool call. This also creates a risk when a child requests a parent decision while its parent is blocked awaiting it.

**Headless auto-drain:** `pi-subagents/src/extension/index.js` awaits `drainOutstandingWork()` in `agent_end` whenever `ctx.hasUI` is false. Jelly's print binding takes this path. The drain normally waits for owned work, with a 30-minute deadline and special handling for supervisor requests. Pi keeps the run active while executing this hook; messages arriving then can queue without being consumed until the hook returns.

Consequently, **async launches plus a five-minute timer are not sufficient by themselves**. The parent can still be blocked in headless draining after yielding its answer.

### Jelly's settlement bridge needs stronger reconciliation

`SessionWork.settle()` waits on an event-populated `Set` at 50 ms intervals, then calls `session.waitForIdle()`. It neither queries canonical status nor has its own progress/error reporting. A missing completion event can leave it waiting until the outer five-hour Jelly limit.

A previous fix already excludes workflow-owned resumed children from this independent-job set (`3db0b32`, “Fix stuck turns after workflow-owned subagents finish”). Keep that distinction: the workflow owns those children’s result delivery.

Further risks to test, not asserted incident diagnoses:

- completion notifications can be batched after a completion event; removing a job from the set is not proof the model has consumed its result;
- disposal must not race with pending completion delivery or heartbeat-triggered parent continuations;
- parent user steering is currently disabled after the original `session.prompt()` returns, even if `harness.settle()` is still retaining the session for children;
- runtime extension errors have no explicit `bindExtensions({ onError })` projection into Jelly's activity UI.

## Relevant Pi/package capabilities

| Capability | Existing interface | Fit / limitation |
|---|---|---|
| Live foreground progress | Pi `tool_execution_update`, package `details.results` / `details.progress` | Wire into Jelly; replace snapshots, do not append every update as a new card. Streaming results omit full message history. |
| Session-scoped status | Event-bus RPC `ping`, `status` | Already shares Jelly's `SessionWork.bus`; extend its RPC helper to return `reply.data` rather than discarding it. |
| Async tree | RPC `status` → `data.asyncSnapshot` | Versioned, bounded root/child IDs, states, current tool, last activity, timing, tool/turn counts. Includes truncation/omission information. |
| Fleet summary | RPC `status` → `data.fleet` | Agent/model/effort/goal/tokens; keys are **opaque display identities**, not control/run IDs. Do not use these keys to inspect/stop a run. |
| Lifecycle hints | `subagent:async-started`, `subagent:child-status`, completion/control events | Good immediate invalidations; may duplicate and are not replayed after host restart. Status is authoritative. |
| Async inspection | `/subagents-inspect-rpc <requestId> <asyncId> [childId] --lines N` | No model turn; emits a correlated `PI_SUBAGENT_INSPECT_JSON:` widget then retracts it. Session ownership checks, 200-message limit, 64 KiB serialized cap. Requires a functional UI context; current print binding makes it a no-op. |
| Model injection | `session.sendCustomMessage(..., { triggerTurn: true, deliverAs: "steer" })` | Wakes an idle parent or queues at a safe boundary. Cannot preempt an open tool or awaited headless drain. `display:false` does not mean excluded from model context. |
| Native completion wakes | Package `subagent-notify` custom messages | Retain these; no polling subagents or blocking `bg_wait` needed for ordinary async work. Successful completions are briefly batched. |
| Attention detection | Launch/config `control` thresholds and notifications | Useful for blockers, **not a periodic heartbeat**. Active-long-running defaults to four minutes, is latched, and the installed parent notice handler explicitly ignores `active_long_running` events. Foreground notices are also suppressed. |
| Watchdog | Opt-in second-model boundary/tool-count review | No idle timer reviews; not the requested five-minute status mechanism. |
| Schedules | `schedule.create` | Schedules workflow execution, not passive observation. Wrong tool for this feature. |
| `bg_wait` | Blocking window or explicit non-blocking subscription | Appropriate for providers/detached jobs without native wakes, not a substitute for the host status loop. |

### Important inspection gap: thinking and full tool details

The installed inspect reply supports `text`, `toolCall`, and `toolResult`, **not thinking**. Its session parser skips normal `thinking` blocks and produces truncated tool previews; it does not provide a complete, stable-ID tool execution timeline.

Therefore an inspect-widget bridge alone cannot fulfill the requested child transcript UI. Options:

1. Prefer a supported upstream inspection enhancement for displayable thinking and stable message/tool identities.
2. In Jelly, add a narrow, tested child-transcript adapter reading only package-recorded session/transcript files for the owning parent. The package documents these artifacts for host consumers. Parse their versioned records; do not import unexported package internals.

Expose only provider-supplied, non-redacted thinking text, matching Jelly's existing parent behavior. Never expose reasoning signatures, encrypted/redacted blocks, or invent hidden reasoning. Say “No thinking summary available” when absent. Start with finalized message records; true token-by-token child thinking would require an additional streaming projection and should not be promised from the current inspection DTO.

## Recommended design

### 1. Make Jelly a real interactive SDK host for orchestration

- Keep the in-process Pi SDK; do not replace the runner or implement a second subagent scheduler.
- Bind a real non-TUI extension UI adapter with `mode:"rpc"` and `uiContext`, following Pi's RPC UI semantics. Jelly is an interactive web host, not a one-shot print invocation.
- Implement supported widget/notification delivery and safe dialog handling. Unsupported interactions must explicitly fail/cancel, not approve or hang. Use shared `ChatFormCard` components for any actual forms.
- This makes `hasUI` truthful and avoids headless auto-drain in the **parent**. Child runtimes can retain their existing headless behavior. Merely changing `mode` without a UI context will not fix the drain.
- Prefer top-level `async:true` for orchestration; remove the contradictory foreground preference and migrate the existing default deliberately. Retain explicit foreground support for intentional short blocking work, with live UI progress.
- Keep one Jelly active run/session alive across parent yields, native completion wakes, and heartbeat continuations until children and parent work are genuinely settled. Do not report completion just because the initial prompt resolved.

If maintaining print mode is required, request a supported package host-lifecycle option that disables parent auto-drain while Jelly takes explicit ownership. Do not monkey-patch internal listeners or supply a dummy UI only to spoof `hasUI`.

### 2. Maintain one bounded child-status projection

In `SessionWork` (or a dedicated observer), combine lifecycle hints, foreground tool updates, and RPC status snapshots.

- Negotiate capabilities with `ping`.
- Poll status roughly every 2–5 seconds while there is active work; also refresh on lifecycle changes. Use non-overlapping requests and backoff on failures.
- Keep server-side observation independent of whether the browser is open. Browser visibility can reduce transcript reads, not lifecycle supervision.
- Identity includes Jelly agent/run, Pi parent session, package root run, and stable child identity. For workflows use the stable key/child run ID; for foreground results the documented `(runId,index)` tuple is available. Preserve attempts/resume lineage separately.
- Do not infer completion from absence in a bounded snapshot. Respect omission counts; reconcile known roots with targeted status.
- Keep “last observed activity” separate from “status checked at.” File `lastUpdate` is not a reliable heartbeat: a long quiet tool need not rewrite the status file. A workflow root may use the host process PID, so process existence alone does not prove that workflow is progressing.
- Expose queued/running/completed/failed/paused/stopped states plus separate attention/unknown indicators. Show “No recent activity” rather than claiming a deadlock.
- Persist compact child identity/terminal records for refresh/history. Stream coalesced live changes through existing SSE; avoid filling SQLite with full transcripts or duration-only ticks.

### 3. Send the parent one compact digest every five minutes

Use the same projection, not a new monitoring agent or model-generated summary.

Example:

```text
Subagent status (5-minute check): workflow …
backend: completed; result ready.
mobile: running for 18m; current tool bash (22s); last activity 3s ago.
review: queued, waiting on mobile.
No supervisor requests. Work remains active; do not relaunch it.
```

- Default interval: 300,000 ms, configurable.
- Include IDs usable for status/control, totals/omitted children, current action, elapsed/tool duration, activity age, and changes since last digest.
- Failures and supervisor requests remain immediate through native notifications. Deduplicate equivalent host notices; do not delay them until the timer.
- Use a custom message, not a fabricated user message. It should invite inspection/action if necessary, not automatically interrupt, restart, or duplicate work.
- At most one heartbeat pending/in flight per parent. Coalesce newer observations until delivery; do not queue repeated stale digests behind a long foreground call.
- Treat five minutes as the notification cadence, not a guarantee that the model can interrupt a tool. UI status continues independently.
- Tie timers and continuations to run identity; cancel on stop/disposal/session replacement. Await/account for triggered parent work before settlement.

### 4. Show subagents directly in chat

An active roster should be visible without expanding the generic “Working” section:

```text
Subagents · 2 running · 1 complete
▸ Worker · Backend changes   ✓ Complete
▸ Worker · Mobile layout    ◌ Running · read · active 3s ago
▸ Reviewer · Final checks   ◷ Queued
```

- Group children under their workflow; direct launches get the same child card, without an unnecessary workflow wrapper.
- Show meaningful bounded task/step label, agent, state, elapsed time, current tool, and activity freshness. Do not display “workflow” as though it were another child agent.
- Click/keyboard-expand in place to show task, available thinking, assistant messages, chronological tool calls/results, errors, and final output. Preserve expansion and scroll position while updates arrive; do not steal focus.
- Fetch transcript details only when opened, then refresh incrementally while active. Provide bounded pages/load-earlier and explicit truncation/unavailable states. Stop fetching on collapse, navigation, or terminal state.
- Preserve completed cards/history. If temp artifacts have expired, show the saved summary and a clear transcript-unavailable message.
- Reuse existing tool/thinking presentation rather than rendering raw package JSON or terminal escape sequences. No modal focus trap for transcript inspection; keep mobile touch targets and existing motion conventions.

### 5. Safe inspection and trustworthy settlement

- Add a session-owned status/transcript API; clients submit opaque child identifiers, never filesystem paths. Validate parent/child ownership and recorded canonical paths on the server; constrain reads against traversal/symlink escape, cap bytes/records, and tolerate partially written final JSONL lines.
- Persist the minimal ownership map needed to inspect historical children after the in-memory parent is disposed. Do not let one agent enumerate another's sessions.
- Keep raw provider fields and secrets out of public DTOs. Tool arguments/results need the same sensitive-data/display treatment as parent tools; never indiscriminately stream raw session files.
- Reconcile event-tracked jobs with package status. A failed status request is an observable “unknown” condition, not permission to mark the child done.
- Observe Pi `agent_settled`, outstanding package work, queued/pending completion delivery, and host-triggered continuations. Resolve batching/disposal races explicitly; a fixed sleep is not a lifecycle guarantee.
- Project runtime extension errors and reconciliation failures visibly. Keep the workflow-owned-child exclusion and exact ownership on cancellation.

## Suggested delivery order and acceptance tests

1. **Progress bridge + cards:** capture foreground updates, async snapshots, stable identities, SSE and reconnect hydration. Test two concurrent children, dynamic workflow children, queued and resumed children, duplicate/out-of-order hints, and snapshot truncation.
2. **Inspection:** bounded child transcript API and expandable chat detail. Test provider-exposed thinking vs redacted/signature blocks, paired tools, malformed/partial JSONL, expired artifacts, cross-agent denial, traversal/symlinks, refresh, keyboard and mobile behavior.
3. **Interactive lifecycle + heartbeat:** real SDK UI adapter, async preference, persistent parent ownership, five-minute digests. Use fake time and local model fixtures to verify that the model actually receives the digest and makes a continuation while children remain active—not merely that a message was queued.
4. **Settlement hardening:** missing/duplicate completions, successful completion batching, final wake racing disposal, stop during a digest, cancellation during child tools, supervisor requests while the parent is yielded, restart/recovery, silent long tools, and extension errors.

Run the full `bun run check` before deployment. Schedule activation through the idle-restart helper only after implementation/review; this research did not change runtime configuration or restart Jelly.

Research verification: `bun test tests/session-work.test.ts` — **4 passed**, including workflow-owned resumed-child exclusion. This is existing unit coverage, not verification of the proposed heartbeat or UI.

## Sources

Local integration:

- `src/server/harness.ts`, `src/server/pi-setup.ts`, `src/server/session-work.ts`, `src/server/service.ts`
- `src/client/WorkActivity.tsx`, `src/client/App.tsx`, `docs/DESIGN.md`
- `tests/session-work.test.ts`, `tests/capabilities.test.ts`, `plans_done/02-pi-capabilities.md`

Installed documentation under `node_modules/`:

- Pi `docs/sdk.md`, `docs/extensions.md`, `docs/rpc-extension-ui.md`; `examples/sdk/06-extensions.ts`
- pi-subagents `docs/observability.md`, `docs/extension-api.md`, `docs/configuration.md`, `docs/tool-reference.md`, `docs/watchdog.md`

Installed implementation details checked:

- Pi `dist/core/agent-session.js`: `sendCustomMessage`, `_runAgentPrompt`, `_handlePostAgentRun`, `bindExtensions`; `dist/core/extensions/runner.js`: `hasUI`
- pi-subagents `src/extension/index.js`: headless `agent_end` drain; `src/runs/background/auto-drain.js`
- `src/extension/rpc.js`, `src/runs/shared/async-status-projection.d.ts`
- `src/runs/background/inspect-rpc.{js,d.ts}`, `src/runs/background/fleet-view.js`, `src/slash/slash-commands.js`
- `src/runs/foreground/execution.js`, `src/runs/shared/subagent-control.js`, `src/extension/control-notices.js`, `src/runs/background/notify.js`

Upstream reference locations (links for navigation, not claims that main matches the installed release):

- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md
- https://github.com/nicobailon/pi-subagents/blob/main/docs/extension-api.md
- https://github.com/nicobailon/pi-subagents/blob/main/docs/observability.md
