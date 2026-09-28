# Phase 2 extension — Optional projects

Historical planning checklist, preserved verbatim below except this status note. The feature is delivered; see [delivery and verification](02-projects.md). Unchecked boxes below describe the original plan, not remaining implementation.

Original status: planned. This is new scope, separate from the already delivered local workspace. It does not reopen completed Phase 2 work or the user-run checks in [02-validation.md](02-validation.md).

## Outcome

Projects optionally group agents and provide a default working directory (pwd). The user selects that directory with a folder browser, and every new agent created in the project starts in that directory. A user can keep using Jelly without creating a project, or switch from “Website refresh” to “Personal” in two clicks/taps and resume the agent they last used there. Switching preserves drafts and does not stop work in another project.

The [desktop and mobile concept](../output/projects-concept/projects-desktop-mobile.png) illustrates the placement of the switcher. Its counts and content are illustrative; it predates the folder-selection requirement described below. Keep the approved Familiar direction: white chat, blue accents, sea-creature avatars, and a regular lowercase “jelly” wordmark with an ordinary j. Standalone logo selection is a separate design decision.

## Product decisions

- An agent belongs to zero or one project in this first release. Projects are flat; no nesting or multiple membership.
- **All agents** is the initial/default view and includes every active agent, grouped or ungrouped. **Ungrouped** shows only active agents with no project. Neither is a stored project or a mandatory “default project”.
- Existing agents migrate as ungrouped. Existing conversations, agent IDs, files, instructions, model configuration and working directories stay attached to their agents.
- Projects belong to one Jelly instance. Each project has a required `defaultCwd`: an existing directory selected on that instance's filesystem. New agents in the project work in the same selected directory, not an automatically created per-agent subdirectory. They keep separate identities, sessions and conversation histories while accessing the same files. A working directory is not a sandbox or a separate permission boundary.
- Copy the project's current defaultCwd into each new agent's persisted `cwd` at creation. Changing the project default affects future agents only. Moving an existing agent into or out of a project does not change its cwd. New ungrouped agents retain the existing Jelly-managed per-agent workspace behavior.
- Membership, project names, default directories and agent directories persist on the server. The current project view and last selected agent in each view are browser preferences, scoped to the instance; one client must not switch another client's view.
- First release: create, rename and delete a project; choose/change its default working directory through a folder browser; assign, move and ungroup agents; switch and search projects. Deleting a project ungroups its agents, including archived agents, and never deletes or archives them or changes their directories. It never deletes the selected folder or its files.
- Project names are trimmed, 1–60 characters, and unique within an instance using a defined case-insensitive normalized key. Reserve “All agents” and “Ungrouped” to avoid ambiguous switcher entries. Stable IDs, not names, identify projects.

## Interaction design

### Fast switching

- Put an always-visible project button directly below the desktop wordmark and above agent search. It displays “All agents”, “Ungrouped”, or the current project name, plus a chevron. It is separate from the computer/instance selector.
- Open an anchored searchable popover. Fixed entries: All agents, Ungrouped. Below: named projects, with recently visited projects first and remaining projects alphabetically. Include an explicit selected check and active-agent counts; All agents counts agents once.
- Provide “New project” at the bottom. Its form requires a name and a working directory selected through “Choose folder…”. Creating a project selects its empty view and offers “Create agent” and “Add existing agent”. An agent picker offers explicit selection; it never moves agents automatically, and adding an existing agent preserves that agent's directory.
- On mobile, put the same project control at the top of the full-width agent list. Also expose a compact project button in the chat header so switching does not require returning to the list. Open the same choices in a modal bottom sheet, with safe-area padding and at least 44px hit targets. Do not retain a permanent skinny sidebar in chat.
- Opening the control and selecting a visible project takes two clicks/taps. Search filters named projects without requiring a network request. Keep All agents and Ungrouped easy to reach.
- Use Cmd/Ctrl+K as the single project quick-switch shortcut; do not also bind it to agent search. Support typing, arrow navigation, Enter to select and Escape to dismiss. Ignore IME composition, announce selection, manage dialog/listbox semantics and return focus appropriately. Do not open the mobile keyboard automatically on touch; keyboard-triggered search should receive focus.
- Selecting from an open chat resumes a chat if the destination has an agent; selecting from the mobile list keeps the list open. An empty destination shows its project empty state.

