# Repeating agents / scheduled tasks

Status: implemented and verified in source; live activation remains pending. No live schedules were created, and the service was not restarted.

## Implementation and verification

The v1 implementation includes schema v17 persistence, timezone-aware timing, durable occurrence admission/recovery, six scoped agent tools, authenticated management APIs, schedule controls/history, and labelled automated user messages. It continues the existing agent conversation rather than creating new sessions.

Independent review checked admission/recovery and the full implementation. Its steering-context, bulk-pause, and execution-history findings were fixed with regressions. The parent also reproduced and fixed the final pending-history note, including both cancellation after a mutation and expiry discovered by polling.

Verification on the final source:

- `bun run check:full`: passed in an isolated source copy, including TypeScript, 699 Bun tests, 11 Python tests, and both client/Chrome builds. Live `dist` was not changed.
- `bun run test:schedules`: 40 tests pass; OpenAI/session-reuse regression tests also pass.
- Isolated Chromium schedule controls passed at 320×740, 390×844, and 1280×900. These are this-host fixtures, not real-device checks.
- No commit, live schedule creation, database reset, restart, or deployment was performed.

Implemented refinements:

- One-offs retain exact offset-bearing timestamps, including seconds. Minute resolution applies only to five-field cron.
- Tool declarations remain stable for provider/session reuse. Before interpreting relative times, the agent reads `schedule_list.requestContext` for the delivered request's ID, timestamp, timezone suggestion, and current server time. Steering advances this context only after delivery, never on enqueue; mutation provenance is bound by the server.
- Limits apply to active/paused schedules: 100 per agent and 1000 per instance. Terminal history is retained and paginated.
- Scheduled concurrency defaults to 2 (`JELLY_SCHEDULE_CONCURRENCY`, range 1–16); polling defaults to five seconds. Lateness defaults to 24 hours, configurable from 60 seconds through 24 hours.

Remaining release work: explicitly activate through the project's idle-restart procedure, then verify loopback/Tailscale/private HTTPS and same-origin control-session behavior. Real-provider natural-language scheduling, real remote/mobile devices, and unattended private-control workflows have not been qualified. The detailed contract below records the implemented direction; deferred features remain out of scope.

## Goal and product model

A user can ask an existing Jelly agent to do a task once in the future or repeatedly on a cron schedule. At the appointed time Jelly starts a normal run in that agent's existing conversation, with a **user-role message** containing both an explicit automated-wake notice and the stored task prompt.

“Repeating agent” is a normal persistent agent with one or more schedules, not a separate agent type, subprocess, or new conversation per execution. Its history, instructions, project, working directory, and current provider/model/effort continue to apply. Users can still chat with it normally.

Examples:

- “Tomorrow at 9am, check whether the release shipped.”
- “Every weekday at 8:30am, summarize open pull requests.”
- “Run `0 9 * * 1` in Europe/London: review this week's priorities.”
- “Pause that daily review” / “Change it to 10am” / “Cancel it.”

Scheduling does not itself perform the task immediately. Creating a schedule returns a durable receipt with its ID, stored prompt, resolved timing, timezone, and next execution.

## Recommended v1 decisions

| Area | Behavior |
| --- | --- |
| Ownership | Jelly owns durable schedules for Jelly agents. Do not use OS crontab, long-running shell sleeps, or session-local timers as storage. |
| Supported timing | Exact one-off absolute timestamp; standard five-field cron with an explicit IANA timezone. Cron has minute resolution and no seconds field, commands, or arbitrary JavaScript. |
| Interpretation | The agent interprets natural language; server validation accepts only structured timing. Ask about genuinely ambiguous time/date requests. |
| Conversation | Continue the same persistent agent session; no automatic Fresh Session or cloning. |
| Busy agent | Wait without steering or interrupting. Never run two turns concurrently on the same agent. |
| Overlap | At most one outstanding occurrence per schedule, including queued and running work. While one is outstanding, skip later ticks and record why. |
| Downtime | By default, deliver at most the latest missed occurrence if it is no more than 24 hours late. Expose `catchUp: latest | none` and a bounded lateness window; preview both in the receipt. |
| Retry | Retry safe pre-admission delivery failures with bounded backoff. Never automatically replay a run that was accepted, failed, cancelled, or interrupted. |
| Context/settings | Resolve current agent settings at run admission; retain the actual run settings in normal run records. |
| Lifecycle | Archiving pauses schedules and cancels unstarted occurrences. Restoring does not silently re-enable them. |
| Availability | Works while Jelly is running, even with no browser connected. Cannot wake a powered-off/sleeping host; no promise of exact real-time delivery. |

