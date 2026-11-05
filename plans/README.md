# Remaining work

Only outstanding work belongs here. Keep the original phase numbers; move completed items into the corresponding [delivery record](../plans_done/README.md) as they ship, splitting partially completed tasks rather than retaining completed checkboxes.

| Phase | Plan                                                                | Scope                                                                   |
| ----- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 2     | [Manual local-workspace validation](02-validation.md)               | User-run validation only; implementation complete                       |
| 3     | [Remote connections and multiple instances](03-remote-instances.md) | Remote authentication, saved connections, switching and remote recovery |
| 4     | [macOS application](04-macos.md)                                    | Native packaging, server lifecycle and desktop integration              |
| 5     | [Jelly Cloud](05-cloud.md)                                          | Accounts, billing, VM provisioning and management                       |
| 6     | [iOS companion](06-ios.md)                                          | Mobile connections, conversations, notifications and recovery           |

Complete the local release before remote access; establish remote connections before native and hosted clients. The macOS and cloud phases can then progress independently, with iOS consuming the same server protocol.

Projects and the Familiar UI are delivered. See [the delivery record](../plans_done/02-projects.md). Original user-run local validation remains separately tracked.

## UI validation

- [Mobile inputs and overlays: device validation](mobile-input-and-overlays.md): implementation complete; real iPhone Safari/PWA acceptance remains.

## Proposed features

- [Human todos / Needs you inbox](human-todos.md): proposed durable human-action inbox, per-agent lists, shared human/agent CRUD, explicit continuation, and existing private-handoff visibility. Planning only.
- [MCP Events and external webhooks](mcp-events.md): draft SEP-3415 client integration, durable per-agent event wakes, and Hookdeck bridge support. Poll-first without public Jelly ingress; push and signed webhook delivery follow. Research/plan only.
- [Repeating agents / scheduled tasks](repeating-agents.md): durable one-off/cron wakes, scoped tools, management UI and recovery implemented and verified; live activation and real-device/provider qualification remain pending.
- [Trusted iframe Apps launcher](apps-trusted-iframes.md): name/URL registry and iframe-only presentation implemented with disposable checks; accepts same-host cookie sharing for trusted apps. Migrations explicitly skipped because no apps/installations exist. Live activation and real-app/remote-device acceptance remain pending; see [current Apps direction](apps.md).
- [Peekaboo integration](peekaboo-integration.md): scoped desktop tools and web controls in the current Jelly web app, using an externally installed Peekaboo host on the same Mac. Independent of native Jelly packaging; not implemented.

## In-progress integration

- [Chrome integration](chrome-integration.md): shared-profile local implementation and headed fixture tests are implemented. Remaining: signed-in security/restart gates, isolated child provisioning, distribution and explicit operator activation. See the plan's implementation matrix; no normal-profile deployment has occurred.
