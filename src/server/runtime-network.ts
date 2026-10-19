import { setDefaultAutoSelectFamily } from "node:net";

// Bun 1.3.9 can leave a stale Happy Eyeballs timer after a synchronous connect
// failure. It throws outside the socket's error handler and kills every run:
// TypeError: null is not an object at internalConnectMultipleTimeout.
// https://github.com/oven-sh/bun/pull/32660
// Avoid that path until our supported Bun runtime has a verified upstream fix.
// This does not force IPv4, change DNS, or suppress ordinary connection errors.
if (process.versions.bun) setDefaultAutoSelectFamily(false);