These defaults are implemented. Show late-execution behavior prominently, especially for time-sensitive one-off requests.

## Existing implementation and integration points

- `src/server/service.ts`: `start()` / `startRun()` validate the agent and connection, persist messages and runs, restore context, execute `session.prompt()`, then settle children and checkpoint. Reuse this lifecycle, including its existing run limits and privacy/tool boundaries.
- `src/server/store.ts`: SQLite/WAL, unique run `requestId`, and `idx_runs_active_agent` already provide useful admission invariants.
- `pending_messages` is the interactive message queue. `Store.recover()` cancels it at startup; the service also cancels it after failed/stopped runs. **Do not simply insert future work into this table and assume it survives.**
- `src/server/app.ts` owns authenticated API routing, startup, and shutdown. Start the scheduler only after instance ownership and normal store recovery; stop it before service shutdown closes the database.
- `src/server/service.ts` injects run-scoped tools, offering a suitable integration point for schedule tools.
- `src/server/session-work.ts` handles active-session child/background work. It is not a durable calendar scheduler; leave its completion and steering wakes separate.
- `src/server/pi-setup.ts` currently configures a subagent package's scheduling permission. That is not evidence of Jelly-agent scheduling support. Clearly distinguish the new tools from package-owned child scheduling; no automatic import or duplicate dispatch.
- `src/shared/types.ts`, `src/client/api.ts`, and the existing activity stream are the shared API/UI surface.

## User and agent workflow

### Creation from chat

1. User requests future or repeating work.
2. Agent reads `schedule_list.requestContext` before resolving relative times and timezone. Use the delivered request's timestamp as the relative-time anchor, and its browser's IANA timezone as a suggestion when available; otherwise use a saved instance timezone. Fetch context again after steering delivery. Do not infer the user's timezone from the server OS. Ask if neither is established.
3. Agent calls `schedule_create` with a title, self-contained stored prompt, structured timing, and a stable idempotency key.
4. Server validates and commits, returning the canonical schedule and upcoming times.
5. Agent reports, for example: “Scheduled weekdays at 08:30 Europe/London. Next: Tuesday … . I'll run this here. [View / Pause / Cancel].”

An explicit user request is enough to create the schedule; no mandatory second confirmation. Do not claim success before persistence succeeds. A tool error must leave the agent able to explain that nothing was scheduled.

The prompt should preserve the user's actual intent and relevant inputs rather than “do the thing above.” Store text, not a precompiled shell command or a copy of the whole conversation. Do not store credentials; reference existing connections. Attachment scheduling can be deferred until durable attachment references and retention are defined.

### Tools and APIs

Proposed tools: `schedule_create`, `schedule_list`, `schedule_update`, `schedule_pause`, `schedule_resume`, `schedule_cancel`.

- Tools are scoped to the current persistent agent by the server, not an arbitrary model-supplied agent ID.
- Record the creating/updating run and original request provenance when available.
- Stable mutation request IDs deduplicate retried tool/API submissions; changing payload with the same key returns a conflict.
- Use expected revisions for updates, pause, resume, and cancel to prevent stale UI/tool actions overwriting newer decisions.
- Return timezone, lateness policy, status, next run, and preview of the next three cron times.
- A scheduled wake is an instruction to execute the stored task, not permission to create another copy of its schedule. Include that distinction in tool guidance and wake text.
- Follow the user's scope for schedule changes; tasks and retrieved webpages cannot independently authorize new recurring work.

