import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { mkdirSync, chmodSync } from "node:fs";
const dataDir = resolve(process.env.JELLY_DATA_DIR ?? ".jelly");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const authPath = process.env.JELLY_AUTH_FILE ?? join(dataDir, "auth.json");
const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  const auth = await ModelRuntime.create({ authPath, modelsPath: null });
  await auth.login("openai-codex", "oauth", {
    notify: (event) => {
      if (event.type === "auth_url")
        console.log(
          `Open this URL to connect your ChatGPT account:\n${event.url}`,
        );
    },
    prompt: (p) => rl.question(`${p.message}\n> `),
  });
  chmodSync(authPath, 0o600);
  console.log("ChatGPT connected. Choose Automatic or ChatGPT in Jelly.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Login failed.");
  process.exitCode = 1;
} finally {
  rl.close();
}
