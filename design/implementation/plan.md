# UI and Projects implementation

Status: implemented in the application, September 2026. Design sources remain in this package; production code is authoritative for behavior. [Verification record](verification.md).

## Delivery sequence and source mapping

1. **Brand foundations:** `public/brand/`, `src/shared/avatars.ts`, semantic light/dark roles in `src/client/styles.css`. Ordinary Nunito wordmark, Friendly bell mark, twelve persisted avatar IDs, safe fallback for older agents.
2. **Durable Projects:** SQLite migration v5 in `src/server/store.ts`, shared project/cwd/avatar types, global project events and transactional membership changes. Migration backfills legacy workspace paths without moving files.
3. **Directory contract:** `src/server/directories.ts` canonicalizes and validates server directories, lists directory-only pages and validates execution cwd. Project mutation and directory browser use the existing control-session/CSRF/origin/managed-browser protections.
4. **Execution:** Harness, loader, session, tools and intervention tools receive persisted cwd. Managed workspaces alone get automatic mkdir. Runtime subagent defaults are injected per session into tool arguments; no generated `.pi/settings.json` is written into a selected project. Private session roots remain under the instance data directory.
5. **Navigation:** `project-state.ts`, `Projects.tsx`, and App keep full cached agent/project directories, optional scopes, instance-scoped preferences, last selections, recent projects and per-agent drafts. One SSE connection is independent of chat selection; explicit empty snapshots prevent accidental fallback.
6. **Product surfaces:** responsive sidebar/list/chat, searchable project picker, project create/edit/delete, explicit server-folder picker, add/move agent, avatar chooser, scoped archive, light/dark, private Computer panel and handoff states. Safe assistant text rendering lives in `MessageText.tsx`.
7. **Motion:** public [transitions.dev skill](https://transitions.dev/skill.html) recipes from its [source repository](https://github.com/Jakubantalik/transitions.dev/tree/main/skills/transitions-dev). Exact recipe CSS is vendored in `src/client/motion/transitions.css`; `Modal.tsx` keeps close-state cleanup and reads durations from CSS. Mobile pages use page-slide hooks; Computer uses panel-slide. Jelly working motion is brand-specific.
8. **Validation and release:** standard `bun run check`, meaningful project/client/capability tests, and isolated real-browser review. `scripts/design-preview.ts` creates disposable demo records and serves the built app without using `.jelly`.

## Contract and guardrails

A new project agent copies the authoritative project default in its creation transaction. Later default edits, membership moves, project deletion, archive and restore never change its cwd. A selected missing folder is never recreated or substituted. Deletion only removes group metadata. Project agents deliberately share filesystem contents; their histories and sessions remain separate.

Native dialogs handle focus containment and Escape. Keyboard switching focuses search; pointer switching avoids automatically raising the mobile keyboard. Inactive mobile pages are inert. All motion honors reduced-motion preferences. Text and code from model/tool output are rendered without HTML injection.

The original detailed project requirements are preserved in `../../plans_done/02-projects-plan.md`; delivered behavior is recorded in `../../plans_done/02-projects.md`. Remote instances, native packaging, changing an existing agent's cwd, nested projects, and shared conversation memory remain outside this feature.
