# Phase 2 — Agent lifecycle and durable history delivered

## Agent archiving

Schema v4 adds `agents.archivedAt`. Archive and restore actions retain the profile, conversation, working directory and model context. The active sidebar excludes archived agents; **Archived agents** opens a paginated list, and selecting one opens its history with a **Restore agent** action. Archived agents cannot accept new messages.

The server rejects archiving while the agent is running or waiting, including subagent settlement. Checking run state and writing the archive state are synchronous, so accepting a new run cannot interleave with archiving. The UI explains that work must finish or be stopped first. Repeated archive/restore requests are idempotent.

Implementation: [store](../src/server/store.ts), [service](../src/server/service.ts), [API](../src/server/app.ts), [client](../src/client/App.tsx).

## Pi compaction with SQLite persistence

Real model sessions enable [Pi's native compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md), including threshold and overflow handling. The credential-free scripted demo leaves compaction off. Compaction boundaries produce activity updates without streaming text deltas.

A successful run atomically stores its Pi working-context checkpoint in SQLite with the run's terminal state. The checkpoint retains entry IDs, compaction summaries, kept messages, context edits and extension metadata. Summarized message prefixes are omitted from the working checkpoint; the original messages and activity remain in the durable archive. Subsequent sessions use Pi's public in-memory entry loader to reconstruct the context. Existing databases bootstrap from completed raw messages until their first successful checkpoint.

Failed, cancelled and interrupted runs retain their visible activity but cannot replace the last successful checkpoint. Stopping a run aborts compaction as well as the model and child work. No parent Pi JSONL transcript is created; child plugin artifacts retain their separate ownership.

Implementation: [harness](../src/server/harness.ts), [service](../src/server/service.ts), [store](../src/server/store.ts).

## Bounded snapshots and event replay

Schema v4 preserves existing agent activity in a separate `timeline` table before trimming the transport log. New timeline/replay writes are atomic. Conversation history is retained and read in pages of 100 entries using event IDs as stable cursors. Snapshots include the latest page, its relevant runs, and bounded intervention records. **Older activity** and **Back to latest** navigate history without accumulating the whole conversation in the browser.

The replay log retains the newest 10,000 event IDs. SSE reads in batches of 512 and bounds its queue by bytes. Expired or ahead-of-server cursors receive a `reset` event; the React client reloads its authoritative snapshot and reconnects from that cursor. Transport failures likewise reconnect from a fresh snapshot. Compaction and replay retention do not erase the conversation archive; disk usage for raw history can continue to grow.

Implementation: [store](../src/server/store.ts), [API/SSE](../src/server/app.ts), [client](../src/client/App.tsx), [shared protocol](../src/shared/types.ts).

## One server owner per data directory

Before opening application storage, initializing Pi or recovering runs, startup holds an exclusive SQLite transaction on a dedicated `server-lock.sqlite` file in the canonical data directory. Competing servers receive an actionable error even when they use different ports or symlink aliases. Separate data directories remain independent.

The lock lasts through server shutdown and is released on startup failure. OS lock release after process death enables recovery without deleting stale PID files or using a time-based lease. The lock file must never be manually deleted while a server is running.

Implementation: [instance ownership](../src/server/instance-lock.ts) and [startup/cleanup](../src/server/app.ts).

## Delivery evidence and validation boundary

Source integration and TypeScript compilation were reviewed; the production client was built. No test suite, real-browser QA, live model/compaction run, forced-crash exercise or password authentication was performed for this delivery. The user requested manual validation, which remains in [plans/02-validation.md](../plans/02-validation.md).
