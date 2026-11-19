import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJellyGeminiProvider } from "../src/server/gemini-provider";
import { Harness } from "../src/server/harness";
import { compatibleModel, defaultModelForMode, effortsForModel, modelsForMode } from "../src/shared/models";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("Gemini mode offers only the Gemini 4 cohort", () => {
  expect(modelsForMode("gemini").map((m) => m.id)).toEqual([
    "gemini-4-carbon", "gemini-4-neon", "gemini-4-argon", "gemini-4-hydrogen",
  ]);
  expect(defaultModelForMode("gemini")).toBe("gemini-4-hydrogen");
  expect(compatibleModel("api", "gemini-4-carbon")).toBe(false);
  expect(compatibleModel("gemini", "gpt-6-astra")).toBe(false);
  expect(effortsForModel("gemini-4-hydrogen").map((e) => e.id)).toEqual(["low", "medium", "high", "xhigh"]);
  expect(effortsForModel("gemini-4-carbon").map((e) => e.id)).toEqual(["low", "medium", "high"]);
});

test("harness resolves Gemini models and reports missing key", async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const harness = await Harness.create(mkdtempSync(join(tmpdir(), "jelly-gemini-")));
    for (const { id } of modelsForMode("gemini")) expect(harness.registry.find("google", id)?.id).toBe(id);
    const config = harness.config("gemini", { model: "gemini-4-neon", effort: "high" });
    expect(config).toMatchObject({ provider: "google", model: "gemini-4-neon", ready: false, geminiReady: false });
  } finally {
    if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
  }
});

test("Gemini 4 sends discrete thinking levels, clamped per model", async () => {
  const provider = createJellyGeminiProvider();
  const cases = [
    ["gemini-4-hydrogen", "xhigh", "XHIGH"],
    ["gemini-4-carbon", "xhigh", "HIGH"],
    ["gemini-4-argon", "minimal", "LOW"],
    ["gemini-4-neon", "medium", "MEDIUM"],
  ] as const;
  for (const [id, reasoning, expected] of cases) {
    let body = "";
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      body = String(init?.body ?? "");
      return new Response("{}", { status: 400 });
    }) as unknown as typeof fetch;
    const model = provider.getModels().find((m) => m.id === id)!;
    const context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as unknown as Parameters<typeof provider.streamSimple>[1];
    await provider.streamSimple(model, context, {
      apiKey: "test-key-0000000000000000", reasoning, maxRetries: 0,
    }).result();
    expect(JSON.parse(body).generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: expected });
  }
});
