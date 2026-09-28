import { publicOrigins } from "../src/shared/network";
import { forwardTailnet, tailscaleNetwork } from "./tailscale";

const devPort = 5173;
if (Number(process.env.JELLY_PORT ?? 3100) === devPort)
  throw new Error(
    "JELLY_PORT is the API port and must differ from the dev UI port 5173. Use 3100 or leave it unset.",
  );
const tailnet =
  process.env.JELLY_TAILSCALE === "1" ? await tailscaleNetwork(devPort) : null;
const origins = [
  ...new Set([
    ...publicOrigins(process.env.JELLY_PUBLIC_ORIGINS),
    ...(tailnet?.origins ?? []),
  ]),
];
const env = {
  ...process.env,
  JELLY_DEV: "1",
  JELLY_PUBLIC_ORIGINS: origins.join(","),
};
// Disable explicitly when agents edit Jelly itself to avoid interrupting runs.
const watchApi = process.env.JELLY_WATCH_API !== "0";
console.log(
  watchApi
    ? "API auto-reload enabled: backend edits interrupt active agent runs."
    : "API auto-reload disabled: restart dev after backend changes when agents are idle.",
);
const api = Bun.spawn(["bun", ...(watchApi ? ["--watch"] : []), "src/server/index.ts"], {
  env,
  stdout: "inherit",
  stderr: "inherit",
});
const web = Bun.spawn(["bun", "x", "vite"], {
  env,
  stdout: "inherit",
  stderr: "inherit",
});
let closeProxy = async () => {};
let stopping: Promise<void> | undefined;
const stop = () =>
  (stopping ??= (async () => {
    api.kill();
    web.kill();
    await closeProxy();
    await Promise.all([api.exited, web.exited]);
  })());
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
try {
  if (tailnet) {
    closeProxy = await forwardTailnet(tailnet.addresses, devPort);
    if (stopping) await closeProxy();
    console.log(`Jelly over Tailscale: ${tailnet.origins[0]}`);
  }
  const code = await Promise.race([api.exited, web.exited]);
  await stop();
  process.exit(code);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await stop();
  process.exit(1);
}
