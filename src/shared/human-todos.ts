import type { AgentRecord, Intervention, RunRecord } from "./types";

export type HumanTodoStatus = "open" | "done" | "cancelled";
export type HumanTodoActor =
  { kind: "human" } | { kind: "agent"; agentId: string; runId: string };
export interface HumanTodo {
  id: string;
  agentId: string | null;
  title: string;
  instructions: string;
  reason: string;
  criteria: string;
  blocking: boolean;
  status: HumanTodoStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  deletedAt: string | null;
  resolutionNote: string;
  resolutionActor: HumanTodoActor | null;
  completionId: string | null;
  creator: HumanTodoActor;
  sourceAgentId: string | null;
  requestId: string;
  sourceActivityId: number | null;
  originGoalId: string | null;
  goalId: string | null;
  interventionId: string | null;
  originInterventionId: string | null;
}
export interface HumanTodoDelivery {
  id: string;
  todoId: string;
  completionId: string;
  agentId: string;
  snapshot: HumanTodo;
  state: "waiting" | "needs_retry" | "admitted" | "cancelled";
  reason: string;
  requestId: string;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface HumanTodoSource {
  source: "human_todo";
  todoId: string;
  deliveryId: string;
  completionId: string;
}
export interface HumanTodoAudit {
  requestId: string;
  actor: HumanTodoActor;
  action: string;
  beforeRevision: number | null;
  afterRevision: number;
  createdAt: string;
  changes: Record<string, unknown>;
}
export interface HumanTodoDetail {
  todo: HumanTodo;
  agent: AgentRecord | null;
  delivery: HumanTodoDelivery | null;
  run: RunRecord | null;
  history: HumanTodoAudit[];
}
export interface HumanTodoCounts {
  total: number;
  agents: Record<string, number>;
}
export type HumanTodoHandoff = Pick<
  Intervention,
  "id" | "agentId" | "kind" | "status" | "expiresAt" | "createdAt"
> & { sourceActivityId: number | null; todoId: string | null };
export type HumanTodoSummary = Pick<
  HumanTodo,
  | "id"
  | "agentId"
  | "title"
  | "reason"
  | "blocking"
  | "status"
  | "revision"
  | "createdAt"
>;
export interface HumanTodosPage {
  items: HumanTodoSummary[];
  after: string | null;
  counts: HumanTodoCounts;
  handoffs: HumanTodoHandoff[];
  agents: AgentRecord[];
}
export type HumanTodoAction =
  "create" | "update" | "complete" | "continue" | "delete";
