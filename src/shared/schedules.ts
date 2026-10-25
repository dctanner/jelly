export type ScheduleTiming =
  | { kind: "once"; runAt: string; timezone: string; cron?: never }
  | { kind: "cron"; cron: string; timezone: string; runAt?: never };
export type ScheduleInput = ScheduleTiming & {
  title: string;
  prompt: string;
  catchUp?: "latest" | "none";
  maxLatenessSeconds?: number;
};
export type ScheduleState =
  "active" | "paused" | "completed" | "cancelled" | "expired";
export interface AgentSchedule {
  id: string;
  agentId: string;
  title: string;
  prompt: string;
  revision: number;
  kind: "once" | "cron";
  runAt: string | null;
  cron: string | null;
  timezone: string;
  catchUp: "latest" | "none";
  maxLatenessSeconds: number;
  state: ScheduleState;
  reason: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByRunId: string | null;
  updatedByRunId: string | null;
  originalRequestId: string;
  lastDispatchError: string | null;
  retryAt: string | null;
}
export type ScheduleReasonCode =
  | "overlap"
  | "downtime"
  | "lateness"
  | "delivery"
  | "retry_limit"
  | "updated"
  | "paused"
  | "resumed"
  | "cancelled"
  | "archived"
  | "stopped"
  | "failed"
  | "interrupted";
export type ScheduleDelay = "busy" | "capacity" | "delivery";
export interface ScheduleOccurrence {
  id: string;
  scheduleId: string;
  scheduleRevision: number;
  agentId: string;
  scheduledFor: string;
  snapshot: AgentSchedule;
  state:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "skipped"
    | "expired";
  requestId: string;
  runId: string | null;
  admittedAt: string | null;
  finishedAt: string | null;
  wakeReason: string;
  delays: ScheduleDelay[];
  reason: string | null;
  reasonCode: ScheduleReasonCode | null;
  attempts: number;
  retryAt: string | null;
}
export interface ScheduleSource {
  source: "schedule";
  scheduleId: string;
  occurrenceId: string;
  scheduleRevision: number;
  scheduledFor: string;
  admittedAt: string;
  wakeReason: string;
  delayReasons: ScheduleDelay[];
  taskSnapshot: string;
}
export interface ScheduleReceipt {
  schedule: AgentSchedule;
  preview: string[];
  latest: ScheduleOccurrence | null;
  runningRunId: string | null;
  notice: string;
}
export interface SchedulesPage {
  items: ScheduleReceipt[];
  before: string | null;
  activeCount: number;
  nextRunAt: string | null;
}
export interface OccurrencesPage {
  items: ScheduleOccurrence[];
  before: string | null;
}
