import type { AgentRecord, Snapshot } from "../shared/types";

/** Only assistant replies affect inbox order, not prompts, tools or status.
 * Copy before sorting so selection and other snapshot consumers are unchanged. */
export function sortAgentsByResponse(
  agents: readonly AgentRecord[],
  previews: Snapshot["agentPreviews"],
  messageIds: Snapshot["latestAssistantMessages"],
): AgentRecord[] {
  const times = new Map(
    agents.map((agent) => {
      const time = Date.parse(previews?.[agent.id]?.createdAt ?? "");
      return [agent.id, Number.isFinite(time) ? time : -Infinity];
    }),
  );
  return [...agents].sort((a, b) => {
    const left = times.get(a.id)!;
    const right = times.get(b.id)!;
    if (left !== right) return left < right ? 1 : -1;
    // Replies can share a millisecond; event IDs give them a stable order.
    // Agents without replies retain their existing order.
    return (messageIds[b.id] ?? 0) - (messageIds[a.id] ?? 0);
  });
}
