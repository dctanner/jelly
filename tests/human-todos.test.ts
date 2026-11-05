import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store";
import { Goals } from "../src/server/goals";
import { HumanTodos } from "../src/server/human-todos";
import type { HumanTodo, HumanTodoActor } from "../src/shared/human-todos";
import { removePostV19SchemaForLegacyFixture } from "./fixtures/schema";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-human-todos-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "test.sqlite"),
    store = new Store(file);
  cleanup.push(() => store.close());
  const agent = store.addAgent({
    name: "Requester",
    instructions: "",
    color: "#fff",
  });
  const run = store.createRun(
    agent.id,
    "source",
    "Authorized work",
    "api",
    "gpt-6-astra",
  );
  const actor: HumanTodoActor = {
    kind: "agent",
    agentId: agent.id,
    runId: run.id,
  };
  const events: string[] = [],
    goals = new Goals(store);
  const todos = new HumanTodos(store, goals, (event) => {
    expect(store.db.inTransaction).toBe(false);
    events.push(event.type);
  });
  const create = (input = {}, owner: HumanTodoActor = actor) =>
    todos.mutate(
      "create",
      null,
      {
        requestId: crypto.randomUUID(),
        title: "Upload agreement",
        instructions: "Use existing upload",
        reason: "Finish filing",
        ...input,
      },
      owner,
    ).todo;
  const update = (
    todo: HumanTodo,
    input: Record<string, unknown>,
    owner?: HumanTodoActor,
  ) =>
    todos.mutate(
      "update",
      todo.id,
      {
        requestId: crypto.randomUUID(),
        expectedRevision: todo.revision,
        ...input,
      },
      owner,
    ).todo;
  return {
    file,
    store,
    agent,
    actor,
    goals,
    todos,
    events,
    create,
    update,
    run,
  };
}
test("v19 migration, durable revisions/receipts/audit, soft deletion and actor provenance", () => {
  const f = fixture();
  removePostV19SchemaForLegacyFixture(f.store.db);
  f.store.db.exec("PRAGMA user_version=19");
  const migrated = new Store(f.file);
  cleanup.push(() => migrated.close());
  expect(migrated.db.query("PRAGMA user_version").get()).toEqual({
    user_version: 20,
  });
  const input = { requestId: "stable", title: "Upload agreement" };
  const first = f.todos.mutate("create", null, input, f.actor);
  expect(f.todos.mutate("create", null, input, f.actor)).toEqual(first);
  expect(() =>
    f.todos.mutate("create", null, { ...input, title: "Changed" }, f.actor),
  ).toThrow("different input");
  let todo = first.todo;
  expect(todo.creator).toEqual(f.actor);
  expect(todo.sourceAgentId).toBe(f.agent.id);
  expect(() => f.update(todo, { actor: "human" })).toThrow("server-owned");
  todo = f.update(todo, { title: "Edited by human" });
  expect(() => f.update(first.todo, { title: "stale" })).toThrow("draft");
  todo = f.update(todo, { status: "done", resolutionNote: "Uploaded" });
  expect(todo.resolutionActor).toEqual({ kind: "human" });
  expect(todo.completionId).toBeTruthy();
  const completion = todo.completionId;
  todo = f.update(todo, { status: "open" });
  expect(todo.completionId).toBeNull();
  expect(() => f.update(todo, { status: "done" }, f.actor)).toThrow("evidence");
  todo = f.update(
    todo,
    { status: "done", resolutionNote: "Observed file contents" },
    f.actor,
  );
  expect(todo.completionId).not.toBe(completion);
  expect(todo.resolutionActor).toEqual(f.actor);
  expect(f.todos.waiting()).toHaveLength(0);
  const request = { requestId: "delete", expectedRevision: todo.revision };
  const receipt = f.todos.mutate("delete", todo.id, request);
  expect(receipt.todo.deletedAt).toBeTruthy();
  expect(f.todos.list().items).toHaveLength(0);
  expect(f.todos.mutate("delete", todo.id, request)).toEqual(receipt);
  expect(() => f.update(receipt.todo, { title: "revive" })).toThrow("deleted");
  expect(
    new HumanTodos(migrated, new Goals(migrated)).detail(todo.id).history,
  ).toHaveLength(6);
  expect(f.store.runs(f.agent.id)).toHaveLength(1);
});
test("agent ownership, dedupe payload conflicts and reassignment revoke even create-receipt access", () => {
  const f = fixture(),
    other = f.store.addAgent({
      name: "Other",
      instructions: "",
      color: "#fff",
    });
  const input = { requestId: "create", title: "Action", dedupeKey: "blocker" };
  const first = f.todos.mutate("create", null, input, f.actor);
  expect(
    f.todos.mutate("create", null, { ...input, requestId: "retry" }, f.actor)
      .todo.id,
  ).toBe(first.todo.id);
  expect(() =>
    f.todos.mutate(
      "create",
      null,
      { ...input, requestId: "retry2", title: "Different" },
      f.actor,
    ),
  ).toThrow("Deduplication");
  const unassigned = f.create({}, { kind: "human" });
  expect(() => f.todos.get(unassigned.id, f.actor)).toThrow("not found");
  let todo = f.update(first.todo, { agentId: other.id });
  expect(todo.creator).toEqual(f.actor);
  expect(todo.sourceAgentId).toBe(f.agent.id);
  expect(() => f.todos.mutate("create", null, input, f.actor)).toThrow(
    "not found",
  );
  expect(() => f.todos.get(todo.id, f.actor)).toThrow("not found");
  todo = f.update(todo, { agentId: f.agent.id });
  expect(f.update(todo, { title: "Own again" }, f.actor).title).toBe(
    "Own again",
  );
  expect(() => f.update(todo, { agentId: null }, f.actor)).toThrow(
    "server-owned",
  );
});
test("completion and delivery commit together; revision fences; at-most-once admission and new completion identity", () => {
  const f = fixture();
  let todo = f.create();
  const receipt = f.todos.mutate("complete", todo.id, {
    requestId: "complete",
    expectedRevision: todo.revision,
    continueAgent: true,
  });
  todo = receipt.todo;
  const delivery = receipt.delivery!;
  expect(delivery.state).toBe("waiting");
  expect(f.store.pendingMessages(f.agent.id)).toHaveLength(0);
  todo = f.update(todo, { instructions: "Updated context" });
  expect(f.todos.delivery(delivery.id)?.state).toBe("cancelled");
  expect(() =>
    f.store.db.transaction(() => f.todos.admit(delivery.id, f.run.id))(),
  ).toThrow("no longer waiting");
  const reconfirmed = f.todos.mutate("continue", todo.id, {
    requestId: "reconfirm",
    expectedRevision: todo.revision,
  }).delivery!;
  expect(reconfirmed.id).not.toBe(delivery.id);
  expect(f.todos.delivery(delivery.id)?.snapshot).toEqual(delivery.snapshot);
  expect(reconfirmed.snapshot.instructions).toBe("Updated context");
  const event = f.store.db.transaction(() =>
    f.todos.admit(reconfirmed.id, f.run.id),
  )();
  expect(event.type).toBe("human_todo_continuation_changed");
  expect(() =>
    f.todos.mutate("continue", todo.id, {
      requestId: "again",
      expectedRevision: todo.revision,
    }),
  ).toThrow("Already started");
  f.todos.hold(f.agent.id, "Stop", true);
  expect(f.todos.delivery(reconfirmed.id)?.state).toBe("admitted");
  todo = f.update(todo, { status: "open" });
  const next = f.todos.mutate("complete", todo.id, {
    requestId: "complete2",
    expectedRevision: todo.revision,
    continueAgent: true,
  });
  expect(next.delivery?.id).not.toBe(delivery.id);
  f.todos.hold(null, "Restart");
  expect(f.todos.delivery(next.delivery!.id)?.state).toBe("needs_retry");
});
test("goal blocker transaction and private handoff grouping preserve secure request lifecycle", () => {
  const f = fixture();
  const goal = f.goals.mutate(f.agent.id, "create", {
    requestId: "goal",
    objective: "File agreement",
  }).goal;
  f.goals.mutate(f.agent.id, "resume", {
    requestId: "resume",
    expectedRevision: goal.revision,
    goalId: goal.id,
  });
  f.goals.admit(f.goals.get(f.agent.id)!, f.run.id);
  let todo = f.create({ blocking: true });
  expect(todo.goalId).toBe(goal.id);
  expect(f.goals.get(f.agent.id)?.state).toBe("blocked");
  todo = f.update(todo, { status: "done" });
  expect(() =>
    f.todos.mutate("continue", todo.id, {
      requestId: "cont",
      expectedRevision: todo.revision,
    }),
  ).toThrow("Review the linked goal");
  expect(f.goals.get(f.agent.id)?.state).toBe("blocked");
  const request = f.store.createIntervention(
    "sudo",
    f.agent.id,
    f.run.id,
    { secretFixturePayload: "must-not-project" },
    new Date(Date.now() + 10000).toISOString(),
  );
  f.store.event(f.agent.id, f.run.id, "intervention_requested", { request });
  const linked = f.create({ interventionId: request.id });
  expect(f.todos.counts().total).toBe(1);
  expect(f.todos.handoffs()[0]).toMatchObject({
    todoId: linked.id,
    status: "pending",
  });
  expect(JSON.stringify(f.todos.handoffs())).not.toContain("must-not-project");
  f.store.updateIntervention(request.id, "completed", {});
  expect(f.todos.get(linked.id).status).toBe("open");
  expect(f.todos.counts().total).toBe(1);
  expect(() => f.create({ interventionId: "foreign" })).toThrow(
    "Private request",
  );
});
test("open ordering/cursor/filter/history, field limits, rollback and post-commit notifications", () => {
  const f = fixture();
  const first = f.create({ title: "Ordinary" }),
    blocker = f.create({ title: "Blocking", blocking: true });
  f.create({ title: "Other" }, { kind: "human" });
  const page = f.todos.list({ limit: 1 });
  expect(page.items[0]?.id).toBe(blocker.id);
  expect(page.after).toBeTruthy();
  expect(f.todos.list({ limit: 1, after: page.after }).items[0]?.id).toBe(
    f.todos.list().items[1]?.id,
  );
  expect(f.todos.list({ agentId: "unassigned" }).items).toHaveLength(1);
  expect(f.todos.list({ q: "ordinary" }).items[0]?.id).toBe(first.id);
  f.update(first, { status: "cancelled" });
  expect(f.todos.list({ status: "history" }).items[0]?.status).toBe(
    "cancelled",
  );
  expect(() => f.create({ title: "a".repeat(161) })).toThrow("160");
  expect(() => f.todos.list({ limit: 101 })).toThrow("Invalid");
  expect(() => f.todos.list({ after: "invalid" })).toThrow("cursor");
  const count = f.todos.counts().total;
  f.store.db.exec(
    "CREATE TRIGGER fail_todo_audit BEFORE INSERT ON human_todo_mutations BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END;",
  );
  const before = f.events.length;
  expect(() => f.create()).toThrow("fixture rollback");
  expect(f.todos.counts().total).toBe(count);
  expect(f.events).toHaveLength(before);
});

