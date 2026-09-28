export const MODEL_OPTIONS = [
  { id: "gpt-6-astra", label: "GPT-6 Astra" },
  { id: "gpt-6-sol", label: "GPT-6 Sol" },
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
export const DEFAULT_MODEL: ModelId = "gpt-6-astra";
export const DEFAULT_EFFORT: Effort = "medium";
