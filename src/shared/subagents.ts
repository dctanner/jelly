/** Bounded, path-free projections of package-owned child work. */
export type SubagentState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "paused"
  | "stopped"
  | "unknown";
export interface SubagentCard {
  /** Jelly-owned stable identity, scoped to the enclosing Jelly run. */
  id: string;
  rootId: string;
  childId: string;
  parentId?: string;
  workflow?: string;
  agent: string;
  label: string;
  task?: string;
  state: SubagentState;
  startedAt?: number;
  endedAt?: number;
  lastActivityAt?: number;
  currentTool?: string;
  currentToolStartedAt?: number;
  toolCount?: number;
  turnCount?: number;
  attention?: string;
  error?: string;
  /** A recorded transcript exists; it can still expire before inspection. */
  inspectable: boolean;
}
export interface SubagentSnapshot {
  version: 1;
  updatedAt: number;
  children: SubagentCard[];
  omitted: number;
  error?: string;
}
export interface SubagentTranscriptEntry {
  id: string;
  kind: "thinking" | "text" | "toolCall" | "toolResult";
  role: string;
  text: string;
  timestamp?: number;
  toolCallId?: string;
  name?: string;
  isError?: boolean;
}
export interface SubagentTranscript {
  /** Opaque file/session generation; byte IDs and cursors only belong to it. */
  generation?: string;
  entries: SubagentTranscriptEntry[];
  /** Opaque byte cursor for the preceding page; null when no older page. */
  before: number | null;
  truncated: boolean;
  unavailable?: string;
}
export function subagentIsActive(state: SubagentState) {
  return (
    state === "queued" ||
    state === "running" ||
    state === "paused" ||
    state === "unknown"
  );
}