test("completion/delivery and goal-blocker transactions roll back together before commit", () => {
  const f = fixture(),
    todo = f.create();
  f.store.db.exec(
    "CREATE TRIGGER fail_todo_audit BEFORE INSERT ON human_todo_mutations BEGIN SELECT RAISE(ABORT, 'before commit'); END;",
  );
  expect(() =>
    f.todos.mutate("complete", todo.id, {
      requestId: "complete",
      expectedRevision: 1,
      continueAgent: true,
    }),
  ).toThrow("before commit");
  expect(f.todos.get(todo.id).status).toBe("open");
  expect(f.todos.waiting()).toHaveLength(0);
  const goal = f.goals.mutate(f.agent.id, "create", {
    requestId: "goal",
    objective: "Still active",
  }).goal;
  f.goals.mutate(f.agent.id, "resume", {
    requestId: "resume",
    goalId: goal.id,
    expectedRevision: goal.revision,
  });
  f.goals.admit(f.goals.get(f.agent.id)!, f.run.id);
  expect(() => f.create({ blocking: true })).toThrow("before commit");
  expect(f.goals.get(f.agent.id)?.state).toBe("active");
});

test("only meaningful agent creation/reopening creates content-light attention, not human edits or receipt replay", () => {
  const f = fixture();
  let todo = f.create({ title: "Private-context fixture title" });
  const first = f.store
    .agentNotifications()
    .find((item) => item.type === "human_todo_attention")!;
  expect(first.todoId).toBe(todo.id);
  expect(JSON.stringify(first)).not.toContain(todo.title);
  todo = f.update(todo, { title: "Human edit", status: "done" });
  expect(f.store.agentNotifications().at(-1)?.id).toBe(first.id);
  const input = {
    requestId: "reopen",
    expectedRevision: todo.revision,
    status: "open",
    resolutionNote: "Observed missing signature",
  };
  f.todos.mutate("update", todo.id, input, f.actor);
  const marker = f.store.agentNotifications().at(-1)!;
  expect(marker.id).toBeGreaterThan(first.id);
  f.todos.mutate("update", todo.id, input, f.actor);
  expect(f.store.agentNotifications().at(-1)).toEqual(marker);
});

