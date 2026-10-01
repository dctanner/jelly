export const MODEL_OPTIONS = [
  { id: "gpt-6-astra", label: "GPT-6 Astra" },
  { id: "gpt-6-astra-ultrafast", label: "GPT-6 Astra Ultrafast" },
  { id: "gpt-6-sol", label: "GPT-6 Sol" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
] as const;
export const EFFORT_OPTIONS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
] as const;
export type ModelId = (typeof MODEL_OPTIONS)[number]["id"];
export type Effort = (typeof EFFORT_OPTIONS)[number]["id"];
// Ultrafast is a Jelly selection, not an upstream model ID.
export function upstreamModel(
  model: ModelId,
): Exclude<ModelId, "gpt-6-astra-ultrafast"> {
  return model === "gpt-6-astra-ultrafast" ? "gpt-6-astra" : model;
}
export const ULTRAFAST_NOTICE =
  "Ultrafast requires eligible ChatGPT access (Pro 500 or Enterprise), or an OpenAI API account. Higher API pricing and separate limits apply.";
export const DEFAULT_MODEL: ModelId = "gpt-6-astra";
export const DEFAULT_EFFORT: Effort = "medium";
