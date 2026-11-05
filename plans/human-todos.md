# Human todos / Needs you inbox

Status: implemented and verified in source; live activation remains pending. No live todos were created, the service was not restarted, and no commit was made.

## Implementation and verification

The implementation delivers schema v20 persistence, human and scoped-agent CRUD,
the global Todos destination and per-agent Needs you lists, private-handoff
visibility, opt-in attention notifications, and explicit durable continuation.
See [Human todos](../docs/HUMAN_TODOS.md) for the current usage and developer contract.

Independent backend/UI review found seven issues; all were fixed with regressions.
The correction pass also fixed mixed schedule/todo admission fairness and the
ordinary-continuation fence during active goal work. Final review: **OK**.

Parent verification on the corrected source:

- `bun run check:full`: passed in a disposable source copy, including TypeScript,
  all configured tests, and both builds. Live `dist` and databases were untouched.
- `bun run test:human-todos`: 55 passing tests, 440 assertions.
- Isolated Chromium: 320px, 390px and 1280px passed, including archived
  root/project navigation, source after unassignment, actual Back, and drafts.

Remaining release work: explicit idle-safe activation, same-host
loopback/Tailscale/private-HTTPS and control-session checks, then real remote/mobile
and provider/private-handoff qualification. No remote-device or production
verification is implied.

The original design below records the feature's intent and deferred scope; the
delivery notes above and usage guide describe its implemented status.

## Goal

Give the human one reliable place to see actions agents need from them, and show the same tasks inside each linked agent. Both the human and agents can create, read, update, complete, reopen, cancel, and delete tasks.

**Core promise:** “If an agent needs something from me, I can find it without remembering which conversation it was in.”

This is a human action list, not an agent implementation checklist, a second Goals system, or a project-management app. The human is always the assignee; the linked agent is the requester/continuation destination.

## Recommended v1 decisions

| Question | Recommendation |
| --- | --- |
| Main destination | **Todos**, alongside Agents and Apps, with an outstanding-action badge. |
| Per-agent visibility | A persistent **Needs you · N** strip below the conversation header, opening that agent’s tasks. Also show counts on agent/project rows. |
| Ownership | One linked persistent agent per task; human-created tasks can be unassigned. Agents manage tasks currently linked to themselves. |
| Persistence | Store tasks in SQLite independently of runs, sessions, and browser tabs. No expiry for ordinary todos. |
| Completion | **Done** changes task state only. **Done & continue** explicitly requests a follow-up run from the linked agent. |
| Blocking | A task can be marked **Blocking**. It describes a dependency, not an indefinitely running agent or a global prohibition on other work. |
| Private requests | Surface live sudo/sign-in/desktop handoffs in the same inbox, but retain their existing secure controls and lifecycle. |
| Reminders | Persistent counts and existing opt-in browser notifications. Due dates, snoozing, recurring reminders, and closed-browser push are deferred. |

## User experience

### Global Todos inbox

On desktop, add Todos to the existing destination navigation in the sidebar rail. On mobile, use three labelled destinations in the bottom bar; retain the existing conversation/viewer navigation behavior.

Default view:

1. **Needs attention now:** active private handoffs, labelled with their request type and expiry where relevant.
2. **Open todos:** blocking tasks first, then other tasks; oldest first within each group, with a stable ID tie-breaker.
3. **Done / Cancelled:** separate history filter, newest resolution first and paginated.

Each ordinary task row shows:

- A clear action title: “Upload the signed contract”, not “Blocked”.
- Linked agent avatar/name, current project, and a Blocking label when applicable.
- Creation age and a short reason/context preview.
- An accessible Done control and overflow actions for edit, cancel, and delete.

Selecting the row opens details: full instructions, why the agent needs it, what counts as done, source-conversation link, status, and optional completion note. Include **Open agent** and show any requested continuation’s delivery/outcome separately from task status.

Provide **Add todo**, search, and agent/project filters. The human can create an unassigned task or choose an agent; no model call is needed. Opening an inbox filter or changing assignment must not start the agent.

The badge counts open ordinary tasks plus pending handoffs. A linked todo/handoff group counts once, not twice. Executing handoffs remain visible as in progress but add no separate actionable count. Done, cancelled, and deleted tasks do not count. Opening/viewing an item does not clear the badge. Open tasks belonging to archived agents remain visible and clearly labelled; their existence must not be forgotten just because the agent is archived.

