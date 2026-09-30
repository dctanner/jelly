import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { mkdirSync, chmodSync } from "node:fs";
const dataDir = resolve(process.env.JELLY_DATA_DIR ?? ".jelly");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const authPath = process.env.JELLY_AUTH_FILE ?? join(dataDir, "auth.json");
try {
  const auth = await ModelRuntime.create({ authPath, modelsPath: null });
  await auth.login("openai-codex", "oauth", {
    notify: (event) => {
      if (event.type === "device_code")
        console.log(
          `Open ${event.verificationUri} and enter code ${event.userCode}.\nWaiting for approval…`,
        );
    },
    prompt: async (p) => {
      if (p.type === "select" && p.options.some((o) => o.id === "device_code"))
        return "device_code";
      throw new Error("Device-code login is unavailable.");
    },
  });
  chmodSync(authPath, 0o600);
  console.log("ChatGPT connected. Choose Automatic or ChatGPT in Jelly.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Login failed.");
  process.exitCode = 1;
}
