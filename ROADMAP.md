# Jelly delivery roadmap

The local foundation and Phase 2 feature implementation are complete. Phase 2 manual validation remains with the user. Plans are split by actual delivery status:

- [plans/](plans/README.md) contains only outstanding work, grouped by the original phase numbers.
- [plans_done/](plans_done/README.md) records implemented requirements, evidence and verification limits.

| Phase                    | Status                                                                                         | Record / remaining plan                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Local foundation     | Complete                                                                                       | [Delivery](plans_done/01-local-foundation.md)                                                                                                                                                                                                     |
| 2 — Core agent workspace | Implementation complete; manual validation pending                                             | [Workspace](plans_done/02-core-workspace.md), [handoffs](plans_done/02-interventions.md), [Pi capabilities](plans_done/02-pi-capabilities.md), [lifecycle/history](plans_done/02-local-lifecycle.md); [manual validation](plans/02-validation.md) |
| 3 — Remote instances     | Local prerequisites and Tailscale dev access delivered; remote instance management outstanding | [Foundation](plans_done/01-local-foundation.md), [Tailscale dev](plans_done/03-tailscale-dev.md); [remaining](plans/03-remote-instances.md)                                                                                                       |
| 4 — macOS app            | Outstanding                                                                                    | [Plan](plans/04-macos.md)                                                                                                                                                                                                                         |
| 5 — Jelly Cloud          | Outstanding                                                                                    | [Plan](plans/05-cloud.md)                                                                                                                                                                                                                         |
| 6 — iOS companion        | Outstanding                                                                                    | [Plan](plans/06-ios.md)                                                                                                                                                                                                                           |

Phases 1–2 define the initial local release. Every UI is a client of a server that owns execution and durable state. Native packaging, cloud management and mobile clients build on that boundary; local and self-hosted use remain independent of Jelly Cloud.

When a task ships, move its completed scope and evidence into `plans_done/` and remove it from `plans/`. Keep architecture and design references in [docs/](docs/ARCHITECTURE.md).
