export const MODEL_OPTIONS = [
  { id: "gpt-6-astra", label: "GPT-6 Astra" },
  { id: "gpt-6-astra-fast", label: "GPT-6 Astra Fast" },
  { id: "gpt-6-astra-ultrafast", label: "GPT-6 Astra Ultrafast" },
  { id: "gpt-6-sol", label: "GPT-6 Sol" },
  { id: "gpt-6-sol-fast", label: "GPT-6 Sol Fast" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { id: "gpt-6.1-sol-fast", label: "GPT-6.1 Sol Fast" },
  { id: "gpt-6.1-sol-ultrafast", label: "GPT-6.1 Sol Ultrafast" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
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
] as const;
export function modelsForMode(mode: string) {
  return MODEL_OPTIONS.filter(
    (model) => model.id.startsWith("claude-") === (mode === "claude-code"),
  );
}
export function defaultModelForMode(mode: string): ModelId {
  return mode === "claude-code" ? "claude-opus-5-5" : DEFAULT_MODEL;
}
export function effortsForModel(model: ModelId) {
  // All currently offered routes support these five levels, including the
  // explicit Claude routes in the pinned catalog. Unknown models fail closed.
  return MODEL_OPTIONS.some((option) => option.id === model)
    ? EFFORT_OPTIONS
    : [];
}
export function compatibleModel(mode: string, model: ModelId): boolean {
  return modelsForMode(mode).some((option) => option.id === model);
}
export function modelSummary(
  mode: string,
  model: ModelId,
  effort: Effort,
): string {
  return `${MODE_OPTIONS.find((option) => option.id === mode)?.label ?? mode} · ${MODEL_OPTIONS.find((option) => option.id === model)?.label ?? model} · ${EFFORT_OPTIONS.find((option) => option.id === effort)?.label ?? effort}`;
}