Empty state: **“Nothing needs you right now.”** Keep Add todo available.

### Inside an agent

- Show **Needs you · 3** with a compact preview of the oldest blocking task; expand to the full list without navigating away from chat.
- With no outstanding items, retain a quiet **Todos** action for manual creation and history.
- The same task ID backs global and per-agent views; never maintain copied lists.
- Creation and meaningful resolution appear as compact chat activity cards, linked to the canonical task. Routine text edits belong in task history rather than flooding chat.
- Use `ChatFormCard` / `ChatFormActions` for inline forms and receipts. Other task editors reuse the shared modal/sheet shell.
- Preserve drafts, selected project/agent, scroll, browser Back, and focus when switching destinations or opening source conversations.

Keep existing execution status separate. A settled agent with an open blocking task can display **Needs you · 1** without setting its runtime status to `waiting`. A working agent can show both its activity indicator and outstanding-human-task count. Preserve existing attention priority and assistant-response-based inbox ordering.

### Example

1. The agent cannot finish a filing without a signed document.
2. It creates “Upload the signed agreement”, with the reason and required destination, then reports the saved task and finishes its current run.
3. The task appears in Todos and the agent’s Needs you strip—even days later, after a restart.
4. The human uploads the document through the existing upload flow and adds “Saved as signed-agreement.pdf in the project folder.”
5. **Done & continue** completes the todo and requests a follow-up in the same agent conversation.
6. The agent verifies the file and continues the authorized filing work. Marking Done is a human attestation, not proof that the dependency is satisfied.

If verification fails, the agent may reopen the same task with a clear explanation rather than creating a duplicate. That produces a visible history entry.

## Task lifecycle and CRUD rules

Use `open`, `done`, and `cancelled`, plus `deletedAt` for soft deletion.

- **Done:** the requested human action is reported complete; does not mean the agent’s overall job succeeded.
- **Cancel:** the action is no longer wanted/needed; never treat it as successful completion or authorize dependent work.
- **Reopen:** return a done/cancelled task to open, retaining its history.
- **Delete:** remove it from normal views and counts; retain a tombstone/audit receipt for concurrency, source links, and duplicate-request protection. Explain that deletion is not permanent data erasure.
- Completion notes are optional, non-secret text. Record whether completion was reported by the human or an agent.
- Agent completion requires observed evidence or an explicit human instruction, not an assumption that the user probably did it. Agent cancellation/deletion of an open task requires a reason.
- Humans can edit/reassign any ordinary task, including agent-created tasks. Agents can CRUD human-created tasks currently linked to themselves, but cannot manage unrelated or unassigned tasks.
- Reassignment changes the continuation destination, not creator provenance. Cancel any unstarted continuation on reassignment, clear the operational goal/handoff binding while retaining its historical origin, and invalidate the old source-specific continuation context. A later continuation must use the new agent’s context.
- Todos remain editable while an agent is busy. They are not agent profile edits.

Use expected revisions for every update/action/delete and stable request IDs for mutations. A stale editor gets a conflict and retains its draft; it must not overwrite a newer human or agent change. Replaying the same request returns its receipt; reusing its ID with different input returns a conflict.

## Agent behavior and tools

Proposed tools:

- `human_todo_list`: paginated own-agent list; an optional todo ID returns full details/history and current revision.
- `human_todo_create`: title, instructions, reason, optional completion criteria, blocking flag, and request ID.
- `human_todo_update`: todo ID, expected revision, request ID, changed fields/status, and optional resolution note/reason.
- `human_todo_delete`: todo ID, expected revision, request ID, and reason.

Bind agent/run identity server-side. Agents cannot choose another owner, forge the mutation actor, or supply a continuation target. Ordinary delegated children do not receive an independent todo owner: they report blockers to their persistent parent, which records the task.

Tool guidance:

1. Record concrete human dependencies discovered while doing the authorized work. Do not turn every question, suggestion, tool error, or internal work step into a todo.
2. Check existing open tasks and update/reuse an existing blocker. Support an optional agent-scoped deduplication key; identical retries never create another row, and different payloads under an existing key conflict rather than overwrite.
3. Write an actionable title, explain what is blocked, and say how the human can resolve it. Include only enough non-secret continuation context to make sense after compaction.
4. Never request passwords, tokens, recovery codes, or private authentication in todo text or completion notes. Use the existing private handoff tools.
5. Only claim a task was recorded after the durable tool receipt succeeds.
6. Finish the current run when no useful work remains. Do not sleep, poll repeatedly, or keep a tool promise open for an ordinary human todo.
7. Before relying on an old task snapshot, read its current state. Human edits and cancellations are authoritative task updates, not permission to expand the original job.

