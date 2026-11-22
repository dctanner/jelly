export const MODEL_OPTIONS = [
  { id: "gpt-6.2-astra", label: "GPT-6.2 Astra" },
  { id: "gpt-6.2-astra-fast", label: "GPT-6.2 Astra Fast" },
  { id: "gpt-6.2-astra-ultrafast", label: "GPT-6.2 Astra Ultrafast" },
  { id: "gpt-6.2-sol", label: "GPT-6.2 Sol" },
  { id: "gpt-6.2-sol-fast", label: "GPT-6.2 Sol Fast" },
  { id: "gpt-6.2-sol-ultrafast", label: "GPT-6.2 Sol Ultrafast" },
  { id: "gpt-6-astra", label: "GPT-6 Astra" },
  { id: "gpt-6-astra-fast", label: "GPT-6 Astra Fast" },
  { id: "gpt-6-astra-ultrafast", label: "GPT-6 Astra Ultrafast" },
  { id: "gpt-6-sol", label: "GPT-6 Sol" },
  { id: "gpt-6-sol-fast", label: "GPT-6 Sol Fast" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { id: "gpt-6.1-sol-fast", label: "GPT-6.1 Sol Fast" },
  { id: "gpt-6.1-sol-ultrafast", label: "GPT-6.1 Sol Ultrafast" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "gemini-4-carbon", label: "Gemini 4 Carbon" },
  { id: "gemini-4-neon", label: "Gemini 4 Neon" },
  { id: "gemini-4-argon", label: "Gemini 4 Argon" },
  { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen" },
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
// Speed variants are Jelly selections, not upstream model IDs.
export function upstreamModel(
  model: ModelId,
): Exclude<ModelId, `${string}-fast` | `${string}-ultrafast`> {
  switch (model) {
    case "gpt-6.2-astra-fast":
    case "gpt-6.2-astra-ultrafast":
      return "gpt-6.2-astra";
    case "gpt-6.2-sol-fast":
    case "gpt-6.2-sol-ultrafast":
      return "gpt-6.2-sol";
    case "gpt-6-astra-fast":
    case "gpt-6-astra-ultrafast":
      return "gpt-6-astra";
    case "gpt-6-sol-fast":
      return "gpt-6-sol";
    case "gpt-6.1-sol-fast":
    case "gpt-6.1-sol-ultrafast":
      return "gpt-6.1-sol";
    default:
      return model;
  }
}
export function modelServiceTier(
  model: ModelId,
): "priority" | "ultrafast" | undefined {
  if (model.endsWith("-ultrafast")) return "ultrafast";
  if (model.endsWith("-fast")) return "priority";
}
export const FAST_NOTICE =
  "Fast requests priority processing. Availability depends on your account; higher API pricing applies.";
export const ULTRAFAST_NOTICE =
  "Ultrafast requires eligible ChatGPT access (Pro 500 or Enterprise), or an OpenAI API account. Higher API pricing and separate limits apply.";
export function modelSpeedNotice(model: ModelId): string | undefined {
  const tier = modelServiceTier(model);
  if (tier === "priority") return FAST_NOTICE;
  if (tier === "ultrafast") return ULTRAFAST_NOTICE;
}
export const DEFAULT_MODEL: ModelId = "gpt-6-astra";
export const DEFAULT_EFFORT: Effort = "medium";

export const MODE_OPTIONS = [
  { id: "auto", label: "Automatic (ChatGPT / OpenAI API)" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "claude-code", label: "Claude subscription" },
  { id: "api", label: "OpenAI API" },
  { id: "gemini", label: "Gemini API" },
] as const;
function modelFamily(model: string) {
  return model.startsWith("claude-") ? "claude-code" : model.startsWith("gemini-") ? "gemini" : "openai";
}
export function modelsForMode(mode: string) {
  const family = mode === "claude-code" || mode === "gemini" ? mode : "openai";
  return MODEL_OPTIONS.filter((model) => modelFamily(model.id) === family);
}
export function defaultModelForMode(mode: string): ModelId {
  return mode === "claude-code" ? "claude-opus-5-5" : mode === "gemini" ? "gemini-4-hydrogen" : DEFAULT_MODEL;
}
// Gemini 4 thinking levels: low/medium/high everywhere; xhigh on Neon/Hydrogen.
const GEMINI_XHIGH: readonly string[] = ["gemini-4-neon", "gemini-4-hydrogen"];
export function effortsForModel(model: ModelId) {
  // OpenAI and the explicit Claude routes support all five levels. Unknown
  // models fail closed.
  if (!MODEL_OPTIONS.some((option) => option.id === model)) return [];
  if (modelFamily(model) !== "gemini") return EFFORT_OPTIONS;
  return EFFORT_OPTIONS.filter((option) =>
    option.id === "low" || option.id === "medium" || option.id === "high" ||
    (option.id === "xhigh" && GEMINI_XHIGH.includes(model)));
}
export function compatibleModel(mode: string, model: ModelId): boolean {
  return modelsForMode(mode).some((option) => option.id === model);
}
export function modelSummary(
  mode: string,
  model: ModelId,
  effort: Effort,
): string {
  const providerLabel = mode === "claude-code"
    ? "Claude"
    : mode === "gemini"
      ? "Gemini"
    : MODE_OPTIONS.find((option) => option.id === mode)?.label ?? mode;
  const modelLabel = MODEL_OPTIONS.find((option) => option.id === model)?.label ?? model;
  return `${providerLabel} · ${mode === "claude-code" ? modelLabel.replace(/^Claude /, "") : mode === "gemini" ? modelLabel.replace(/^Gemini /, "") : modelLabel} · ${EFFORT_OPTIONS.find((option) => option.id === effort)?.label ?? effort}`;
}
