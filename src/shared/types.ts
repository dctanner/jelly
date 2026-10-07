import type { ModelId, Effort } from "./models";
export type Mode = "auto" | "chatgpt" | "api";
export type Status = "idle" | "running" | "waiting" | "error" | "interrupted";
export type MessageMode = "queue" | "steer";
export interface PendingMessage {
  id: string;
  agentId: string;
  text: string;
  mode: MessageMode;
  status: "pending" | "delivered" | "cancelled";
  runId: string | null;
  createdAt: string;
}
export interface ProjectRecord {
  id: string;
  name: string;
  defaultCwd: string;
  createdAt: string;
  updatedAt: string;
}
export type AgentInput = Pick<AgentRecord, "name" | "instructions" | "color"> &
  Partial<Pick<AgentRecord, "avatarId" | "projectId">> & { nameEdited?: boolean };
export interface AgentRecord {
  model: ModelId;
  effort: Effort;
  projectId: string | null;
  cwd: string;
  managedCwd: number;
  avatarId: string;
  id: string;
  name: string;
  instructions: string;
  color: string;
  status: Status;
  createdAt: string;
  archivedAt: string | null;
}
export interface RunRecord {
  id: string;
  agentId: string;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  mode: string;
  model: string;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}
export interface Activity {
  id: number;
  agentId: string | null;
  runId: string | null;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}
export type BrowserBackend = "playwright" | "agent-browser";
export interface ConnectionConfig {
  browserBackend?: BrowserBackend;
  selectedModel: ModelId;
  effort: Effort;
  mode: Mode;
  activeMode: "chatgpt" | "api" | null;
  ready: boolean;
  provider: string;
  model: string;
  chatgptReady: boolean;
  apiReady: boolean;
  notice: string;
}
export interface HistoryPage {
  events: Activity[];
  runs: RunRecord[];
  interventions: Intervention[];
  before: number | null;
}
export interface Snapshot {
  latestAssistantMessages: Record<string, number>;
  agentPreviews?: Record<string, { text: string; createdAt: string }>;
  agentActivity?: Record<string, string>;
  pendingMessages: PendingMessage[];
  projects: ProjectRecord[];
  instance: { id: string; name: string };
  agents: AgentRecord[];
  selectedAgentId: string | null;
  events: Activity[];
  runs: RunRecord[];
  cursor: number;
  historyBefore: number | null;
  config: ConnectionConfig;
  interventions: Intervention[];
  computer: ComputerState;
}

export interface Intervention {
  id: string;
  agentId: string;
  runId: string;
  kind: "sudo" | "browser_login";
  status:
    | "pending"
    | "executing"
    | "completed"
    | "failed"
    | "denied"
    | "cancelled"
    | "expired"
    | "interrupted";
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  createdAt: string;
  expiresAt: string;
}
export interface ComputerState {
  status: "stopped" | "starting" | "ready" | "error";
  control: "agent" | "human";
  owned: boolean;
  handoffId: string | null;
  error: string | null;
}
export interface LoginFlow {
  userCode: string | null;
  id: string;
  status: "starting" | "waiting" | "connected" | "error" | "cancelled";
  url: string | null;
  error: string | null;
}
export interface ConnectionStatus {
  chatgptReady: boolean;
  apiReady: boolean;
  apiStored: boolean;
  apiSource: string | null;
  busy: boolean;
  flow: LoginFlow | null;
}

export interface McpStatus {
  servers: {
    name: string;
    status: "connected" | "needs_auth" | "unavailable";
    toolCount: number | null;
  }[];
  error?: string;
}
