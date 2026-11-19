import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { clampThinkingLevel, type Model } from "@earendil-works/pi-ai";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const INPUT_LIMITS = {
  maxRequestBytes: 20971520,
  images: { maxPerRequest: 3600, resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } },
};

/**
 * Gemini 4 cohort (Gemini API, Nov 2026). The pinned Pi catalog predates it.
 * Synchronous output is capped at 64K per request; input/thinking/output share
 * a 1M window. Carbon/Argon list their standard (post-introductory) rates.
 * https://ai.google.dev/gemini-api/docs/thinking, /docs/pricing
 */
const GEMINI_4 = [
  { id: "gemini-4-carbon", name: "Gemini 4 Carbon", xhigh: false, cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 } },
  { id: "gemini-4-neon", name: "Gemini 4 Neon", xhigh: true, cost: { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 } },
  { id: "gemini-4-argon", name: "Gemini 4 Argon", xhigh: false, cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 } },
  { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", xhigh: true, cost: { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 } },
] as const;
const GEMINI_4_IDS = new Set<string>(GEMINI_4.map((model) => model.id));

function gemini4Models(): Model<"google-generative-ai">[] {
  return GEMINI_4.map(({ id, name, xhigh, cost }) => ({
    id,
    name,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: BASE_URL,
    reasoning: true,
    // Gemini 4 cannot disable thinking; low is the lightest level.
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: xhigh ? "xhigh" : null, max: null },
    input: ["text", "image"],
    cost,
    contextWindow: 1048576,
    maxTokens: 65536,
    inputLimits: INPUT_LIMITS,
  }) as Model<"google-generative-ai">);
}

/** Pi's built-in Gemini API provider plus the Gemini 4 cohort. */
export function createJellyGeminiProvider() {
  const provider = googleProvider();
  const withGemini4 = <T extends { id: string }>(models: readonly T[]): T[] => [
    ...models.filter((model) => !GEMINI_4_IDS.has(model.id)),
    ...(gemini4Models() as unknown as T[]),
  ];
  return {
    ...provider,
    getModels() {
      return withGemini4(provider.getModels());
    },
    filterModels(
      list: Parameters<NonNullable<typeof provider.filterModels>>[0],
      credential: Parameters<NonNullable<typeof provider.filterModels>>[1],
    ) {
      const kept = new Set((provider.filterModels?.(list, credential) ?? list).map((model) => model.id));
      return list.filter((model) => kept.has(model.id) || GEMINI_4_IDS.has(model.id));
    },
    // Pi's Google adapter only emits discrete thinking levels for Gemini 3 IDs
    // and has no XHIGH. Set Gemini 4's documented thinkingLevel at the wire.
    streamSimple(...[model, context, options]: Parameters<typeof provider.streamSimple>) {
      if (!GEMINI_4_IDS.has(model.id)) return provider.streamSimple(model, context, options);
      const requested = options?.reasoning ?? "low";
      const thinkingLevel = clampThinkingLevel(model, requested).toUpperCase();
      return provider.streamSimple(model, context, {
        ...options,
        reasoning: "high",
        onPayload: async (payload, payloadModel) => {
          const params = ((await options?.onPayload?.(payload, payloadModel)) ?? payload) as { config?: Record<string, unknown> };
          return { ...params, config: { ...params.config, thinkingConfig: { includeThoughts: true, thinkingLevel } } };
        },
      });
    },
  };
}

export default function jellyGemini(pi: ExtensionAPI) {
  pi.registerProvider(createJellyGeminiProvider());
}
