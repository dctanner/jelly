import { publicOrigins } from "../src/shared/network";
import { forwardTailnet, tailscaleNetwork } from "./tailscale";

// Serve the built client and API together, with no file watchers.
const port = Number(process.env.JELLY_PORT ?? 5173);
const tailnet = process.env.JELLY_TAILSCALE === "1"
  ? await tailscaleNetwork(port)
  : null;
const origins = [...new Set([
  ...publicOrigins(process.env.JELLY_PUBLIC_ORIGINS),
  ...(tailnet?.origins ?? []),
])];
const api = Bun.spawn([process.execPath, "src/server/index.ts"], {
  env: {
    ...process.env,
    JELLY_DEV: "0",
    JELLY_PORT: String(port),
    JELLY_PUBLIC_ORIGINS: origins.join(","),
  },
  stdout: "inherit",
  stderr: "inherit",
});
let closeProxy = async () => {};
let stopping: Promise<void> | undefined;
const stop = () => (stopping ??= (async () => {
  api.kill();
  await closeProxy();
  await api.exited;
})());
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
try {
  if (tailnet) {
    closeProxy = await forwardTailnet(tailnet.addresses, port);
    if (stopping) await closeProxy();
    console.log(`Jelly over Tailscale: ${tailnet.origins[0]}`);
  }
  const code = await api.exited;
  await stop();
  process.exit(code);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await stop();
  process.exit(1);
}
