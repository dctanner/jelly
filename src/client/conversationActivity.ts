import type { Activity, RunRecord } from "../shared/types";
import { toolImages } from "../shared/tool-images";

function isWorkDetail(event: Activity) {
  return (
    [
      "tool_started",
      "tool_completed",
      "thinking",
      "turn_completed",
      "run_started",
      "run_completed",
      "run_cancelled",
    ].includes(event.type) ||
    event.type.startsWith("compaction_") ||
    event.type.startsWith("subagent_")
  );
}

export function workState(events: Activity[], run?: RunRecord) {
  const terminal = events
    .filter((event) =>
      [
        "run_completed",
        "run_failed",
        "run_cancelled",
        "run_interrupted",
      ].includes(event.type),
    )
    .at(-1);
  const status = terminal ? terminal.type.slice(4) : run?.status;
  const active =
    status === "running" ||
    (!status && events.some((event) => event.type === "run_started"));
  return { terminal, status, active };
}

export type ConversationEntry =
  | { kind: "event"; key: string; event: Activity }
  | { kind: "work"; key: string; run?: RunRecord; events: Activity[] };

/** One stable disclosure per run, independent of tool/turn/message boundaries.
 * Messages and images retain their original order outside the disclosure.
 * Active work follows ALL loaded chat content, including mid-turn replies. */
export function conversationActivity(
  events: Activity[],
  runs: RunRecord[],
  includeActive = true,
): ConversationEntry[] {
  const groups = new Map<
    string,
    Extract<ConversationEntry, { kind: "work" }>
  >();
  for (const run of runs)
    groups.set(run.id, { kind: "work", key: `run:${run.id}`, run, events: [] });
  for (const event of events) {
    if (!event.runId) continue;
    let group = groups.get(event.runId);
    if (!group) {
      group = { kind: "work", key: `run:${event.runId}`, events: [] };
      groups.set(event.runId, group);
    }
    group.events.push(event);
  }
  const active = new Set(
    [...groups.values()]
      .filter((group) => workState(group.events, group.run).active)
      .map((group) => group.key),
  );
  const entries: ConversationEntry[] = [];
  const inserted = new Set<string>();
  const insert = (group: Extract<ConversationEntry, { kind: "work" }>) => {
    if (inserted.has(group.key) || active.has(group.key)) return;
    inserted.add(group.key);
    entries.push(group);
  };
  for (const event of events) {
    const group = event.runId ? groups.get(event.runId) : undefined;
    const user = event.type === "message" && event.data.role === "user";
    if (group && !user) insert(group);
    if (!group || !isWorkDetail(event) || toolImages(event).length > 0)
      entries.push({ kind: "event", key: `event:${event.id}`, event });
    // Settled disclosures keep their historical position after the prompt.
    // Active disclosures are deferred to the tail; steering stays in order.
    if (group && user) insert(group);
  }
  for (const group of groups.values())
    if (active.has(group.key) && (includeActive || group.events.length > 0))
      entries.push(group);
  return entries;
}

export function workDuration(
  start?: string,
  end?: string | null,
): string | null {
  if (!start || !end) return null;
  const seconds = Math.max(
    0,
    Math.round((Date.parse(end) - Date.parse(start)) / 1000),
  );
  if (!Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}
