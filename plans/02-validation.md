# Phase 2 — Manual validation

Original Phase 2 implementation is recorded in [plans_done/](../plans_done/02-local-lifecycle.md). These validation tasks are intentionally left for the user, as requested; no implementation remains in that delivered scope. The newly proposed [optional projects feature](../plans_done/02-projects.md) is tracked separately.

- [ ] Archive and restore an agent, review its old history, and confirm the result after restarting Jelly. Attempt archiving during running/waiting work and confirm it is rejected until the run ends or is stopped.
- [ ] Exercise a conversation large enough to trigger Pi compaction, then restart and continue. Confirm the full conversation remains browsable and the model uses its persisted compacted context. Check cancellation/failure during compaction preserves the previous successful context.
- [ ] Browse more than 100 activity entries and reconnect after more than 10,000 replay events. Confirm older conversation pages remain accessible and an expired cursor recovers from a fresh snapshot.
- [ ] Try a second server using the same data directory on another port; confirm it exits without touching the instance. Repeat after a normal shutdown and after a forced process exit to check lock recovery.
- [ ] Run real-browser visual and interaction checks for both themes, narrow screens, dialogs and keyboard navigation.
- [ ] When an API account is available, verify a real OpenAI API response and record the supported model/access combination.
- [ ] When supplying a password privately in the app, verify a successful real host sudo password handoff; keep credentials out of test records.
- [ ] Validate the optional WebMCP integration in a supporting browser when available. This optional check does not block the core workspace release.
