import type { Activity } from "../shared/types";
import { toolImages } from "../shared/tool-images";

export function isToolActivity(event: Activity): boolean {
  return event.type === "tool_started" || event.type === "tool_completed";
}

const boundaries = new Set([
  "message",
  "image_generated",
  "file_rendered",
  "run_started",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "run_interrupted",
]);

const isBoundary = (event: Activity) =>
  boundaries.has(event.type) || toolImages(event).length > 0;

/** Group work between messages, including intervening turn/subagent events. */
export function groupActivity(events: Activity[]): Activity[][] {
  const starts = new Set(
    events
      .filter((event) => event.type === "tool_started")
      .map((event) => `${event.runId}:${event.data.toolCallId}`),
  );
  const groups: Activity[][] = [];
  for (const event of events) {
    if (
      event.type === "tool_completed" &&
      !toolImages(event).length &&
      starts.has(`${event.runId}:${event.data.toolCallId}`)
    )
      continue;
    const previous = groups.at(-1);
    if (
      !isBoundary(event) &&
      previous &&
      previous[0]!.runId === event.runId &&
      !isBoundary(previous[0]!)
    )
      previous.push(event);
    else groups.push([event]);
  }
  return groups;
}
