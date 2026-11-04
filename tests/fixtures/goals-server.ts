/** Crash-test server: local scripted parent responses only; no real provider calls. */
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { startApp } from "./app";
const app = await startApp({
  dataDir: process.env.JELLY_DATA_DIR!,
  configDir: process.env.JELLY_CONFIG_DIR!,
  authPath: process.env.JELLY_AUTH_FILE!,
  port: 0,
});
const create = app.service.harness.create.bind(app.service.harness);
app.service.harness.create = async (...args) => {
  const session = await create(...args);
  session.settingsManager.applyOverrides({
    compaction: { enabled: true, keepRecentTokens: 0, reserveTokens: 1 },
  });
  session.agent.streamFunction = (model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    setTimeout(() => {
      const aborted = options?.signal?.aborted;
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        model: model.id,
        provider: model.provider,
        content: [{ type: "text", text: "Local crash fixture progress" }],
        timestamp: Date.now(),
        stopReason: aborted ? "aborted" : "stop",
        usage: {
          input: 2000000,
          cacheWrite: 3,
          cacheRead: 100,
          output: 5,
          totalTokens: 2000108,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      if (aborted)
        stream.push({ type: "error", reason: "aborted", error: message });
      else stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    }, 200);
    return stream;
  };
  return session;
};
console.log(`Jelly goals fixture: ${app.server.url.origin}`);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