Provide a bounded own-agent open-task summary at parent run start, with a count and tool-based pagination for the rest. SQLite, not model memory or a markdown file, is authoritative. Task descriptions are contextual data, not system instructions.

## Completion and continuation

**Task state and agent execution are separate operations with separately visible results.**

### Ordinary tasks

- Clicking the checkbox / **Done** commits completion without spending model tokens.
- **Done & continue** explicitly completes the task and requests one ordinary follow-up using the agent’s existing conversation and current settings. Display that it will run the agent.
- On an already completed task, **Continue agent** can request a follow-up if none is pending/admitted for that completion. Retrying the same action must not duplicate a run. Once a delivery has admitted a run, further attempts use an explicit new chat request with an uncertain-effects warning, never a reset of the consumed delivery.
- Agent-authored state changes never wake themselves. Ordinary edits, deletes, cancels, and reopens never automatically start a model.
- The follow-up identifies the todo, completion actor/note, original dependency, and remaining open blockers. It instructs the agent to verify the dependency, continue only what is unblocked and still authorized, and not recreate the todo merely because it received the update.
- Remaining open todos do not impose an agent-wide all-or-nothing gate: they might block unrelated work. Dependency graphs and automatic “all tasks done” triggers are out of scope.

### Busy agents, failures, and restart

A requested continuation needs a small durable delivery record, not an insertion into `pending_messages` and not a new calendar schedule.

- If the agent is idle and available, admit the follow-up through normal Jelly run admission.
- If busy, including child settlement or a private handoff, show **Waiting for agent**. Never steer or run concurrently. Already-queued human messages have priority; do not displace admitted goals or schedules.
- Atomically commit completion and the continuation request. Later, atomically commit the normal run, its labelled message, provenance, and delivery binding before any model/tool work starts.
- Enforce at-most-once automatic admission per delivery. Maintain a unique completion identity and allow only one continuation for it; reopen/re-complete creates a new completion identity.
- Before admission, recheck current task state, assignment, completion identity, archive/stop state, provider readiness, and existing work. Reopen/delete/reassignment cancels an unstarted delivery. A later edit invalidates its old snapshot and requires renewed confirmation rather than executing stale instructions.
- Delivery states should distinguish waiting, needs retry, admitted, and cancelled; once admitted, expose the linked run’s actual outcome separately.
- Provider/configuration failure leaves the todo Done and the continuation **Not started — retry**. Do not roll back the human’s completion or run an unbounded retry loop.
- Stop cancels unstarted todo continuations for that agent; an already-admitted run follows normal Stop behavior. A failed/cancelled/interrupted active run prevents pending todo continuations from silently starting afterward; show an explicit retry action.
- On restart, retain task state and delivery records, but change unadmitted requests to **Needs retry**. Never automatically replay admitted work. A crash between admission and execution remains an interrupted run, not permission to retry its external effects.
- Archive preserves tasks, cancels unstarted continuations, and disables Continue until restored. Restore and Fresh Session do not trigger work; Fresh Session holds off pending continuations for explicit retry with the new context.
- Cancellation after admission cannot retract model requests or external effects. Show **Already started** and offer the existing Stop control separately.

This is a narrow human-triggered delivery mechanism, not a new generic workflow engine. Reuse admission/finalization machinery and bounded capacity/fairness with existing automated work; do not reuse schedule timing or create package-owned child schedules.

### Goals

Preserve the Goals contract: a todo completion must not silently reactivate a paused/blocked goal or reset its safety counter.

When the parent of an active goal creates a blocking todo for that goal, bind its goal identity and atomically record the goal blocker/fence through existing Goals semantics. This prevents goal-generated continuation loops while waiting, but does not abort in-flight tools or children.

For a goal-linked task, offer **Done**, then **Review goal** and the existing explicit **Resume goal** action, not an ordinary automatic continuation. Recheck the current goal identity/state; never resume a replaced, cleared, completed, or stale goal. A pending ordinary todo continuation must also wait for explicit review if its agent has acquired active goal work meanwhile.

## Existing private handoffs