API shape:

- `GET/POST /api/agents/:agentId/schedules`
- `GET/PATCH /api/agents/:agentId/schedules/:scheduleId`
- `POST .../:scheduleId/pause`, `/resume`, `/cancel`
- `GET .../:scheduleId/occurrences` with pagination
- A validation/preview endpoint using exactly the same timing code as creation.

All routes inherit existing control-session and same-origin mutation protections. Only an internal server path can supply `source: schedule`; an ordinary client message cannot forge scheduled provenance.

### UI

- Agent menu entry: **Schedules**, with an active-count indicator and next-run summary.
- List shows title, human timing, timezone, next run, state, and latest outcome. Details show the full stored prompt and execution history.
- Offer edit, pause/resume, and cancel, without requiring an available model. No separate task-management destination is needed for v1.
- In chat, render automated user messages as **Scheduled task**, not as a human-typed message. Show scheduled and actual start times, lateness, and a link to the schedule.
- Use `ChatFormCard` / `ChatFormActions` for inline forms and receipts; follow `docs/DESIGN.md` for mobile controls, focus, and motion.
- Reuse ordinary assistant-completion and intervention notifications. Add actionable schedule-blocked/expired notices without repeatedly notifying every poll.
- Pause/cancel must say whether a run already started. Offer the existing Stop action separately.

## Wake message contract

The server generates the envelope; the saved prompt remains verbatim. Persist the final text before handing it to the model.

Example user-role message:

```text
[Automated scheduled wake — Jelly]
You were awakened automatically to execute a task previously scheduled by the user.
This is not a new live message from the user.

Schedule: Weekday PR review (sch_…)
Occurrence: occ_…
Timing: 30 8 * * 1-5, Europe/London
Scheduled for: 2026-10-13T08:30:00+01:00
Started at: 2026-10-13T08:32:10+01:00
Reason: scheduled execution; delayed while this agent was busy

Execute the stored task below now using your current conversation context.
Do not schedule another copy merely because this wake occurred.
Normal tool permissions and private handoff requirements still apply.

--- Stored task ---
Summarize open pull requests for this project, prioritizing those awaiting my review.
```

Separately persist structured metadata: `source`, `scheduleId`, `occurrenceId`, schedule revision, `scheduledFor`, `admittedAt`, wake reason, and task snapshot. UI and auditing use these fields, never parsing the envelope or trusting a text prefix. `admittedAt` means Jelly accepted the run, not the exact instant the provider began generating.

Include source metadata on message and run activity events and retain it in historical replay. Old events without metadata remain ordinary messages. Do not make the stored prompt a system instruction.

## Persistence

Add a versioned SQLite migration; use the next available schema version at implementation time.

### `agent_schedules`

- Identity: `id`, `agentId` foreign key, `title`.
- Task: `prompt`, `revision`, `createdByRunId` where applicable.
- Timing: `kind: once | cron`, `runAt` (UTC) or `cron`, `timezone`.
- Policy: `catchUp`, `maxLatenessSeconds`.
- Lifecycle: `state: active | paused | completed | cancelled | expired`, pause/cancel reason.
- Cursor/audit: `nextRunAt` (UTC), `createdAt`, `updatedAt`, last dispatch error and safe retry timing.

Constrain timing fields by kind; index active schedules on `nextRunAt`. Completed one-offs remain visible with their occurrence outcome, including failures; completion means the one-off was consumed, not that the task succeeded.

### `schedule_occurrences`

- `id`, `scheduleId`, `scheduleRevision`, `agentId`.
- `scheduledFor` (UTC), immutable task/timing/policy snapshot.
- `state: pending | running | completed | failed | cancelled | interrupted | skipped | expired`.
- Stable unique admission `requestId`, nullable `runId`, admission/finish times.
- `wakeReason`, structured skip/error reason, bounded delivery attempt count, `retryAt`.

