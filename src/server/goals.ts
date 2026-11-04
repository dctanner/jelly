import type { Usage } from "@earendil-works/pi-ai";
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
function budget(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new HttpError(400, "Token budget must be a positive safe integer.");
  return value as number;
}
/** Pi normalizes input separately from cacheRead/cacheWrite. Never add totalTokens. */
export function parentGoalTokens(
  usage: Partial<Usage> | undefined,
): number | null {
  const parts = [usage?.input, usage?.cacheWrite, usage?.output];
  if (parts.some((n) => !Number.isSafeInteger(n) || n! < 0)) return null;
  const sum = parts.reduce<number>((sum, n) => sum + n!, 0);
  return Number.isSafeInteger(sum) ? sum : null;
}
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
      tokensUsed: goal.tokensUsed,
      tokenBudget: goal.tokenBudget,
      revision: goal.revision,
    });
  }
  mutate(agentId: string, action: GoalAction, input: Record<string, unknown>) {
    const allowed = [
      "requestId",
      ...(action === "create"
        ? ["objective", "tokenBudget"]
        : ["goalId", "expectedRevision"]),
      ...(action === "edit" ? ["objective", "tokenBudget"] : []),
      ...(action === "complete" ? ["summary"] : []),
    ];
    if (Object.keys(input).some((key) => !allowed.includes(key)))
      throw new HttpError(400, "Unknown or server-owned goal field.");
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
        return { goal: JSON.parse(receipt.response) as Goal, reused: true };
      }
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
          tokenBudget: budget(input.tokenBudget),
          revision: 1,
          epoch: 0,
          state: "paused",
          tokensUsed: 0,
          usageUnknown: false,
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
          goal.tokenBudget = budget(input.tokenBudget);
          goal.state =
            goal.tokensUsed >= goal.tokenBudget ? "budget_exhausted" : "paused";
          goal.reason =
            "Edited. Resume explicitly to continue; usage is preserved.";
        } else if (action === "resume") {
          if (goal.state === "completed" || goal.state === "active")
            throw new HttpError(
              409,
              "Only a stopped, unfinished goal can resume.",
            );
          if (goal.tokensUsed >= goal.tokenBudget)
            throw new HttpError(
              409,
              "Budget exhausted. Increase the budget before resuming.",
            );
          if (
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
    this.store.db
      .query("INSERT INTO goal_runs VALUES (?,?,?,?)")
      .run(runId, goal.id, goal.epoch, JSON.stringify(goal));
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
  /** Called inside the same transaction as finalized transcript/checkpoint writes. */
  account(
    binding: GoalBinding,
    entryId: string,
    usage: Usage,
  ): Activity | null {
    const goal = this.byId(binding.id);
    if (!goal) return null;
    const tokens = parentGoalTokens(usage);
    const added = this.store.db
      .query("INSERT OR IGNORE INTO goal_usage VALUES (?,?,?,?)")
      .run(binding.runId, entryId, tokens ?? 0, JSON.stringify(usage ?? null));
    if (!added.changes) return null;
    goal.tokensUsed = Math.min(
      Number.MAX_SAFE_INTEGER,
      goal.tokensUsed + (tokens ?? 0),
    );
    goal.usageUnknown ||= tokens === null;
    let changedState = false;
    if (
      goal.state === "active" &&
      (tokens === null || goal.tokensUsed >= goal.tokenBudget)
    ) {
      goal.state = tokens === null ? "blocked" : "budget_exhausted";
      goal.reason =
        tokens === null
          ? "Parent usage was unavailable. Inspect before explicitly resuming."
          : "Parent-session continuation token budget exhausted; in-flight work may overshoot.";
      goal.revision++;
      changedState = true;
    }
    return this.save(
      goal,
      binding.runId,
      changedState ? "goal_changed" : "goal_usage",
    );
  }
  update(
    binding: GoalBinding,
    state: "active" | "blocked" | "completed",
    progress: string,
  ) {
    const candidate = this.byId(binding.id);
    const budgetCompletion =
      state === "completed" &&
      candidate?.epoch === binding.epoch &&
      candidate.state === "budget_exhausted" &&
      this.store.run(binding.runId)?.status === "running";
    const goal = this.current(binding) ?? (budgetCompletion ? candidate : null);
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
    // Exhaustion retains the admitted run's completion authority. Human takeover,
    // Stop and shutdown must revoke that exception too, without hiding exhaustion.
    const exhaustedExecution =
      goal.state === "budget_exhausted" &&
      this.store.db
        .query(
          `SELECT 1 FROM goal_runs g JOIN runs r ON r.id=g.runId
        WHERE g.goalId=? AND g.epoch=? AND r.status='running' LIMIT 1`,
        )
        .get(goal.id, goal.epoch);
    if (goal.state !== "active" && !exhaustedExecution) return;
    if (!exhaustedExecution) goal.state = state;
    goal.reason = reason;
    goal.epoch++;
    goal.revision++;
    const event = this.store.db.transaction(() => this.save(goal))();
    this.publish(event);
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
    if (goal.continuations >= 32) {
      this.stop(
        goal.agentId,
        "Safety limit: 32 automatic continuations. Review progress and explicitly resume.",
        "blocked",
      );
      return null;
    }
    goal.continuations++;
    const event = this.store.db.transaction(() =>
      this.save(goal, binding.runId, "goal_usage"),
    )();
    this.publish(event);
    return goal;
  }
}

export function goalPrompt(goal: Goal): string {
  return `[Jelly goal ${goal.id}; execution ${goal.epoch}]\nObjective (preserve full scope):\n${goal.objective}\n\nProgress: ${goal.progress || "No progress recorded."}\nParent-session continuation token budget: ${goal.tokensUsed}/${goal.tokenBudget}; excludes cache reads, delegated children, compaction and nested/CLI work. Not a spend cap; in-flight work may overshoot.\nContinue useful work until the objective is verified complete or genuinely blocked. Use jelly_goal to inspect/update progress, report a blocker, or complete with requirement-by-requirement evidence. A final answer alone does not complete the goal. Do not reduce scope, create duplicate missions/goals, or relaunch owned children. Yield while children work. If the same genuine blocker persists, report it rather than repeating empty turns. Completion is your attestation, not an independent verifier. Only the operator can resume or increase the budget.`;
}
