/** Subprocess fixture for crash/restart tests; never used by bun start. */
import { startApp } from "./app";
const app = await startApp({
  dataDir: process.env.JELLY_DATA_DIR!,
  configDir: process.env.JELLY_CONFIG_DIR!,
  authPath: process.env.JELLY_AUTH_FILE!,
  port: 0,
  fixtureDelayMs: 220,
});
console.log(`Jelly server: http://127.0.0.1:${app.server.port}`);
async function shutdown() {
  await app.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
