import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store";
import { Goals, parentGoalTokens } from "../src/server/goals";
import type { Goal, GoalAction } from "../src/shared/goals";
import type { Usage } from "@earendil-works/pi-ai";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const usage: Usage = {
  input: 10,
  output: 5,
  cacheRead: 100,
  cacheWrite: 3,
  totalTokens: 118,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-goals-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "test.sqlite");
  const store = new Store(path);
  cleanup.push(() => store.close());
  const agent = store.addAgent({
    name: "Goal fixture",
    instructions: "",
    color: "#123456",
  });
  const events: string[] = [];
  const goals = new Goals(store, (e) => {
    expect(store.db.inTransaction).toBe(false);
    events.push(e.type);
  });
  const create = (extra = {}) =>
    goals.mutate(agent.id, "create", {
      objective: "Verify fixture",
      tokenBudget: 100,
      requestId: "create",
      ...extra,
    }).goal;
  const change = (goal: Goal, action: GoalAction, extra = {}) =>
    goals.mutate(agent.id, action, {
      goalId: goal.id,
      expectedRevision: goal.revision,
      requestId: crypto.randomUUID(),
      ...extra,
    }).goal;
  return { store, path, agent, goals, events, create, change };
}
test("fresh and v17 migration, reopen, scoped one-current-goal, durable mutation replay/conflicts", () => {
  const f = fixture();
  expect(f.store.db.query("PRAGMA user_version").get()).toEqual({
    user_version: 18,
  });
  // Reconstruct an actual v17 schema before migrating, not merely reset the version.
  f.store.db.exec(
    "DROP TABLE goal_usage; DROP TABLE goal_runs; DROP TABLE goal_mutations; DROP TABLE agent_goals; PRAGMA user_version=17;",
  );
  const migrated = new Store(f.path);
  cleanup.push(() => migrated.close());
  const goal = f.create();
  expect(f.create()).toEqual(goal);
  expect(f.events).toHaveLength(1);
  expect(() => f.create({ objective: "different" })).toThrow(
    "different goal mutation",
  );
  expect(() => f.create({ requestId: "another" })).toThrow(
    "Clear the current goal",
  );
  expect(new Goals(migrated).get(f.agent.id)).toEqual(goal);
  const other = f.store.addAgent({
    name: "Same workspace",
    instructions: "",
    color: "#123456",
  });
  f.store.db
    .query("UPDATE agents SET cwd=? WHERE id=?")
    .run(f.agent.cwd, other.id);
  expect(f.goals.get(other.id)).toBeNull();
  expect(() =>
    f.goals.mutate(other.id, "pause", {
      goalId: goal.id,
      expectedRevision: 1,
      requestId: "other",
    }),
  ).toThrow("not found");
  expect(() => f.change(goal, "pause", { expectedRevision: 0 })).toThrow(
    "Goal changed",
  );
  expect(() =>
    f.store.db
      .query("INSERT INTO agent_goals VALUES (?,?,1,?)")
      .run("duplicate", f.agent.id, "{}"),
  ).toThrow();
  expect(() =>
    f.store.db
      .query("INSERT INTO agent_goals VALUES (?,?,1,?)")
      .run("foreign", "missing", "{}"),
  ).toThrow();
});
test("budget validation and strict server-owned fields", () => {
  for (const tokenBudget of [
    0,
    -1,
    1.1,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
    "20",
  ]) {
    const f = fixture();
    expect(() => f.create({ tokenBudget })).toThrow("positive safe integer");
  }
  const f = fixture();
  expect(() => f.create({ tokensUsed: 0 })).toThrow("server-owned");
  expect(() => f.create({ objective: " " })).toThrow();
  expect(() => f.create({ objective: "x".repeat(16001) })).toThrow();
  expect(parentGoalTokens(usage)).toBe(18);
  expect(parentGoalTokens(undefined)).toBeNull();
  expect(parentGoalTokens({ ...usage, input: -1 })).toBeNull();
});
test("accounting is cumulative, idempotent, atomic with transcript and remains charged after pause/clear", () => {
  const f = fixture();
  let goal = f.change(f.create(), "resume");
  const run = f.store.createRun(
    f.agent.id,
    "run",
    "fixture",
    "api",
    "gpt-6-astra",
  );
  const binding = f.goals.admit(goal, run.id);
  expect(() => f.goals.admit(goal, run.id)).toThrow();
  f.store.db.transaction(() => f.goals.account(binding, "message-1", usage))();
  expect(f.goals.get(f.agent.id)!.tokensUsed).toBe(18);
  expect(f.goals.account(binding, "message-1", usage)).toBeNull();
  expect(() =>
    f.store.db.transaction(() => {
      f.goals.account(binding, "rollback", usage);
      throw new Error("rollback");
    })(),
  ).toThrow();
  expect(f.goals.get(f.agent.id)!.tokensUsed).toBe(18);
  goal = f.change(f.goals.get(f.agent.id)!, "pause");
  expect(f.goals.current(binding)).toBeNull();
  f.goals.account(binding, "in-flight", usage);
  expect(f.goals.get(f.agent.id)!.tokensUsed).toBe(36);
  expect(() =>
    f.change(goal, "edit", { objective: "new", tokenBudget: 200 }),
  ).toThrow("running work");
  f.store.finishRun(run.id, "completed", null);
  goal = f.change(f.goals.get(f.agent.id)!, "edit", {
    objective: "edited exact scope",
    tokenBudget: 200,
  });
  expect(goal.id).toBe(binding.id);
  expect(goal.tokensUsed).toBe(36);
  f.change(goal, "clear");
  f.goals.account(binding, "late", usage);
  expect(f.goals.get(f.agent.id)).toBeNull();
  expect(f.goals.byId(binding.id)!.tokensUsed).toBe(54);
  expect(f.create({ requestId: "replacement" }).id).not.toBe(binding.id);
  expect(() => f.goals.update(binding, "completed", "stale")).toThrow(
    "no longer active",
  );
});
test("budget exhaustion, missing usage, completion and recovery never imply success or reset usage", () => {
  const f = fixture();
  let goal = f.change(f.create({ tokenBudget: 10 }), "resume");
  const run = f.store.createRun(
    f.agent.id,
    "run",
    "fixture",
    "api",
    "gpt-6-astra",
  );
  const binding = f.goals.admit(goal, run.id);
  f.goals.account(binding, "1", usage);
  goal = f.goals.get(f.agent.id)!;
  expect(goal.state).toBe("budget_exhausted");
  expect(goal.tokensUsed).toBe(18);
  f.store.finishRun(run.id, "completed", null);
  expect(() => f.change(goal, "resume")).toThrow("Budget exhausted");
  goal = f.change(goal, "edit", {
    objective: goal.objective,
    tokenBudget: 100,
  });
  goal = f.change(goal, "resume");
  f.goals.recover();
  goal = f.goals.get(f.agent.id)!;
  expect(goal.state).toBe("paused");
  expect(goal.tokensUsed).toBe(18);
  goal = f.change(goal, "complete", { summary: "Operator verified fixture" });
  expect(goal.state).toBe("completed");
  expect(() => f.change(goal, "resume")).toThrow("unfinished");
});

test("unknown parent usage is a visible lower bound and blocks, while later evidence does not erase uncertainty", () => {
  const f = fixture();
  const goal = f.change(f.create(), "resume");
  const run = f.store.createRun(
    f.agent.id,
    "unknown",
    "fixture",
    "api",
    "gpt-6-astra",
  );
  const binding = f.goals.admit(goal, run.id);
  f.goals.account(binding, "unknown-usage", undefined as unknown as Usage);
  expect(f.goals.get(f.agent.id)).toMatchObject({
    state: "blocked",
    usageUnknown: true,
    tokensUsed: 0,
  });
  f.goals.account(binding, "known-late", usage);
  expect(f.goals.get(f.agent.id)).toMatchObject({
    state: "blocked",
    usageUnknown: true,
    tokensUsed: 18,
  });
});