The human inbox must also reveal what Jelly already asks the user to do: sudo authentication, browser sign-in, and desktop handback.

- Project pending/executing intervention records into the inbox. Do not copy them into ordinary todo rows or manufacture long-lived approval capabilities.
- Their action is **Open request**, routing to the original conversation/private UI. They cannot be completed, edited, deleted, or approved through generic todo endpoints.
- Expired/denied/cancelled/interrupted requests keep their real status and leave the actionable count. Historical links explain that a fresh request may be needed; opening them never replays a command or handoff.
- Reuse existing intervention notification markers to avoid double alerts.
- If a durable task tracks a longer-lived dependency that currently has a private handoff, allow a validated source link and render it as one grouped action with distinct task/request states. Finishing a handoff does not automatically assert that the broader task is done.

Do not change intervention TTLs, credential handling, browser ownership, or desktop handback semantics as part of this feature.

## Persistence, API, and integration

### Data

Add a versioned migration using the next available schema version at implementation time.

- `human_todos`: ID, nullable linked agent ID, title, instructions, reason, completion criteria, blocking flag, status, revision, timestamps, deletedAt, resolution note/actor, and completion identity.
- Server-owned provenance: creator actor, creating agent/run/request, optional source activity and goal/intervention IDs. Validate source membership; do not accept arbitrary filesystem paths or private request payloads.
- Optional continuation-context snapshot: bounded original work/dependency context, not an arbitrary command to execute. Keep its source identity and invalidate it on reassignment.
- Mutation/audit records: request ID, validated payload fingerprint, actor/run, before/after revision, receipt, and timestamp. Preserve deletion provenance and replay protection.
- Continuation delivery records: todo/completion identity, immutable requested snapshot, target agent, state/reason, stable admission request ID, nullable run ID, and timestamps.

Index global status/creation ordering, agent/status, deletion, and outstanding delivery lookup. Derive project from the linked agent rather than persisting a second mutable assignment. Use bounded fields (proposed: title 160 characters; instructions 8,000; reason/criteria/note/context 4,000 each), cursor pagination (default 30, max 100), and a generous open-task creation cap with visible errors. Never evict forgotten tasks automatically to satisfy a limit.

### API sketch

- `GET /api/human-todos`: status, agent/project, search, and cursor filters; global counts.
- `GET /api/human-todos/:id`: detail, provenance, current continuation status, bounded history.
- `POST /api/human-todos`: human creation, optionally linked to an agent.
- `PATCH /api/human-todos/:id`: edit/reassign/change state with expected revision and request ID.
- `POST /api/human-todos/:id/complete`: optional note and explicit `continueAgent` flag; completion and delivery request commit together.
- `POST /api/human-todos/:id/continue`: explicitly request/retry delivery for the current completion.
- `POST /api/human-todos/:id/delete`: soft delete with revision/request ID.

All browser routes use existing control-session, CSRF, host/origin, and body-size protections. Ordinary tools use the same domain service with narrower server-bound ownership and no model-triggered `continueAgent` option. Reject forged actor/provenance and cross-agent tool access. CRUD works even when the model connection is unavailable.

Publish durable `human_todo_changed` and `human_todo_continuation_changed` events only after commit. Extend snapshots with content-light global/per-agent counts, not every task’s text. Fetch details on demand; SSE/reconnect invalidates lists and refreshes authoritative snapshots. Historical source links need a supported activity-anchor lookup, not an assumption that the original card remains in the latest history page.

### Current repository integration points

| Area | Existing files / proposed change |
| --- | --- |
| Domain/persistence | New `src/server/human-todos.ts`, `human-todo-schema.ts`, `src/shared/human-todos.ts`; wire into `store.ts`. |
| Tools | New `src/server/human-todo-tools.ts`; register scoped parent tools in `service.ts`, following `schedule-tools.ts`. |
| Runs | `service.ts`: shared admission/finalization, provenance, stop/archive/Fresh Session/recovery; widen the schedule-specific source types deliberately. |
| Goals | `goals.ts`: atomic goal-linked blocker integration without a second goal driver. |
| Private requests | `interventions.ts` and `InterventionCard.tsx`: read-only inbox projection and existing secure request navigation. |
| HTTP | `app.ts`: protected endpoints and SPA routing for `/todos` and task deep links. |
| UI | New Todo inbox/detail/per-agent components; extend `App.tsx`, `AgentInbox.tsx`, `api.ts`, and destination navigation currently in `apps-navigation.ts`. |
| Notifications | `useAgentNotifications.ts`, `browser-notifications.ts`, snapshot markers: todo-created/reopened attention, deduped across tabs. |

