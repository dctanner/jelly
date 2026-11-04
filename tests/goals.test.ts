import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store";
import { Goals } from "../src/server/goals";
import type { Goal, GoalAction } from "../src/shared/goals";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
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
    user_version: 19,
  });
  // Reconstruct an actual v17 schema before migrating, not merely reset the version.
  f.store.db.exec(
    "DROP TABLE goal_compactions; DROP TABLE goal_usage; DROP TABLE goal_runs; DROP TABLE goal_mutations; DROP TABLE agent_goals; PRAGMA user_version=17;",
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
test("objective-only mutations reject obsolete budget and internal counter overrides", () => {
  const f = fixture();
  for (const extra of [
    { tokenBudget: 100 },
    { compactions: 0 },
    { compactionLimit: 200 },
    { tokensUsed: 0 },
    { continuations: 0 },
  ])
    expect(() => f.create(extra)).toThrow("server-owned");
  expect(() => f.create({ objective: " " })).toThrow();
  expect(() => f.create({ objective: "x".repeat(16001) })).toThrow();
  const goal = f.create();
  expect(() =>
    f.change(goal, "edit", { objective: "edited", tokenBudget: 10 }),
  ).toThrow("server-owned");
});
function admit(f: ReturnType<typeof fixture>, goal: Goal) {
  const run = f.store.createRun(
    f.agent.id,
    crypto.randomUUID(),
    "fixture",
    "api",
    "gpt-6-astra",
  );
  return { run, binding: f.goals.admit(goal, run.id) };
}
test("compactions deduplicate, commit atomically, fence stale epochs, stop exactly at 100 and reset only on explicit resume", () => {
  const f = fixture();
  const { run, binding } = admit(f, f.change(f.create(), "resume"));
  expect(() => f.goals.admit(f.goals.get(f.agent.id)!, run.id)).toThrow();
  const count = (id: string) =>
    f.store.db.transaction(() => f.goals.compacted(binding, id))();
  count("first");
  expect(count("first")).toBeNull();
  expect(() =>
    f.store.db.transaction(() => {
      f.goals.compacted(binding, "rollback");
      throw new Error("rollback");
    })(),
  ).toThrow();
  expect(f.goals.get(f.agent.id)!.compactions).toBe(1);
  for (let n = 2; n <= 99; n++) count(String(n));
  expect(f.goals.get(f.agent.id)).toMatchObject({
    state: "active",
    compactions: 99,
  });
  const reopened = new Store(f.path);
  expect(new Goals(reopened).get(f.agent.id)!.compactions).toBe(99);
  reopened.close();
  count("100");
  expect(f.goals.get(f.agent.id)).toMatchObject({
    state: "paused",
    compactions: 100,
  });
  expect(f.goals.get(f.agent.id)!.reason).toContain("100 successful");
  expect(count("101")).toBeNull();
  expect(f.goals.continuation(binding)).toBeNull();
  expect(() => f.goals.update(binding, "completed", "late")).toThrow(
    "no longer active",
  );
  expect(() =>
    f.change(f.goals.get(f.agent.id)!, "edit", { objective: "new" }),
  ).toThrow("running work");
  f.store.finishRun(run.id, "cancelled", null);
  const edited = f.change(f.goals.get(f.agent.id)!, "edit", {
    objective: "edited scope",
  });
  expect(edited.compactions).toBe(100);
  const resumed = f.change(edited, "resume");
  const next = admit(f, resumed);
  expect(resumed.compactions).toBe(0);
  expect(count("stale")).toBeNull();
  expect(f.goals.get(f.agent.id)!.compactions).toBe(0);
  f.goals.compacted(next.binding, "new");
  f.goals.recover();
  expect(f.goals.get(f.agent.id)).toMatchObject({
    state: "paused",
    compactions: 1,
  });
  f.change(f.goals.get(f.agent.id)!, "clear");
  f.store.finishRun(next.run.id, "interrupted", null);
  const replacement = f.create({ requestId: "replacement" });
  expect(f.goals.compacted(next.binding, "replacement-stale")).toBeNull();
  expect(f.goals.get(f.agent.id)).toEqual(replacement);
});

test.each(["active", "budget_exhausted", "blocked", "paused", "completed"])(
  "v18 migration preserves %s evidence and receipts without activation or resume replay",
  (state) => {
    const f = fixture();
    const original = f.create();
    const legacy = {
      ...original,
      state,
      progress: "Verified historical work",
      tokenBudget: 900,
      tokensUsed: 901,
      usageUnknown: true,
    };
    delete (legacy as Partial<Goal>).compactions;
    f.store.db
      .query("UPDATE agent_goals SET record=? WHERE id=?")
      .run(JSON.stringify(legacy), original.id);
    const input = {
      goalId: original.id,
      expectedRevision: 1,
      requestId: "old-resume",
    };
    const payload = JSON.stringify([
      "resume",
      Object.fromEntries(
        Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
      ),
    ]);
    f.store.db
      .query("INSERT INTO goal_mutations VALUES (?,?,?,?)")
      .run(f.agent.id, input.requestId, payload, JSON.stringify(legacy));
    f.store.db.exec("DROP TABLE goal_compactions; PRAGMA user_version=18;");
    const migrated = new Store(f.path);
    const goals = new Goals(migrated);
    const goal = goals.get(f.agent.id)!;
    expect(goal).toMatchObject({
      id: original.id,
      objective: original.objective,
      progress: legacy.progress,
      compactions: 0,
      state: state === "completed" ? "completed" : "paused",
    });
    expect(goal).not.toHaveProperty("tokenBudget");
    expect(goal).not.toHaveProperty("tokensUsed");
    expect(goals.mutate(f.agent.id, "resume", input)).toMatchObject({
      reused: true,
      goal,
    });
    expect(migrated.runs(f.agent.id)).toHaveLength(0);
    expect(() =>
      goals.mutate(f.agent.id, "resume", { ...input, expectedRevision: 9 }),
    ).toThrow("different goal mutation");
    migrated.close();
  },
);

test("failed resume admission retains the previous counter and old receipt replay cannot reset it", () => {
  const f = fixture();
  let goal = f.create();
  const input = {
    goalId: goal.id,
    expectedRevision: goal.revision,
    requestId: "resume",
  };
  goal = f.goals.mutate(f.agent.id, "resume", input).goal;
  const { run, binding } = admit(f, goal);
  for (let n = 0; n < 100; n++)
    f.store.db.transaction(() => f.goals.compacted(binding, String(n)))();
  expect(f.goals.mutate(f.agent.id, "resume", input).reused).toBe(true);
  expect(f.goals.get(f.agent.id)!.compactions).toBe(100);
  expect(() => f.change(f.goals.get(f.agent.id)!, "resume")).toThrow(
    "current work",
  );
  f.store.finishRun(run.id, "cancelled", null);
  goal = f.change(f.goals.get(f.agent.id)!, "resume");
  expect(goal.compactions).toBe(100);
  expect(() => f.goals.admit(goal, "missing-run")).toThrow();
  f.goals.stop(f.agent.id, "Admission failed", "blocked");
  expect(f.goals.get(f.agent.id)).toMatchObject({
    state: "blocked",
    compactions: 100,
  });
});
