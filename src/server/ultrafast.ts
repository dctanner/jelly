import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

/** Pi's simple adapters do not forward serviceTier. Apply it at the wire boundary
 * for both Responses and Codex, preserving any existing payload hook. */
export function ultrafastOptions(options: SimpleStreamOptions): SimpleStreamOptions {
  return {
    ...options,
    onPayload: async (payload, model) => {
      const transformed = (await options.onPayload?.(payload, model)) ?? payload;
      if (
        model.id === "gpt-6-astra" &&
        (model.provider === "openai" || model.provider === "openai-codex")
      ) {
        return { ...(transformed as Record<string, unknown>), service_tier: "ultrafast" };
      }
      return transformed;
    },
  };
}
