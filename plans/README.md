# Remaining work

Only outstanding work belongs here. Keep the original phase numbers; move completed items into the corresponding [delivery record](../plans_done/README.md) as they ship, splitting partially completed tasks rather than retaining completed checkboxes.

| Phase       | Plan                                                                | Scope                                                                            |
| ----------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 2           | [Manual local-workspace validation](02-validation.md)               | User-run validation only; implementation complete                                |
| 3           | [Remote connections and multiple instances](03-remote-instances.md) | Remote authentication, saved connections, switching and remote recovery          |
| 4           | [macOS application](04-macos.md)                                    | Native packaging, server lifecycle and desktop integration                       |
| 5           | [Jelly Cloud](05-cloud.md)                                          | Accounts, billing, VM provisioning and management                                |
| 6           | [iOS companion](06-ios.md)                                          | Mobile connections, conversations, notifications and recovery                    |

Complete the local release before remote access; establish remote connections before native and hosted clients. The macOS and cloud phases can then progress independently, with iOS consuming the same server protocol.

Projects and the Familiar UI are delivered. See [the delivery record](../plans_done/02-projects.md). Original user-run local validation remains separately tracked.