Use a unique `(scheduleId, scheduledFor)` key, unique request ID, and a partial unique constraint allowing only one pending/running occurrence per schedule. Coalesced downtime periods can have one bounded summary event rather than millions of skipped rows. Keep enough history to audit dispatch and cancellation; paginate it. Never prune outstanding records or remove deduplication keys within the recovery horizon.

The schedule cursor and creation/skipping of an occurrence are updated in one transaction. Later edits never mutate a running or historical occurrence's prompt.

## Scheduler and run admission

Implement `src/server/scheduler.ts`, backed by a small schedule store/service rather than expanding the calendar logic inside `JellyService`.

1. Poll due schedules with an injected clock and bounded batch size, e.g. every 5 seconds; also wake after schedule changes or agent completion. Timers are only hints; SQLite is authoritative.
2. Calculate due instants in the stored timezone. Atomically create an occurrence and advance `nextRunAt`; duplicate polls become no-ops.
3. Pending occurrences remain in the durable occurrence queue while the agent is busy. Interactive messages already queued take precedence. Scheduler work must not enter the interactive queue and be mistaken for a disposable user draft.
4. At idle admission, recheck schedule state/revision, agent archive state, lateness, service closing state, provider readiness, and capacity.
5. Refactor run admission into a synchronous transaction and a post-commit execution step. In one transaction, create the normal run, delivered user message and metadata, link the occurrence, and mark it running. **Do not launch model/tool work from inside an uncommitted outer transaction.**
6. Execute through the existing harness and normal settle/checkpoint path. Map the final run outcome onto the occurrence in the run-finalization transaction.

Reuse the existing active-agent guard plus the database's unique running-agent constraint. Serialize admission against interactive `start()`, Fresh Session, archive, and stop. Race losers stay pending rather than becoming duplicate runs.

Start with a configurable small concurrency cap for scheduled runs (proposed default: 2); include child-settlement time in that count. Order pending work by due time with a stable tie-breaker so one schedule cannot monopolize dispatch. Existing manual-run behavior remains unchanged. Bound schedule counts, prompt sizes, poll batches, and retry frequency to avoid accidental runaway cost.

No LLM is required to tick the scheduler or decide if an occurrence is due.

## Time and lifecycle semantics

- Store UTC instants and an explicit IANA timezone; travel or changing a device/server timezone does not shift an existing schedule.
- One-offs require an unambiguous offset-bearing timestamp. Resolve “in two hours” relative to the request time and persist the resulting instant. Reject past creation times; use ordinary chat for “now.”
- Use a maintained timezone-aware cron library, pinned in dependencies, behind a tested wrapper. Define conventional day-of-month/day-of-week OR semantics when both are restricted; preview them.
- Spring-forward nonexistent cron times are skipped. Fall-back repeated local times execute once, at the first matching instant. Enforce this explicitly if the chosen library has different defaults. Reject impossible schedules or report no future occurrence using bounded validation.
- Advance cron from scheduled instants, not task completion, to avoid drift.
- During normal busy overlap, preserve the existing pending/running occurrence and skip later ticks. If no outstanding occurrence exists after downtime, `latest` selects only the most recent missed tick inside the lateness window; `none` skips downtime occurrences. A one-off that cannot catch up expires visibly.
- Apply the same lateness deadline to busy/capacity/provider-blocked pending work. Retry transient pre-admission failures with capped backoff only until that deadline. Invalid credentials/configuration surface a blocked notice rather than a tight retry loop.
- Pause cancels unstarted occurrences and clears dispatch eligibility; it does not abort a running task. Resume starts a cron schedule from now with no paused-period catch-up. An overdue paused one-off requires an explicit new future time.
- Timing/prompt edits cancel unstarted occurrences from the old revision and recompute from now. A concurrent admitted run finishes using its snapshot; return that fact in the update response.
- Cancel is terminal for the schedule and cancels unstarted occurrences. It does not pretend to undo running tools or external effects.
- Stop cancels the current run and unstarted due work for that agent, so an already queued wake does not immediately restart it. Future cron ticks remain enabled; UI states this and offers **Pause schedules**. Ordinary run failure does not automatically replay its occurrence.
- Archive pauses all schedules atomically with the archive operation. Preserve the current rule that an active agent cannot be archived. Agent restoration, project moves, and Fresh Session do not themselves resume or duplicate schedules.