### Selection and preservation rules

Use an explicit client scope union: `{ kind: "all" } | { kind: "ungrouped" } | { kind: "project", projectId: string }`. Do not overload a null project ID to mean both All agents and Ungrouped.

On a scope switch:

1. Preserve the current agent's in-memory draft and last selection for the source scope.
2. Filter the cached active-agent directory immediately. Restore the destination's last selected agent if still eligible; otherwise retain the current agent if it belongs there; otherwise select the first eligible agent in the existing stable order (`createdAt`, then `id`).
3. Fetch that agent's history using the existing snapshot flow. Keep the composer disabled until the response matches the requested agent and scope. Never show the previous project's messages as the destination conversation.
4. If the destination is empty, clear the presented conversation and show “No agents in this project yet” with create/add actions. A default agent from another project must not appear accidentally.

Retain drafts by agent ID, not project ID, so moving an agent does not lose or duplicate its draft. Reload-persistent drafts are separate scope; the current app's drafts are in memory. Namespace navigation preferences and in-memory caches by instance ID in preparation for [remote instances](03-remote-instances.md). Migrate the existing `jelly.agent` preference only after validating that its agent exists in the current instance.

Scope changes are navigation only: no stop requests, archive operations, permission changes or run restarts. Show a small textual working/needs-help count for other scopes in the switcher, derived from the full agent directory, so hidden running agents and pending handoffs remain discoverable.

### Membership and lifecycle

- The create-agent form has an optional Project field. Default to the current named project; default to Ungrouped when invoked from All agents or Ungrouped. Always allow choosing another destination. For a named project, show its effective working directory as a read-only inherited value; every newly created project agent uses that directory. The server selects the authoritative default, including when creation comes through WebMCP or the API.
- Existing agents expose “Move to project…” in a row/header overflow menu. Reuse the chooser with an explicit Ungrouped option. This metadata-only move is allowed while an agent is running or waiting; profile edits and agent archival retain their existing restrictions.
- After a user moves the current agent outside the active filter, keep its conversation in view by switching to the destination scope; All agents can stay selected. Preserve the draft. Announce the new project. A background move from another client must instead reconcile the current filter without stealing focus or silently changing the user's scope.
- Rename a project or change its default folder in a separate management action without changing its ID or selection. “Change folder…” reopens the directory browser and explains “Used by new agents. Existing agents keep their working directories.” Keep management controls secondary to quick switching.
- Before deleting a project, show the affected-agent count and say “Agents will move to Ungrouped. Their conversations and work will stay.” Delete only project metadata. If the deleted project is selected, fall back to All agents and retain the current agent when available.
- Archived agents retain membership and return to that project on restore. The archive browser follows the current scope and offers All agents. Deleting a project also clears membership on archived agents.
- Removed/unknown saved project IDs fall back to All agents. Removed/archived last-selected agents use the selection fallback above. A project that becomes empty remains selectable with count zero.

### Working directory and folder browser

- In “New project”, show Name and Working directory, an initially empty path summary, and “Choose folder…”. Require an explicit folder choice before creating the project; browsing or canceling must not implicitly select a folder.
- Browse directories on the connected Jelly server, including when the client is mobile or remote. Label the server (“Folders on This computer”, or its instance name). A browser file-upload picker or client-local File System Access handle cannot supply the execution directory and must not be used for this flow.
- Show Home, clickable breadcrumbs/parent navigation, a directory-only list, an optional “Show hidden folders” toggle, and a pinned “Use this folder” action. Show the full resolved path before confirmation. Support keyboard navigation, loading/retry, empty directories and inaccessible folders. Use a full-height sheet on mobile with a fixed action area above the safe inset. Folder creation/deletion and file uploads are outside this picker.
- Resolve symbolic links to a canonical absolute path and display that resolved location. Validate on the server that the target exists, is a directory and is accessible to the Jelly process; mark invalid/unreadable entries unavailable. Revalidate at project save, agent creation and run startup rather than trusting a previously browsed path. Do not silently create a missing selected folder or substitute Home/the legacy workspace. Read-only directories remain valid for read-only work; file writes surface ordinary OS errors.
- Store a required `ProjectRecord.defaultCwd` and an effective `AgentRecord.cwd`. Example: a project selects `/home/alex/work/website`; agents A and B created there both persist that cwd. Changing the project default to `/home/alex/work/website-v2` changes only subsequently created agent C. A/B continue in the original directory, including after restart, regrouping or project deletion.
- Display the default path in project details and the create-agent form, and the effective cwd in the agent profile/details. Keep long paths truncated visually with a way to inspect/copy the full path; do not turn the quick project switcher into a folder browser.
- If a project's default folder disappears or becomes inaccessible, allow project switching, history reading and changing the default, but block new-agent creation with an actionable folder error. An existing agent whose recorded cwd is unavailable cannot start another run until that original path is available; do not retroactively redirect it by changing the project default. Individually changing an existing agent's cwd is separate future scope.
- Selection, rename, moving agents and deleting project metadata must not copy, move or delete files. Project agents intentionally share files through their common cwd; Jelly conversation/context/runtime state remains isolated per agent.