test("all blockers from one goal execution retain its identity after fencing; tombstones cannot fence a resumed goal", () => {
  const f = fixture();
  let goal = f.goals.mutate(f.agent.id, "create", {
    requestId: "create-goal", objective: "File authorized documents",
  }).goal;
  goal = f.goals.mutate(f.agent.id, "resume", {
    requestId: "resume-goal", goalId: goal.id, expectedRevision: goal.revision,
  }).goal;
  const binding = f.goals.admit(goal, f.run.id);
  f.goals.compacted(binding, "checkpoint-1");
  const first = f.create({ title: "First blocker", blocking: true });
  const blocked = f.goals.get(f.agent.id)!;
  const second = f.create({ title: "Second blocker", blocking: true });
  expect(f.goals.get(f.agent.id)).toEqual(blocked);
  expect(blocked.compactions).toBe(1);
  for (const todo of [first, second]) {
    expect(todo.goalId).toBe(goal.id);
    expect(todo.originGoalId).toBe(goal.id);
    expect(() => f.todos.mutate("complete", todo.id, {
      requestId: `complete-continue-${todo.id}`, expectedRevision: todo.revision, continueAgent: true,
    })).toThrow("Review the linked goal");
  }
  f.store.finishRun(f.run.id, "completed", null);
  const done = f.update(second, { status: "done" });
  expect(() => f.todos.mutate("continue", done.id, {
    requestId: "after-settlement", expectedRevision: done.revision,
  })).toThrow("Review the linked goal");
  expect(f.todos.waiting()).toHaveLength(0);
  goal = f.goals.mutate(f.agent.id, "resume", {
    requestId: "resume-again", goalId: blocked.id, expectedRevision: blocked.revision,
  }).goal;
  const run = f.store.createRun(f.agent.id, "resumed", "Resume goal", "api", "gpt-6-astra");
  const resumed = f.goals.admit(goal, run.id);
  f.goals.compacted(resumed, "checkpoint-2");
  const active = f.goals.get(f.agent.id);
  const deleted = f.todos.mutate("delete", first.id, {
    requestId: "delete-blocker", expectedRevision: first.revision, resolutionNote: "No longer needed",
  }, { kind: "agent", agentId: f.agent.id, runId: run.id });
  expect(deleted.todo.deletedAt).toBeTruthy();
  expect(deleted.history[0]?.action).toBe("delete");
  expect(f.goals.get(f.agent.id)).toEqual(active);
  expect(active?.compactions).toBe(1);
});