No change to the live database, service configuration, or third-party services is part of planning.

## Notifications and privacy

- New agent-created tasks and meaningful agent-driven reopenings may use the existing opted-in browser notification channel. Human-created/edited tasks do not notify their own creator.
- Use generic notification text such as **“An agent needs your help”** plus the agent name; no todo description, completion note, or secret-bearing details on the lock screen.
- Deduplicate repeat mutations, reconnects, tabs, and handoff projections. Suppress alerts when the relevant task is visibly open; do not replay historical notifications on initial load.
- Persistent inbox counts are the reliability mechanism. Current browser notifications require Jelly to remain open and a supported secure context; do not promise closed-browser, sleeping-device, or mobile push delivery.
- Task descriptions and notes are persisted and may be sent to the linked agent’s provider. Say so where users enter notes; private credentials must use the existing handoff flow.

## Delivery sequence

1. **Durable CRUD:** types, migration, domain service, receipts/revisions, audit, scoped tools, authenticated API, and task summary/provenance.
2. **Useful vertical slice:** global Todos destination, per-agent strip/list, human CRUD, source links, snapshot counts, live updates, and basic completion. This already solves the forgotten-blocker problem.
3. **Continuation:** explicit Done & continue, durable delivery/admission, busy/error/restart UI, Goals integration, and stop/archive handling. Do not label basic completion as automatic resumption before this exists.
4. **Complete the inbox:** private-handoff projection/grouping, browser attention notifications, accessibility/mobile polish, and release checks. These are v1 release requirements, not claims that all existing blockers were covered by step 2.

Deferred: multiple human assignees, many-agent shared tasks, subtasks/dependency DAGs, priority systems, due dates/snoozing, recurring reminders, email/push delivery, attachments stored directly on todos, bulk actions, and automatic todo extraction from historical chats. Existing uploads and private handoffs remain the appropriate paths.

## Acceptance and verification

- An agent-created task appears globally and in its agent; the human can CRUD it without a model connection. A manually created linked task is readable/editable by that agent, while an unassigned task remains human-owned.
- Open tasks survive successful/failed/stopped runs, compaction, Fresh Session, disconnected browsers, and server restarts. Archived-agent tasks remain findable.
- Both actors’ completion/cancellation/reopening/deletion update every view and count consistently; cancellation is never success. Reassignment updates both agents and project filters.
- Stale edits, repeat tool calls, repeated clicks, dropped responses, two tabs, and conflicting human/agent mutations cannot duplicate tasks or overwrite newer revisions.
- Done performs no model call. Done & continue commits the human’s change even if delivery cannot start, restores the same conversation when admitted, and admits no more than one automatic run per requested delivery.
- Race tests cover completion versus busy settlement, queued human input, goal activation, Stop, archive, reassignment, reopen, delete, Fresh Session, and shutdown. Crash tests cover before/after completion commit, admission commit, model execution, and finalization; no automatic replay of uncertain effects.
- Goals remain explicitly resumable; task creation blocks only the bound goal continuation and never creates an endless goal/task wake loop.
- Private handoff rows cannot bypass approval, expiry, request ownership, credential privacy, or explicit desktop handback. Existing request tools/flows still work unchanged.
- Tool scope, browser session/CSRF checks, forged provenance, field limits, source-link membership, and deleted-resource responses have API regressions.
- UI tests cover SSE replay/reset, pagination, stale detail responses, retained drafts, direct links, keyboard/focus behavior, empty/error states, accessible labels, long content, and 320px/390px/desktop layouts. Keep motion enabled per project policy.
- Browser alerts remain opt-in/content-light and deduplicate across tabs; ordinary todo edits do not cause notification storms.

Use disposable databases and deterministic providers; never seed fake todos into the live instance. Run targeted tests plus `bun run check` while implementing, and `bun run check:full` before deployment. Follow the idle-safe restart procedure only when activation is requested. Report this-host smoke tests separately from real remote-device/iPhone verification.

## Proposed success signals

No analytics service is required. If useful, derive counts locally: outstanding blockers, age of the oldest blocker, and completion-to-successful-continuation time. Product success is a user being able to answer **“What do my agents need from me?”** and clear a blocker without hunting through chat history.