## Current implementation constraints

- [AgentRecord and Snapshot](../src/shared/types.ts) currently contain no projects, membership or persisted cwd.
- [Store](../src/server/store.ts) uses Bun SQLite, foreign keys, and sequential `PRAGMA user_version` migrations through version 4. Agents, histories and contexts are already durable.
- [JellyService](../src/server/service.ts) returns the full active-agent directory plus history for one selected agent. `updateAgent` rejects edits during running/waiting work. Mutations and replay events are written in a transaction, then listeners are notified.
- [App](../src/client/App.tsx) stores one selection under `jelly.agent`, keeps drafts by agent ID, protects history with request generations, and reloads snapshots on SSE activity. Its selected-agent effect currently reconnects SSE when selection changes.
- The server defaults to the first active agent when no selection is supplied. Empty project views therefore need an explicit “no selection” contract, not a falsy ID that falls through to that default.
- [Harness](../src/server/harness.ts) currently derives and creates a directory from the agent ID. [JellyService](../src/server/service.ts) separately constructs the same path for intervention tools. Both must use the same persisted effective cwd for project agents; preserve legacy paths for existing agents.
- [configurePiWorkspace](../src/server/pi-setup.ts) currently writes `.pi/settings.json` and a fixed temporary filename in cwd. Sharing a user-selected directory introduces competing writes and could alter existing project configuration. Separate Jelly-owned runtime settings from the selected directory and preserve parent/subagent model, effort and tool behavior without clobbering user-owned settings.

## Implementation checklist

### 1. Durable model and migration

- [ ] Add `ProjectRecord { id, name, defaultCwd, createdAt, updatedAt }`, `AgentRecord.projectId: string | null`, `AgentRecord.cwd: string`, and `Snapshot.projects: ProjectRecord[]` in shared types.
- [ ] Add migration v5 (or the next free version at implementation time): `projects` table with required defaultCwd, a unique normalized name key, nullable `agents.projectId REFERENCES projects(id) ON DELETE SET NULL`, persisted agent cwd, and a membership index. Backfill existing agents with their original path under the configured dataDir, without moving or creating files. Supply the configured workspace root explicitly to the migration/backfill. Verify the nullable reference and existing-row migration with enabled foreign keys; keep it atomic.
- [ ] Implement project list/create/update/delete and agent-membership updates in Store. Extend explicit agent insert/select/return paths with projectId and cwd. Apply the same validation/normalization on create and update. Existing profile saves and membership moves must preserve cwd.
- [ ] At agent creation, read the authoritative project default and insert the new agent with that cwd in the same transaction. Define ordering with concurrent project-default updates so an agent gets one complete committed default. Do not recalculate agent cwd from the project on later runs. Ungrouped creation records its normal per-agent managed path.
- [ ] Keep All agents and Ungrouped as derived views. No migration-created project, agent cloning, file movement, or history rewriting.

### 2. Service, routes and events

- [ ] Add authenticated, CSRF-protected project mutations using the same request boundaries as current agent mutations:

| Route                                  | Behavior                                                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/projects`                    | Return projects, including empty ones; the snapshot also includes this directory.                                                                                                             |
| `POST /api/projects`                   | Validate name and required defaultCwd, create project, return 201.                                                                                                                            |
| `PATCH /api/projects/:id`              | Change name and/or defaultCwd; preserve membership and every existing agent's cwd.                                                                                                            |
| `DELETE /api/projects/:id`             | Atomically ungroup active/archived members and remove only project metadata.                                                                                                                  |
| `PATCH /api/agents/:id/project`        | Accept a projectId string or null; update membership only, preserving cwd even for running agents.                                                                                            |
| `POST /api/agents`                     | Accept optional projectId. Copy the named project's defaultCwd into the new agent; omission/null uses a managed ungrouped workspace. Reject client attempts to override inherited cwd.        |
| `GET /api/directories?path=…&cursor=…` | Browse the connected server's directories, returning canonical current path, parent, and a bounded page of child directories. Omitted path opens the server user's home without selecting it. |

- [ ] Keep `PATCH /api/agents/:id` profile behavior intact; it does not implicitly change membership. Use the separate membership route for “Move to project…”. Return 400 for malformed input, 404 for missing referenced records, and 409 for duplicate normalized names.
- [ ] Implement a read-only directory listing service using filesystem APIs rather than shell commands, with bounded/paginated results, stable directory ordering, canonical path handling, optional hidden folders and clear not-found/not-directory/permission errors. Use existing API session/origin protections and the managed-browser exclusion; listing a directory never uploads or returns file contents. Validate paths independently on mutation, not just during browsing.
- [ ] Include projects and nullable projectId values in `/api/state`. Keep the full agent directory independent of the UI filter so counts and background status remain available.
- [ ] Add `GET /api/state?selection=none` to return directories/configuration but null selectedAgentId and empty selected-history collections. Reject simultaneous `selection=none` and agentId. Preserve legacy no-query default selection. Internally distinguish undefined (legacy default), null (explicit none), and an explicit agent ID.
- [ ] Support scoped archive pagination, e.g. `scope=all|ungrouped|project` with projectId required only for project scope. Apply scope filtering before the existing ID cursor/limit; reset pagination when scope changes.
- [ ] Persist global `project_created`, `project_updated`, and `project_deleted` activity with null agentId/runId, plus `agent_project_changed` for explicit membership moves. Emit only after commit. A project-deleted event causes clients to reload memberships together; do not stream a half-deleted group.
- [ ] Extend optional [WebMCP](../src/client/webmcp.ts) reads to expose the snapshot's projects. Allow explicit optional projectId on agent creation, defaulting to ungrouped; do not silently inherit hidden UI scope. Project-mutation browser tools are not required for this release.

### 3. Client state and interface

- [ ] Introduce scope/selection state helpers and small `ProjectSwitcher` / project-management components rather than embedding all behavior into the existing App component.
- [ ] Implement instance-scoped navigation preferences, recent projects and last agent per scope. Restore them after instance identity and valid records are known; tolerate unavailable localStorage.
- [ ] Derive agent rows/counts locally and implement the desktop popover, mobile sheet and direct-from-chat project button. Add empty project/create/add-existing flows and the optional create-agent Project field.
- [ ] Add a reusable server-directory picker to create/edit project flows; require “Use this folder”, preserve form input when canceled, identify the connected instance, and display the selected canonical path. Show inherited cwd in agent creation and effective cwd in agent details.
- [ ] Preserve per-agent drafts, pending request IDs and existing send-target capture across rapid switches. Keep mutation completion/error handling tied to its originating agent so late replies cannot clear another agent's draft or report an error in the wrong chat.
- [ ] Separate the instance SSE subscription from selected-history requests. Keep one stream per instance while switching scopes/agents; retain cursor-reset recovery, request-generation guards and fresh snapshots. Avoid clearing the agent directory while loading another conversation.
- [ ] Reconcile remote project rename/delete/membership events and stale selections. Clear scoped history before presenting a newly selected agent, and never enable send against an off-scope or stale snapshot.
- [ ] Add archive scope, membership actions and clear delete-project copy. Keep project and instance selectors distinct.

### 4. Run startup and shared-directory behavior

- [ ] Centralize effective-cwd resolution/validation. Pass the same agent.cwd to Harness, Pi's resource loader/session/tools, subagents and intervention tools (including sudo), rather than rebuilding paths in several places. Verify actual execution with `pwd` and relative file access, not only metadata.
- [ ] Preserve automatic mkdir only for Jelly-managed legacy/ungrouped workspaces. Never auto-create or replace a missing user-selected project directory. Fail a run cleanly if its recorded directory is unavailable.
- [ ] Keep histories, contexts, credentials and Jelly-generated runtime configuration in instance/per-agent storage. Refactor configurePiWorkspace and parent/subagent configuration propagation so concurrent agents sharing cwd cannot race on `.pi/settings.json` or its temp file, overwrite user settings, or leak model/effort between runs. Respect supported project-local resource loading and verify SDK behavior during implementation.
- [ ] Make cwd immutable for existing agents in this feature. Updating a project's default, reassigning membership, restoring an archived agent or deleting a project does not retarget a running session or its next run.

### 5. Verification and delivery

- [ ] Extend server/restart coverage for v4→v5 and fresh-database migration, nullable membership, duplicate names, invalid references, rename, and scoped archive pagination. Verify projects and membership survive restart and old conversations remain readable.
- [ ] Test folder navigation/confirmation/cancel, breadcrumbs, hidden directories, symlinks, pagination, inaccessible/missing/non-directory targets and server-versus-client filesystem identity. Verify folder browsing is read-only and follows the API's existing access boundaries.
- [ ] Verify all new project agents, including API/WebMCP-created agents, execute `pwd` in the selected directory and see the same fixture files; default changes affect only later creations, even under concurrent requests. Confirm ungrouped and migrated agents keep legacy paths after restart.
- [ ] Test relative file operations, subagent cwd, intervention/sudo cwd and restart recovery. Run two agents concurrently against one fixture project and confirm independent histories/configuration, preserved pre-existing `.pi` contents and no temporary-file races. Test missing directories at creation and run startup without silent fallback or recreation.
- [ ] Test deletion with both active and archived members: every agent/history/context survives, membership becomes null, and a running/waiting agent continues unchanged. Test metadata moves while profile edits remain restricted.
- [ ] Test client All agents/Ungrouped/project filters, empty scope with no accidental default conversation, rapid A→B→A switching, remembered selections, drafts, in-flight sends and late history responses. Verify a switch does not send stop/restart requests or reconnect the instance event stream.
- [ ] Test multi-client rename/delete/move reconciliation, invalid persisted selection, storage failure, reconnect/replay reset, and instance-isolated preferences.
- [ ] Test keyboard navigation, selected-state announcements, focus return, mobile direct-from-chat switching, 44px hit targets and 360px-wide layout. Use a real browser for both themes and a keyboard-open mobile sheet; verify no horizontal overflow.
- [ ] Run `bun run check` after implementation. Put new tests in the existing server/client/restart suites, or update package.json if adding a new suite so the standard check includes them. This planning-only change does not claim those implementation checks have run.
- [ ] Update usage documentation and move delivered work to plans_done when it ships; leave only outstanding items in plans/.

## Exit criteria

- Users with no projects can create and use agents exactly as before; no setup step is added.
- Creating a project requires an explicit directory selection in a server-backed folder browser. Every agent newly created in that project starts in the selected folder and retains that effective cwd across restarts.
- Changing the project default only affects future agents; regrouping/deleting projects preserves existing agent directories and files. Multiple agents can use the same selected folder with isolated Jelly session/runtime state.
- A visible project can be selected in two taps/clicks from the desktop sidebar, mobile list or mobile chat. Filtering updates immediately from cached data; history loads without showing the previous scope's content.
- All agents remains one switch away. Projects can be empty; agents can be ungrouped. Counts and background working/needs-help status stay understandable.
- Membership persists across restart. Switching and regrouping preserve agent identity, conversations, drafts during the session and active work.
- Deleting a project preserves every member and its history, including archived members. Stale clients recover to a valid view without cross-agent sends.

## Later, if needed

Nested projects, multi-project membership, file synchronization, shared conversation memory/instructions, changing an existing agent's cwd, per-project models, permissions, collaboration, project-level execution and cross-instance project sync are not part of this feature. Sharing the selected working directory among newly created project agents is included.
