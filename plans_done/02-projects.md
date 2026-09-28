# Optional Projects and Familiar UI — delivered

Projects are optional flat groups with a required default server directory. Users can create, rename, change the default folder, move agents, ungroup, and delete projects. All agents remains the default view. Deletion preserves active/archived agents, histories and files.

New project agents copy the default cwd. Existing agents retain cwd across project changes and restarts. A server folder browser provides canonical paths, breadcrumbs, Home/parent, hidden folders, pagination, explicit confirmation, and errors. Private runtime settings no longer write into shared project folders.

The approved Friendly bell and regular wordmark, twelve selectable avatars, blue/icy Familiar theme, light/dark palettes, mobile list/chat navigation, working jellyfish, responsive sheets and safe message formatting are implemented. Transitions.dev supplies modal/dropdown/panel/page recipes with reduced-motion handling.

Tests cover migration, inheritance, default updates, invalid folders, symlinks, pagination, access controls, running membership changes, deletion with archived agents, real shared-directory shell/file execution, draft preservation, single-stream switching, remote reconciliation, and per-session child reasoning defaults. Browser captures are in [design/screens/implemented](../design/screens/implemented/).

See [implementation and QA](../design/implementation/plan.md), [verification](../design/implementation/verification.md), and [original requirements](02-projects-plan.md). This delivery does not mark unrelated user-run validation in plans/02-validation.md as complete.
