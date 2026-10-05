import type { Database } from "bun:sqlite";
import type { SubagentSnapshot } from "../shared/subagents";
import { subagentIsActive } from "../shared/subagents";
import type { SubagentSources } from "./subagent-projection";
import { readSubagentTranscript } from "./subagent-transcript";
import { HttpError } from "./errors";

/** Private source references never enter SSE, model messages, or public DTOs. */
export class SubagentStore {
  constructor(private db: Database) {}
  save(
    agentId: string,
    runId: string,
    snapshot: SubagentSnapshot,
    sources: SubagentSources,
  ) {
    this.db
      .query(
        `INSERT INTO subagent_views (runId,agentId,snapshot,sources) VALUES (?,?,?,?)
      ON CONFLICT(runId) DO UPDATE SET snapshot=excluded.snapshot,sources=excluded.sources`,
      )
      .run(runId, agentId, JSON.stringify(snapshot), JSON.stringify(sources));
  }
  private row(agentId: string, runId: string) {
    const run = this.db
      .query("SELECT agentId,status FROM runs WHERE id=?")
      .get(runId) as { agentId: string; status: string } | null;
    if (!run || run.agentId !== agentId)
      throw new HttpError(404, "Run not found.");
    const view = this.db
      .query(
        "SELECT snapshot,sources FROM subagent_views WHERE runId=? AND agentId=?",
      )
      .get(runId, agentId) as { snapshot: string; sources: string } | null;
    return { run, view };
  }
  snapshot(agentId: string, runId: string): SubagentSnapshot {
    const { run, view } = this.row(agentId, runId);
    const snapshot: SubagentSnapshot = view
      ? JSON.parse(view.snapshot)
      : { version: 1, updatedAt: Date.now(), children: [], omitted: 0 };
    if (run.status !== "running")
      for (const child of snapshot.children) {
        if (subagentIsActive(child.state)) {
          child.state = "unknown";
          child.attention =
            "Parent session ended; child is no longer observed.";
          child.currentTool = undefined;
        }
      }
    return snapshot;
  }
  async transcript(
    agentId: string,
    runId: string,
    childId: string,
    before?: number,
  ) {
    const { view } = this.row(agentId, runId);
    if (!view) throw new HttpError(404, "Subagent not found.");
    const snapshot: SubagentSnapshot = JSON.parse(view.snapshot);
    if (!snapshot.children.some((child) => child.id === childId))
      throw new HttpError(404, "Subagent not found.");
    const source = (JSON.parse(view.sources) as SubagentSources)[childId];
    if (!source)
      return {
        entries: [],
        before: null,
        truncated: false,
        unavailable: "No child transcript is available yet.",
      };
    return readSubagentTranscript(source, before);
  }
}
