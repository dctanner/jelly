# Parent-scoped subagent cleanup

Jelly embeds multiple independent Pi parent sessions in one server process. A parent finishing, failing, or being cancelled must not stop another parent's children.

## Pinned dependency patch

`patches/pi-subagents@0.71.0.patch` is registered in `package.json` and `bun.lock`. Bun applies it on installation; it is not an untracked edit to `node_modules`.

The upstream 0.71.0 extension called process-global `disposeChildSessions()` from every parent's `session_shutdown` handler. Native children of an async workflow can run in-process, so an unrelated parent finishing could abort them with `Request was aborted`. Resuming a child in a separate runner process hid the issue without fixing ownership.

The patch:

- Gives each top-level extension runtime and child-fanout runtime its own placement-aware child factory.
- Passes that factory through the executor to foreground child execution.
- Closes admission before owner shutdown and waits for already-started creation. Late-created children are aborted/disposed rather than returned for prompting.
- Rejects prompting a child already marked shut down by its owner.
- Refuses detachment until the child exists and can be marked detached, or once owner shutdown has begun. This prevents publishing an accepted detach receipt that cleanup cannot honor.
- Keeps shutdown idempotent and preserves the existing explicitly detached-child lifecycle.

It does not disable cleanup, extend timeouts, change model selection, or make all workflow children background processes.

## Regression checks

- `bun test tests/subagent-ownership.test.ts`: owner isolation, normal child completion, idempotent shutdown, shutdown during creation, failed creation, admission closure, refusal of detachment during creation, and explicit detachment.
- `bun test tests/capabilities.test.ts`: real installed-extension integration, including a held in-process child inside an async workflow while an unrelated Jelly session is disposed. This assertion failed before the patch and passed after it. Existing cancellation, resume, native notifications, and supervisor tests remain enabled.
- `bun run check:full`: TypeScript, the complete configured test suite, and both builds before activation.

The patch was also verified with a fresh temporary `bun install --frozen-lockfile --ignore-scripts` followed by the ownership tests, without using live credentials or sessions.

When upgrading pi-subagents, check whether upstream has fixed owner-scoped cleanup and pending-launch races. Remove/rebase this version-specific patch deliberately and rerun both regression files. Do not drop it merely because a fresh dependency install succeeds.

## Activation

Already-loaded server modules are not hot-reloaded. Activate through Jelly's idle-aware restart helper only after checks/review pass and existing agents and restart holds allow it. Never restart inline or remove another run's hold. Until that restart, the running server can retain the old in-process shutdown behavior.
