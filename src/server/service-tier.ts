import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

/** Pi's simple adapters do not forward serviceTier. Apply it at the wire boundary
 * for both Responses and Codex, preserving any existing payload hook. */
export function serviceTierOptions(
  options: SimpleStreamOptions,
  tier: "priority" | "ultrafast" | undefined,
): SimpleStreamOptions {
  if (!tier) return options;
  return {
    ...options,
    onPayload: async (payload, model) => {
      const transformed = (await options.onPayload?.(payload, model)) ?? payload;
      if (
        (tier === "priority" || ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.2-astra", "gpt-6.2-sol"].includes(model.id)) &&
        (model.provider === "openai" || model.provider === "openai-codex")
      ) {
        return { ...(transformed as Record<string, unknown>), service_tier: tier };
      }
      return transformed;
    },
  };
}
