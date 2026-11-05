import { join } from "node:path";
import { startApp } from "./app";

const dir = process.env.JELLY_DATA_DIR!;
const app = await startApp({
  dataDir: dir,
  authPath: join(dir, "auth.json"),
  configDir: join(dir, "config"),
  port: 0,
  fixtureDelayMs: 10000,
});
console.log(`Jelly human todos fixture: ${app.server.url.origin}`);
process.on("SIGTERM", async () => {
  await app.close();
  process.exit(0);
});
