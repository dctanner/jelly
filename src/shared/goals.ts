export type GoalState =
  | "active"
  | "paused"
  | "blocked"
  | "budget_exhausted"
  | "completed"
  | "cleared";
/** Budget covers only reported parent-session input + cache-write + output tokens. */
export interface Goal {
  id: string;
  agentId: string;
  objective: string;
  revision: number;
  epoch: number;
  state: GoalState;
  tokenBudget: number;
  tokensUsed: number;
  usageUnknown: boolean;
  progress: string;
  reason: string | null;
  continuations: number;
  createdAt: string;
  updatedAt: string;
}
export type GoalAction =
  "create" | "edit" | "pause" | "resume" | "complete" | "clear";
export interface GoalView {
  goal: Goal | null;
  runningRunId: string | null;
}
export interface GoalBinding {
  id: string;
  agentId: string;
  epoch: number;
  runId: string;
}
