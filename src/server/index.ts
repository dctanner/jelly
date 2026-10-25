import { tailscaleNetwork } from "../../scripts/tailscale";
import { publicOrigins } from "../shared/network";
import { resolve } from "node:path";
import { startApp } from "./app";
const dataDir = resolve(process.env.JELLY_DATA_DIR ?? ".jelly");
process.env.PI_CODING_AGENT_DIR = dataDir;
process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = resolve(
  import.meta.dir,
  "../../node_modules/@earendil-works/pi-coding-agent",
);
const port = Number(process.env.JELLY_PORT ?? 3100);
const tailnet = process.env.JELLY_TAILSCALE === "1" ? await tailscaleNetwork(port) : null;
const app = await startApp({
  dataDir,
  authPath: process.env.JELLY_AUTH_FILE,
  schedulerOptions: { concurrency: Number(process.env.JELLY_SCHEDULE_CONCURRENCY ?? 2) },
  port,
  listenAddresses: tailnet?.addresses,
  allowedOrigins: [
    ...publicOrigins(process.env.JELLY_PUBLIC_ORIGINS),
    ...(tailnet?.origins ?? []),
    ...(process.env.JELLY_DEV === "1"
      ? ["http://127.0.0.1:5173", "http://localhost:5173"]
      : []),
  ],
});
console.log(`Jelly server: http://127.0.0.1:${app.server.port}`);
if (tailnet) console.log(`Jelly over Tailscale: ${tailnet.origins[0]}`);
console.log(`Model access: ${app.service.snapshot().config.notice}`);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
