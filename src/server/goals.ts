import type { Activity } from "../shared/types";
import type { Goal, GoalAction, GoalBinding, GoalView } from "../shared/goals";
import { Store } from "./store";
import { HttpError } from "./errors";

function text(value: unknown, name: string, max = 16000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new HttpError(
      400,
      `${name} must be nonempty and at most ${max} characters.`,
    );
  return value;
}
/** Server policy, never part of model context or operator mutation input. */
export const GOAL_COMPACTION_LIMIT = 100;
export const GOAL_COMPACTION_STOP_REASON =
  "Goal stopped after 100 successful parent-session compactions. Inspect progress and explicitly resume to continue.";
export class Goals {
  constructor(
    readonly store: Store,
    private publish: (event: Activity) => void = () => {},
  ) {}
  get(agentId: string): Goal | null {
    if (!this.store.agent(agentId))
      throw new HttpError(404, "Agent not found.");
    const row = this.store.db
      .query("SELECT record FROM agent_goals WHERE agentId=? AND current=1")
      .get(agentId) as { record: string } | null;
    return row ? JSON.parse(row.record) : null;
  }
  byId(id: string): Goal | null {
    const row = this.store.db
      .query("SELECT record FROM agent_goals WHERE id=?")
      .get(id) as { record: string } | null;
    return row ? JSON.parse(row.record) : null;
  }
  view(agentId: string): GoalView {
    const goal = this.get(agentId);
    const row = this.store.db
      .query(
        `SELECT r.id FROM runs r JOIN goal_runs g ON g.runId=r.id
      WHERE r.agentId=? AND r.status='running' ORDER BY r.rowid DESC LIMIT 1`,
      )
      .get(agentId) as { id: string } | null;
    return { goal, runningRunId: row?.id ?? null };
  }
  private save(
    goal: Goal,
    runId: string | null = null,
    type = "goal_changed",
  ): Activity {
    goal.updatedAt = new Date().toISOString();
    this.store.db
      .query("UPDATE agent_goals SET record=?,current=? WHERE id=?")
      .run(JSON.stringify(goal), goal.state === "cleared" ? 0 : 1, goal.id);
    return this.store.event(goal.agentId, runId, type, {
      goalId: goal.id,
      state: goal.state,
      reason: goal.reason,
      progress: goal.progress,
      revision: goal.revision,
    });
  }
  mutate(agentId: string, action: GoalAction, input: Record<string, unknown>) {
    const allowed = [
      "requestId",
      ...(action === "create" ? ["objective"] : ["goalId", "expectedRevision"]),
      ...(action === "edit" ? ["objective"] : []),
      ...(action === "complete" ? ["summary"] : []),
    ];
    const requestId = text(input.requestId, "Request ID", 100);
    const payload = JSON.stringify([
      action,
      Object.fromEntries(
        Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
      ),
    ]);
    let event: Activity | undefined;
    const result = this.store.db.transaction(() => {
      const current = this.get(agentId);
      const receipt = this.store.db
        .query(
          "SELECT payload,response FROM goal_mutations WHERE agentId=? AND requestId=?",
        )
        .get(agentId, requestId) as {
        payload: string;
        response: string;
      } | null;
      if (receipt) {
        if (receipt.payload !== payload)
          throw new HttpError(
            409,
            "Request ID already used for a different goal mutation.",
          );
        const historical = JSON.parse(receipt.response) as { id: string };
        return { goal: this.byId(historical.id)!, reused: true };
      }
      if (Object.keys(input).some((key) => !allowed.includes(key)))
        throw new HttpError(400, "Unknown or server-owned goal field.");
      if (this.store.agent(agentId)!.archivedAt)
        throw new HttpError(409, "Restore the agent before changing its goal.");
      let goal: Goal;
      if (action === "create") {
        if (current)
          throw new HttpError(
            409,
            "Clear the current goal before creating another.",
          );
        if (this.view(agentId).runningRunId)
          throw new HttpError(
            409,
            "Wait for goal work to finish before replacing it.",
          );
        const now = new Date().toISOString();
        goal = {
          id: crypto.randomUUID(),
          agentId,
          objective: text(input.objective, "Objective"),
          revision: 1,
          epoch: 0,
          state: "paused",
          compactions: 0,
          progress: "",
          reason: "Saved. Resume to authorize autonomous work.",
          continuations: 0,
          createdAt: now,
          updatedAt: now,
        };
        this.store.db
          .query(
            "INSERT INTO agent_goals(id,agentId,current,record) VALUES (?,?,1,?)",
          )
          .run(goal.id, agentId, JSON.stringify(goal));
      } else {
        if (!current || current.id !== input.goalId)
          throw new HttpError(404, "Goal not found for this agent.");
        if (current.revision !== input.expectedRevision)
          throw new HttpError(
            409,
            "Goal changed. Reload and use the current revision.",
          );
        goal = current;
        if (action === "edit") {
          if (goal.state === "active" || this.view(agentId).runningRunId)
            throw new HttpError(
              409,
              "Pause and wait for running work to finish before editing.",
            );
          if (goal.state === "completed")
            throw new HttpError(409, "Completed goals cannot be edited.");
          goal.objective = text(input.objective, "Objective");
          goal.state = "paused";
          goal.reason = "Edited. Resume explicitly to continue.";
        } else if (action === "resume") {
          if (goal.state === "completed" || goal.state === "active")
            throw new HttpError(
              409,
              "Only a stopped, unfinished goal can resume.",
            );
          if (
            this.view(agentId).runningRunId ||
            this.store.agent(agentId)!.status === "running" ||
            this.store.agent(agentId)!.status === "waiting" ||
            this.store.pendingMessages(agentId).length
          )
            throw new HttpError(
              409,
              "Wait for current work and queued messages before resuming.",
            );
          goal.state = "active";
          goal.reason = null;
          goal.continuations = 0;
        } else if (action === "complete") {
          if (goal.state === "completed")
            throw new HttpError(
              409,
              "Completed goals cannot be changed; clear the goal instead.",
            );
          goal.state = "completed";
          goal.progress = text(input.summary, "Completion summary");
          goal.reason = "Completed by operator.";
        } else if (action === "clear") {
          goal.state = "cleared";
          goal.reason = "Cleared by operator.";
        } else {
          if (goal.state === "completed")
            throw new HttpError(409, "Completed goals cannot be paused.");
          goal.state = "paused";
          goal.reason =
            "Paused by operator. Admitted work may still finish; use Stop to abort.";
        }
        goal.revision++;
        goal.epoch++;
      }
      event = this.save(goal);
      this.store.db
        .query("INSERT INTO goal_mutations VALUES (?,?,?,?)")
        .run(agentId, requestId, payload, JSON.stringify(goal));
      return { goal, reused: false };
    })();
    if (event) this.publish(event);
    return result;
  }
  admit(goal: Goal, runId: string): GoalBinding {
    const current = this.get(goal.agentId);
    if (
      !current ||
      current.id !== goal.id ||
      current.epoch !== goal.epoch ||
      current.state !== "active"
    )
      throw new HttpError(409, "Goal activation is no longer current.");
    this.store.db.transaction(() => {
      current.compactions = 0;
      this.store.db
        .query("UPDATE agent_goals SET record=? WHERE id=?")
        .run(JSON.stringify(current), current.id);
      this.store.db
        .query("INSERT INTO goal_runs VALUES (?,?,?,?)")
        .run(runId, current.id, current.epoch, JSON.stringify(current));
    })();
    goal.compactions = 0;
    return { id: goal.id, agentId: goal.agentId, epoch: goal.epoch, runId };
  }
  current(binding: GoalBinding) {
    const goal = this.get(binding.agentId);
    return goal?.id === binding.id &&
      goal.epoch === binding.epoch &&
      goal.state === "active" &&
      this.store.run(binding.runId)?.status === "running"
      ? goal
      : null;
  }
  /** Caller commits this with the successful Pi compaction checkpoint, then publishes. */
  compacted(binding: GoalBinding, entryId: string): Activity | null {
    const goal = this.current(binding);
    if (!goal) return null;
    const admitted = this.store.db
      .query("SELECT 1 FROM goal_runs WHERE runId=? AND goalId=? AND epoch=?")
      .get(binding.runId, binding.id, binding.epoch);
    if (!admitted) return null;
    const added = this.store.db
      .query(
        "INSERT OR IGNORE INTO goal_compactions(runId,entryId,goalId,epoch) VALUES (?,?,?,?)",
      )
      .run(binding.runId, entryId, binding.id, binding.epoch);
    if (!added.changes) return null;
    goal.compactions++;
    if (goal.compactions >= GOAL_COMPACTION_LIMIT) {
      goal.state = "paused";
      goal.reason = GOAL_COMPACTION_STOP_REASON;
      // Revoke tool/continuation authority before cancellation can run callbacks.
      goal.epoch++;
      goal.revision++;
    }
    return this.save(
      goal,
      binding.runId,
      goal.state === "paused" ? "goal_changed" : "goal_compaction",
    );
  }
  update(
    binding: GoalBinding,
    state: "active" | "blocked" | "completed",
    progress: string,
  ) {
    const goal = this.current(binding);
    if (!goal) throw new HttpError(409, "Goal execution is no longer active.");
    text(progress, state === "completed" ? "Completion evidence" : "Progress");
    goal.state = state;
    goal.progress = progress;
    goal.reason =
      state === "active"
        ? null
        : state === "completed"
          ? "Model-attested completion; see evidence summary."
          : progress;
    goal.revision++;
    const event = this.store.db.transaction(() =>
      this.save(goal, binding.runId),
    )();
    this.publish(event);
    return goal;
  }
  stop(
    agentId: string,
    reason: string,
    state: "paused" | "blocked" = "paused",
  ) {
    const goal = this.get(agentId);
    if (!goal) return;
    if (goal.state !== "active") return;
    goal.state = state;
    goal.reason = reason;
    goal.epoch++;
    goal.revision++;
    const event = this.store.db.transaction(() => this.save(goal))();
    this.publish(event);
  }
  /** Immutable run provenance survives the first blocker revoking execution authority. */
  bindingForRun(agentId: string, runId: string): GoalBinding | null {
    const row = this.store.db.query(`SELECT g.goalId,g.epoch FROM goal_runs g
      JOIN runs r ON r.id=g.runId WHERE g.runId=? AND r.agentId=?`)
      .get(runId, agentId) as { goalId: string; epoch: number } | null;
    return row ? { id: row.goalId, epoch: row.epoch, agentId, runId } : null;
  }
  /** Caller commits this blocker with the durable human dependency, then publishes. */
  blockForHumanTodo(binding: GoalBinding, todoId: string): Activity | null {
    const goal = this.current(binding);
    if (!goal) return null;
    goal.state = "blocked";
    goal.reason = `Human dependency ${todoId}. Review and explicitly Resume goal after verifying it.`;
    goal.epoch++; goal.revision++;
    return this.save(goal, binding.runId);
  }
  recover() {
    for (const agent of this.store.agents())
      this.stop(
        agent.id,
        "Jelly restarted. Previously admitted work may have taken effect. Inspect before resuming.",
      );
  }
  continuation(binding: GoalBinding): Goal | null {
    const goal = this.current(binding);
    if (!goal) return null;
    goal.continuations++;
    const event = this.store.db.transaction(() =>
      this.save(goal, binding.runId, "goal_continuation"),
    )();
    this.publish(event);
    return goal;
  }
}

export function goalPrompt(goal: Goal): string {
  return `[Jelly goal ${goal.id}; execution ${goal.epoch}]\nObjective (preserve full scope):\n${goal.objective}\n\nProgress: ${goal.progress || "No progress recorded."}\nContinue useful work until the objective is verified complete or genuinely blocked. Use jelly_goal to inspect/update progress, report a blocker, or complete with requirement-by-requirement evidence. A final answer alone does not complete the goal. Do not reduce scope, create duplicate missions/goals, or relaunch owned children. Yield while children work. If the same genuine blocker persists, report it rather than repeating empty turns. Completion is your attestation, not an independent verifier. Only the operator can resume a stopped goal.`;
}
