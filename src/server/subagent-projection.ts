import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import type {
  SubagentCard,
  SubagentSnapshot,
  SubagentState,
} from "../shared/subagents";

export interface SubagentSource {
  sessionFile: string;
  roots: string[];
}
export type SubagentSources = Record<string, SubagentSource>;
export const record = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
const text = (value: unknown, max = 256) =>
  typeof value === "string"
    ? value
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
        .slice(0, max)
    : undefined;
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
export function childState(value: unknown): SubagentState {
  switch (value) {
    case "pending":
    case "queued":
      return "queued";
    case "started":
    case "running":
      return "running";
    case "complete":
    case "completed":
      return "completed";
    case "failed":
    case "partial":
    case "rejected":
      return "failed";
    case "detached":
    case "paused":
      return "paused";
    case "stopping":
    case "stopped":
      return "stopped";
    default:
      return "unknown";
  }
}
const terminal = (value: SubagentState) =>
  ["completed", "failed", "stopped"].includes(value);
export class SubagentProjection {
  readonly cards = new Map<string, SubagentCard>();
  readonly sources: SubagentSources = {};
  readonly runTargets = new Map<string, { rootId: string; childId: string }>();
  attemptGeneration = 0;
  private attempts = new Map<string, string>();
  private retiredAttempts = new Set<string>();
  omitted = 0;
  error?: string;
  constructor(readonly sessionRoot: string) {}
  upsert(
    rootId: string,
    childId: string,
    raw: unknown,
    workflow?: string,
    authoritative = true,
  ) {
    if (!rootId || !childId || rootId.length > 256 || childId.length > 256)
      return;
    const row = record(raw),
      activity = { ...record(row.progress), ...record(row.activity), ...row };
    const id = createHash("sha256")
      .update(JSON.stringify([rootId, childId]))
      .digest("hex")
      .slice(0, 32);
    const previous = this.cards.get(id);
    if (!previous && this.cards.size >= 128) {
      this.omitted++;
      return;
    }
    const childRunId = text(row.runId ?? row.childRunId);
    if (childRunId && this.retiredAttempts.has(childRunId)) return;
    const priorAttempt = this.attempts.get(id);
    const newAttempt =
      !!childRunId && !!previous && childRunId !== priorAttempt;
    const outcome = row.stopped
      ? "stopped"
      : row.detached || row.interrupted
        ? "paused"
        : row.success === false || row.timedOut
          ? "failed"
          : undefined;
    const nextState = childState(
      outcome ??
        row.state ??
        row.status ??
        record(row.progress).status ??
        (row.success === true || row.exitCode === 0
          ? "completed"
          : typeof row.exitCode === "number"
            ? "failed"
            : "running"),
    );
    if (
      previous &&
      terminal(previous.state) &&
      !newAttempt &&
      (!authoritative || !terminal(nextState))
    )
      return;
    if (newAttempt) {
      if (priorAttempt) this.retiredAttempts.add(priorAttempt);
      delete this.sources[id];
    }
    if (childRunId && priorAttempt !== childRunId) {
      this.attemptGeneration++;
      this.attempts.set(id, childRunId);
    }
    const agent = text(row.agent ?? previous?.agent) || "Subagent";
    const candidate: SubagentCard = {
      ...(newAttempt ? { task: previous?.task } : previous),
      id,
      rootId,
      childId,
      ...(workflow ? { workflow } : {}),
      agent,
      label:
        text(
          row.label ??
            row.sessionName ??
            previous?.label ??
            row.workflowKey ??
            (childId.startsWith("step:") ? agent : childId),
        ) || agent,
      state: nextState,
      ...(text(row.parentId) ? { parentId: text(row.parentId) } : {}),
      inspectable: !newAttempt && (previous?.inspectable ?? false),
    };
    for (const field of [
      "startedAt",
      "endedAt",
      "lastActivityAt",
      "currentToolStartedAt",
      "toolCount",
      "turnCount",
    ] as const) {
      const value = number(activity[field]);
      if (value !== undefined) candidate[field] = value;
    }
    const task = text(row.task, 2000);
    if (task && task !== "[redacted]" && task !== "[prompt redacted]")
      candidate.task = task;
    candidate.currentTool = terminal(nextState)
      ? undefined
      : text(activity.currentTool);
    candidate.attention =
      !terminal(nextState) &&
      (activity.activityState === "needs_attention" ||
        record(row.activity).state === "needs_attention" ||
        activity.state === "needs_attention")
        ? "Check recent activity or a pending supervisor request."
        : undefined;
    if (typeof row.error === "string")
      candidate.error =
        "The subagent reported an error. Inspect its displayed tool results or ask the parent for details.";
    const sessionFile = text(row.sessionFile ?? row.sessionPath, 4096);
    if (childRunId && childRunId !== rootId)
      this.runTargets.set(childRunId, { rootId, childId });
    // Default session layout in pinned pi-subagents 0.71.0. Workflow foreground
    // progress omits sessionFile but supplies the concrete child run identity.
    const defaultFile =
      childRunId && /^[a-zA-Z0-9-]{8,128}$/.test(childRunId)
        ? join(this.sessionRoot, childRunId, "run-0", "session.jsonl")
        : undefined;
    const file =
      sessionFile ??
      (defaultFile && existsSync(defaultFile) ? defaultFile : undefined);
    if (file && resolve(file).startsWith(resolve(this.sessionRoot) + sep)) {
      this.sources[id] = { sessionFile: file, roots: [this.sessionRoot] };
      candidate.inspectable = true;
    }
    this.cards.set(id, candidate);
  }
  status(rootId: string, value: unknown) {
    const status = record(value),
      workflow = status.mode === "workflow" ? rootId : undefined;
    const steps = Array.isArray(status.steps) ? status.steps : [];
    if (!steps.length && !workflow)
      this.upsert(rootId, "step:0", {
        ...status,
        agent: status.agent ?? status.agents?.[0],
      });
    for (const [index, raw] of steps.slice(0, 128).entries()) {
      const row = record(raw),
        childId = text(row.workflowKey) ?? `step:${index}`;
      this.upsert(rootId, childId, row, workflow);
      this.nested(rootId, row.children, childId, 0);
    }
    this.omitted = Math.max(this.omitted, steps.length - 128);
  }
  private nested(
    rootId: string,
    values: unknown,
    parent: string,
    depth: number,
  ) {
    if (!Array.isArray(values)) return;
    if (depth > 3) {
      this.omitted += values.length;
      return;
    }
    for (const raw of values.slice(0, 32)) {
      const row = record(raw),
        id = text(row.id);
      if (!id) continue;
      this.upsert(rootId, id, { ...row, parentId: parent }, rootId);
      this.nested(rootId, row.children, id, depth + 1);
    }
  }
  tool(value: unknown) {
    const details = record(record(value).details);
    const rootId = text(details.runId ?? details.asyncId);
    if (!rootId) return;
    const target = this.runTargets.get(rootId);
    const summary = record(details.workflowChildren);
    if (Array.isArray(summary.children))
      for (const row of summary.children.slice(0, 128))
        this.upsert(rootId, row.childId, row, rootId);
    if (Array.isArray(details.results))
      for (const [index, raw] of details.results.slice(0, 128).entries()) {
        const row = record(raw);
        this.upsert(
          target?.rootId ?? rootId,
          target?.childId ??
            text(row.workflowKey) ??
            `step:${row.index ?? index}`,
          row,
          target?.rootId ?? (details.mode === "workflow" ? rootId : undefined),
        );
      }
  }
  snapshot(): SubagentSnapshot {
    return {
      version: 1,
      updatedAt: Date.now(),
      children: [...this.cards.values()],
      omitted: this.omitted,
      ...(this.error ? { error: this.error } : {}),
    };
  }
}