test("ordinary runs do not inherit a replacement goal and historical run provenance never fences it", () => {
  const f = fixture();
  let goal = f.goals.mutate(f.agent.id, "create", { requestId: "g1", objective: "Original" }).goal;
  goal = f.goals.mutate(f.agent.id, "resume", { requestId: "r1", goalId: goal.id, expectedRevision: goal.revision }).goal;
  expect(f.create({ blocking: true }).goalId).toBeNull();
  expect(f.goals.get(f.agent.id)).toEqual(goal);
  f.goals.admit(goal, f.run.id);
  f.store.finishRun(f.run.id, "completed", null);
  f.goals.mutate(f.agent.id, "clear", { requestId: "clear", goalId: goal.id, expectedRevision: goal.revision });
  let replacement = f.goals.mutate(f.agent.id, "create", { requestId: "g2", objective: "Replacement" }).goal;
  replacement = f.goals.mutate(f.agent.id, "resume", { requestId: "r2", goalId: replacement.id, expectedRevision: replacement.revision }).goal;
  // Domain-level historical provenance check; stopped-owner tools also reject this call.
  const historical = f.create({ blocking: true });
  expect(historical.goalId).toBe(goal.id);
  expect(historical.originGoalId).toBe(goal.id);
  expect(f.goals.get(f.agent.id)).toEqual(replacement);
});