## Crash recovery and guarantees

After normal store recovery:

1. Reconcile occurrences linked to terminal/interrupted runs to those run outcomes.
2. An occurrence with no committed run remains eligible for safe delivery if still active and within its lateness window.
3. A committed run is never automatically replayed, even if the process died before the first model token. Existing recovery marks it interrupted.
4. Reconcile schedule cursors and one-off completion transactionally, then evaluate downtime policy.
5. Resume polling only after reconciliation finishes.

This gives **at-most-once automatic run admission per occurrence**, not exactly-once task effects or guaranteed successful execution. A crash can interrupt work after an external side effect. Any manual retry is a new, clearly linked occurrence and must warn that earlier effects may already have happened; a dedicated Retry UI can follow v1.

An in-process, single-instance scheduler is sufficient given Jelly's existing instance ownership model. Do not introduce distributed leases unless multi-process scheduler ownership is actually added.

Stop scheduler admission before shutdown begins; wait for its current database work, then let the existing service stop/drain runs and close the store. Never auto-reconnect private browser/desktop authority or bypass required human intervention simply because a task is unattended.

## Implementation sequence and acceptance

1. **Timing and persistence:** shared types, migration, schedule/occurrence store, cron wrapper, validation and preview; fake-clock tests.
2. **Admission and recovery:** split admission/execution, inject source metadata, add scheduler, startup/shutdown wiring and transactional finalization; keep ordinary queue semantics unchanged.
3. **Agent tools and API:** scoped tools, authenticated CRUD/actions, idempotency/revision checks, explicit timing receipts and instruction guidance.
4. **User controls:** schedules list/details, inline receipts, automated-message presentation, pause/cancel/blocked notices and history.
5. **Verification and rollout:** targeted tests, then full deployment gate. Ship only once pause/cancel works without a model connection.

Required tests:

- One-off and cron delivery with no connected browser; task not executed at creation.
- Correct same-agent context restoration and current settings; exact saved prompt in user-role wake, with durable provenance.
- Invalid cron/timezone, relative-time normalization, past timestamps, sparse schedules, leap days, DST gaps/folds, clock jumps, and timezone changes.
- Multiple missed times, lateness expiry, `catchUp: none`, busy overlap, concurrency limits, fairness, and provider recovery.
- Idempotent creation and dispatch, update races, pause/cancel versus admission, archive/restore, Stop, Fresh Session, and manual queue precedence.
- Crash injection before occurrence commit, after occurrence creation, after run admission, during tools, and during finalization; no duplicate admission and no silent replay.
- Existing queued interactive messages still cancel on restart/failure as before; durable unstarted schedule occurrences survive correctly.
- Child work keeps the agent busy until settled; no scheduled steering into ongoing child supervision.
- API control-session protections, cross-agent tool scope, stale revisions, spoofed message provenance, and input limits.
- UI replay/reconnect, clear automated labels, schedule history, keyboard/mobile controls, and actionable blocked/expired states.

Suggested new tests: `tests/schedules.test.ts`, `tests/scheduler.test.ts`, `tests/schedule-tools.test.ts`, `tests/schedules-api.test.ts`, and `tests/schedules-client.test.tsx`. Extend `tests/restart.test.ts` and existing lifecycle tests. Wire new tests into `package.json` test scripts.

Use disposable databases and fake providers/clocks; never manufacture test schedules in the live database. Run targeted tests and `bun run check` while implementing. Before deployment run `bun run check:full`, then follow the project's deferred idle-restart procedure. Report this-host smoke checks separately from remote-device checks.

## Deferred

Separate conversations per occurrence, attachments, event/webhook triggers, second-resolution or arbitrary interval schedules, calendar exclusions, distributed workers, host wake-up, automatic failed-task retries, and external delivery channels. These are not needed for the initial “wake this agent with this prompt at this time” feature.
