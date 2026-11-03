import { setDefaultAutoSelectFamily } from "node:net";
import { setDefaultResultOrder } from "node:dns";

// Bun 1.3.9 can leave a stale Happy Eyeballs timer after a synchronous connect
// failure. It throws outside the socket's error handler and kills every run:
// TypeError: null is not an object at internalConnectMultipleTimeout.
// https://github.com/oven-sh/bun/pull/32660
// Avoid that path until our supported Bun runtime has a verified upstream fix.
// Without fallback, an unreachable first IPv6 address breaks HTTPS requests
// (including the Claude relay) even when IPv4 works. Prefer IPv4 DNS results
// while retaining IPv6-only destinations and ordinary connection errors.
if (process.versions.bun) {
  setDefaultAutoSelectFamily(false);
  setDefaultResultOrder("ipv4first");
}
