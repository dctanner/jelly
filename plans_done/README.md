# Completed delivery records

Reconciled with the app on 23 September 2026. These records describe shipped work and its verification boundaries; outstanding tasks live in [plans/](../plans/README.md).

| Record                                                                | Delivered scope                                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [Phase 1: local foundation](01-local-foundation.md)                   | Bun/React boundary, Pi execution, SQLite persistence, event replay, restart recovery and themes               |
| [Phase 2: core workspace and connections](02-core-workspace.md)       | Agent profiles/history, ChatGPT/API settings, model/effort controls and installation documentation            |
| [Phase 2: administrator and browser handoffs](02-interventions.md)    | Automatic sudo with password fallback, managed Linux browser and private VNC login handoffs                   |
| [Phase 2: Pi tools, subagents and SDK upgrade](02-pi-capabilities.md) | Full native tools/resources, automatic execution, pi-subagents and Pi 0.87.1                                  |
| [Phase 2: lifecycle and durable history](02-local-lifecycle.md)       | Archiving/restoration, Pi compaction checkpoints, history pagination, replay retention and instance ownership |
| [Tailscale development access](03-tailscale-dev.md)                   | HTTP access on tailnet addresses with local access, hot reload and streaming transport                        |
| [Subagent observability](07-subagent-observability.md)               | Live cards, bounded transcripts, five-minute parent model checkpoints and interactive lifecycle ownership     |

Phase 2 implementation is complete; the [manual validation checklist](../plans/02-validation.md) is left to the user. Server-owned execution, stable instance identity and reconnect/replay were delivered with Phase 1 even though they also appeared in the original Phase 3 plan. Their remote extensions are tracked in the remaining Phase 3 plan.

## Projects and Familiar UI

[Delivery record](02-projects.md) · [Design package](../design/README.md) · [Original feature plan](02-projects-plan.md).

[Mobile controls and composer](mobile-input-and-overlays.md): full-width drafts,
conversation-space reservation, viewport-bounded overlays, and focus-zoom prevention.
