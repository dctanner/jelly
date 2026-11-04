export type GoalState =
  "active" | "paused" | "blocked" | "completed" | "cleared";
/** Durable operator view; execution bookkeeping is never sent to the model. */
export interface Goal {
  id: string;
  agentId: string;
  objective: string;
  revision: number;
  epoch: number;
  state: GoalState;
  compactions: number;
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
