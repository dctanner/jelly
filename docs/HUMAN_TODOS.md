# Human todos

Implementation is verified in source; activation on the running instance is pending.

**Todos** is the human's inbox of actions agents need. The same durable tasks appear
globally and in each linked agent's **Needs you** list. The human is the assignee;
the linked agent is the requester and continuation destination.

## Using the inbox

- Open **Todos** beside Agents and Apps. A segmented **To do / Completed** control,
  search, and an agent filter sit above a checklist; newest todos come first.
- Each todo has just a **title**, a free-form **body** (what to do, why, and what
  counts as done), and an **assigned agent**. The agent picker lists active agents
  ordered by most recent activity; archived agents are hidden (an already-assigned
  archived agent remains shown for that todo only).
- An agent's **…** menu has a **Todos** row (with its open count) that opens
  `/todos?agent=<id>`: the list filtered to that agent. The filter lives in the
  URL, so it survives opening a todo, reloads and Back; the To do count and New
  todo's default assignee follow it. Changing the dropdown updates the URL.
- **New todo** creates an action without calling a model. Agents can create and
  manage tasks assigned to themselves.
- Tap the circle on a row to mark it done (no agent run); tap it on a completed
  row to reopen. Open the row to edit, add a note, or choose **Done & tell agent**.
- **Won’t do** means the action is no longer wanted, not that it succeeded.
  **Reopen** returns either state to the open list.
- **Delete** (with confirmation) hides the task but retains an audit tombstone; it
  is not permanent data erasure. **Activity** shows who changed what.
- Databases from before v21 had separate instructions/reason/criteria fields and
  a Blocking flag. Migration merges the text into the body (with “Why:” and
  “Done when:” prefixes) and drops the flag.
- Completed/cancelled tasks are available in history. Archived agents' open tasks
  remain visible, with links to the archived conversation.

In an agent's conversation, a todo it creates appears as a live checklist item
matching the Todos list: tap the circle to mark it done/reopen, or the text to open
it. Later status changes show as one quiet line (for example “Marked done · title”).

Global, agent, and project counts use the same canonical records. Viewing a task
does not clear its count. Todo blockers do not hold a run open or replace the
agent's actual execution status; agents can do unrelated work while a dependency
is outstanding.

Edits and actions use the revision you reviewed. If another actor changes the task,
reload/review the new state before retrying; your draft is retained on conflict.
Inputs are disabled during saving and the following saved-state refresh.

## Mark done versus Done & tell agent

**Mark done** does not run an agent. Completion is a human/agent attestation, not proof
that an uploaded file, sign-in, or other external action succeeded.

**Done & tell agent** explicitly requests one follow-up in the assigned
agent's existing conversation. On an already completed task, use **Tell agent**.
An additional note on a completed task must first be saved with **Save note**;
saving it alone does not run the agent.

The follow-up contains the dependency and saved completion note. The agent should
verify the result and continue only work that is now unblocked and authorized.
Task status, continuation delivery, and the run's actual outcome are displayed
separately.

- Busy agents wait, without steering or concurrent execution. Queued human
  messages have priority.
- Missing credentials or other pre-admission failures leave the todo Done and
  display **Not started — retry**.
- Editing, reopening, deleting, or reassigning a task cancels an unstarted request
  so stale instructions cannot run.
- Stop, unsuccessful execution, archive, Fresh Session, and server recovery fence
  unstarted continuations. They require a fresh explicit retry/review.
- Once a run was admitted, it is never automatically replayed. Further attempts
  require an explicit new chat request; inspect uncertain external effects first.
- Completing or editing a task through agent tools never wakes that agent.

### Goals

A task an agent creates with `blocking: true` during an admitted goal execution (a
tool-only hint; it is not stored or shown as a field) retains that goal's identity,
including further dependencies discovered after the first blocker. It fences
goal-generated continuations without aborting already-running tools or children.

Complete a goal-linked task, then choose **Review goal** and use the existing
explicit **Resume goal** action. Todo completion never silently resumes a stopped
goal or resets its safety counter. Ordinary continuation requests made before or
during active goal work are held for renewed review.

## Private requests and notifications

Pending sudo, browser sign-in, and desktop requests also appear in Todos.
**Open request** routes to the existing private controls. These rows are not
editable/approvable through generic todo actions and preserve their original expiry
and ownership rules. A linked task/request group counts once. Executing requests
remain visible without adding another actionable count.

Task text and completion notes are persisted and may be sent to the linked agent's
provider. **Never enter passwords, tokens, or recovery codes in a todo.** Use the
existing private handoff instead. Completing a handoff does not automatically mark
a broader linked todo complete.

Existing opted-in browser notifications cover new/reopened agent requests using
content-light alerts. They are deduplicated across tabs and suppressed for the task
being viewed. Human edits do not produce self-alerts. Persistent counts work
independently of notification permissions; closed-browser push and reminders are
not included. See [notification limitations](NOTIFICATIONS.md).

## Developer contract

- Schema v20 adds `human_todos`, mutation receipts/audit, dedupe keys, and durable
  continuation proposals. Tasks survive runs, compaction, and restart.
- Parent tools: `human_todo_list`, `human_todo_create`, `human_todo_update`,
  `human_todo_delete`. Identity is bound server-side; tools cannot manage other
  agents' tasks, forge provenance, or request a wake.
- Protected APIs: `GET/POST /api/human-todos`, `GET/PATCH /api/human-todos/:id`,
  and `POST /api/human-todos/:id/complete`, `/continue`, `/delete`.
- Mutations use stable request IDs and expected revisions. Agent completion needs
  a non-secret evidence/instruction note; open-task cancellation/deletion needs
  a reason.
- Lists return bounded summaries. Full details, audit, and immutable source links
  load on demand; post-commit events invalidate canonical UI views.
- Normal run admission atomically binds message/run/provenance/delivery before
  model execution. A partial unique completion index prevents multiple live or
  admitted continuations for one completion. This is at-most-once admission,
  not exactly-once external effects.
- Schedule/todo work shares bounded automated capacity and alternates priority
  using the most recently admitted source, not timer ticks.

Main implementation: `src/server/human-todos.ts`, `human-todo-schema.ts`,
`human-todo-tools.ts`, `src/client/HumanTodos.tsx`, and lifecycle integration in
`src/server/service.ts`. No new dependency, generic workflow engine, or goal driver.

## Verification and remaining release work

- Final independent review: **OK**, after all seven original findings and two
  additional lifecycle/fairness issues were corrected with regressions.
- `bun run check:full`: passed in a disposable source copy, including TypeScript,
  all configured suites, and client/Chrome-extension builds.
- `bun run test:human-todos`: **55 passing tests**, including SIGKILL recovery,
  API/tool scope, concurrency, goal binding, stale edits, notes, and notifications.
- Isolated Chromium checks passed at **320px, 390px, and 1280px**, including
  archived project/root navigation, source links after unassignment, actual Back,
  drafts, and layout. `bun run test:human-todos-browser` builds a disposable copy
  rather than overwriting the live `dist`.

The full-check copy linked the existing dependency tree and native runtime
binaries required by existing Chrome fixtures, not live databases or credentials.
No live todo, service restart, deployment, or commit was performed.

Activation still requires the project's idle-safe restart procedure and subsequent
loopback/Tailscale/private-HTTPS checks. Real remote iPhone/Safari, paid-provider
behavior, live private-handoff walkthroughs, and exhaustive crash/load testing
remain unverified.

Due dates, snoozing, recurring reminders, multi-human/multi-agent assignment,
dependency graphs, direct todo attachments, and push/email delivery are deferred.
