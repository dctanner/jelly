import { expect, test } from "bun:test";
import { stream as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import models from "../src/server/models.json";

// GPT-6.2 never prompt-caches the top-level Responses `instructions` field
// (openai/codex#62312). Both OpenAI routes must send the system prompt as the
// leading developer message so it is cached from the second step on.
// Codex is fixed by patches/@earendil-works%2Fpi-ai@0.87.1.patch.
const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "a" } })).toString("base64url")}.y`;
const context = {
  messages: [
    { role: "system", content: "Jelly system prompt", timestamp: 0 },
    { role: "user", content: "hi", timestamp: 1 },
  ],
} as any;

async function payload(fn: typeof codexStream, model: any) {
  let body: any;
  const events = fn(model, context, {
    apiKey: token,
    transport: "sse",
    maxRetries: 0,
    onPayload: (p: unknown) => {
      body = p;
      throw new Error("captured");
    },
  } as any);
  for await (const event of events) if (event.type === "done" || event.type === "error") break;
  return body;
}

for (const [name, fn, provider] of [
  ["openai-codex", codexStream, "openai-codex"],
  ["openai", responsesStream, "openai"],
] as const) {
  test(`${name} sends the system prompt as a leading developer message`, async () => {
    const model = { ...(models.providers as any)[provider].models[0], provider, baseUrl: "http://127.0.0.1:9" };
    const body = await payload(fn as typeof codexStream, model);
    expect(body.instructions).toBeUndefined();
    expect(body.input[0]).toEqual({ role: "developer", content: "Jelly system prompt" });
    expect(body.input[1].role).toBe("user");
  });
}
