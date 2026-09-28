# Verification record — 23 September 2026

`bun run check` passed on the delivered source: TypeScript, **42 tests** (29 server/integration, 11 client, 2 capability), and Vite production build.

## Requirement audit

| Requirement | Implementation / evidence |
| --- | --- |
| Friendly bell, regular wordmark, 12 avatars | Public brand assets, persisted avatar IDs; profile UI test and desktop/mobile captures. |
| Familiar desktop and mobile UI, light/dark | 280/304 px sidebar, separate inert mobile pages, direct chat project control, blue bubbles, safe rich text; captures at 1440 × 960 and 390 × 844. |
| transitions.dev interaction motion | Vendored dropdown/modal/panel/page recipes, native dialog orchestration, CSS-duration cleanup and reduced-motion guards. Browser verified animated dismiss/focus return. |
| Working sea detail and Easter egg | Active-only jelly float/bubble, static handoff mark, one user-triggered brand bob. Existing server status remains authoritative. |
| Optional Projects and quick switching | Cached filters, recent/remembered selection, All agents and Ungrouped, counts, search, Cmd/Ctrl+K. Browser keyboard search/ArrowDown/Escape and automated single-stream checks. |
| Server directory browser | Canonical paths, explicit selection, Home/parent/breadcrumbs, hidden toggle, 100-entry pages, invalid paths, symlinks and empty folders covered. Mobile pinned action reviewed. |
| New agents inherit project cwd | Atomic server copy; API and UI integration coverage. Browser changed Website default to its docs folder: new-agent form showed docs, existing Milo still showed Website. |
| Preserve existing cwd/files/history | Migration, default edits, busy membership moves, archived-member deletion, restart readback and unchanged file assertions pass. |
| Shared folder, isolated runtime | Two real Harness sessions execute `pwd` and relative reads in one folder; pre-existing `.pi/settings.json` remains byte-identical. Concurrent child runs preserve distinct high/low reasoning defaults. |
| Draft and selection safety | A→B→A drafts, empty-scope no fallback, one SSE connection, remote move/delete reconciliation, delayed history response test. Mutation targets captured independently of subsequent selection. |
| Access boundaries | Directory reads require a control session; project mutations/moves require CSRF. Origin and managed-browser exclusions tested. No project operation copies, moves or deletes selected files. |
| Relevant states | Existing loading, working, waiting, tool completion/failure, interrupted, stopped, archived, connection, private handoff and Computer states retained and restyled. Stop pending added. |

## Browser review

Used the production build via `scripts/design-preview.ts` with a disposable server/database, without modifying the user's agents or using model credentials. Checked desktop light/dark, mobile list/chat, direct project switching, project settings, directory navigation/empty selection, inherited paths, avatar choices, and Escape return to the trigger. Ctrl+K focuses project search; ArrowDown focuses the first choice.

At 390 × 844 and 360 × 640, document scroll width equaled viewport width; no horizontal overflow. Fixed mobile page overflow, compacted header actions and corrected checkbox sizing during review. Final captures are in [the implemented screen gallery](../screens/implemented/index.html).

The mobile checks use browser viewport emulation. A physical iOS software keyboard and formal assistive-technology audit were not performed. Original unrelated user-run lifecycle/provider validation remains in `plans/02-validation.md`.

## Package integrity

44 original exploration files were verified byte-for-byte against `output/`. The fixture explorer inventories 40 scenarios; its state data and local links are included. Production screenshots use illustrative fixture conversation content. Font and Lucide licenses are retained; public transitions.dev source recipes and URLs are recorded.

Two legacy test harness issues were corrected while running the standard check: the v2 migration fixture now really removes later schema additions, and SSE tests abort the request before canceling the reader so Bun releases the streaming connection. The future-cursor test now verifies the server's existing reset-event contract.
