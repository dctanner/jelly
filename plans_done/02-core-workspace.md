# Phase 2 — Core workspace and model connections delivered

## Agent workspace

- Persistent agent sidebar with names, colored avatars, roles and statuses.
- Agent creation and profile editing, with role/instructions and a separate default working directory per agent.
- Per-agent conversations and activity history rather than a top-level list of chat threads.
- Message composer, completed responses, expandable tool activity, stop, waiting, failure and interruption states.
- Profiles and successful conversation context survive reloads and server restarts.
- Installation/startup instructions, environment configuration, deterministic demo, development checks and MIT license.

Agent archiving and restoration are delivered in the [lifecycle and durable history record](02-local-lifecycle.md).

## Connections and model controls

- Settings UI connects a ChatGPT subscription through Pi OAuth, with browser sign-in, cancellation, status updates and a manual callback fallback; terminal login remains available.
- OpenAI API-key entry, replacement and removal in the UI, plus server environment-key support.
- Automatic provider preference: configured ChatGPT, then API key, then explicitly labeled demo. Explicit modes report missing credentials.
- Private server-side credential storage, local session/CSRF protection, token refresh, and credential-free snapshots/events.
- GPT-6 Astra default and GPT-6 Sol selection, with Low through Max effort and Medium as the default.
- Instance-level model, access mode and effort persist and apply to agents' next runs.
- UI distinguishes subscription access from separately billed API usage.

## Verification

Implementation: [App](../src/client/App.tsx), [connection UI](../src/client/Connections.tsx), [connection service](../src/server/connections.ts), [model definitions](../src/shared/models.ts), [store](../src/server/store.ts) and [harness](../src/server/harness.ts).

Coverage: [client tests](../tests/client.test.tsx), [connection tests](../tests/connections.test.ts), [provider tests](../tests/openai.test.ts), [server tests](../tests/server.test.ts) and [restart tests](../tests/restart.test.ts). These exercise model/effort combinations against local provider fixtures, credential persistence/redaction, OAuth startup/cancellation/state, profile/history behavior and recovery.

Live ChatGPT sign-in and real Astra/Sol responses were verified during development, as was a real ChatGPT subagent response. Fixture-based API coverage does not claim a paid API-account call. Remaining account-dependent and visual checks are tracked in the outstanding plan.

Additional delivered workspace capabilities have their own records: [administrator/browser handoffs](02-interventions.md) and [Pi tools, subagents and SDK upgrade](02-pi-capabilities.md).
