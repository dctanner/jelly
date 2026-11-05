import { afterEach, expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./fixtures/app";
import type { HumanTodo } from "../src/shared/human-todos";
const cleanup: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(delay = 20, concurrency = 2, scheduleClock?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), "jelly-todo-runtime-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startApp({
    dataDir: dir,
    authPath: join(dir, "auth.json"),
    configDir: join(dir, "config"),
    port: 0,
    fixtureDelayMs: delay,
    scheduleClock,
    schedulerOptions: { concurrency, pollMs: 60000 },
  });
  cleanup.push(() => app.close());
  const agent = app.service.createAgent({
    name: "Todo fixture",
    instructions: "Only local fixture work",
    color: "#fff",
  });
  const create = () =>
    app.service.changeHumanTodo("create", null, {
      title: "Upload signed document",
      agentId: agent.id,
      blocking: true,
      requestId: crypto.randomUUID(),
    }).todo;
  const complete = (todo: HumanTodo) =>
    app.service.changeHumanTodo("complete", todo.id, {
      requestId: crypto.randomUUID(),
      expectedRevision: todo.revision,
      continueAgent: true,
    });
  return { ...app, agent, create, complete };
}
test("Done never runs; Done & continue shares admission/checkpoint/tools and at-most-once completion binding", async () => {
  const f = await fixture();
  const todo = f.create();
  f.service.changeHumanTodo("complete", todo.id, {
    requestId: "done",
    expectedRevision: 1,
  });
  expect(f.store.runs(f.agent.id)).toHaveLength(0);
  let creations = 0;
  const original = f.service.harness.create.bind(f.service.harness);
  f.service.harness.create = async (...args) => {
    expect(f.store.db.inTransaction).toBe(false);
    creations++;
    const detail = f.service.humanTodos.detail(todo.id);
    expect(detail.delivery?.state).toBe("admitted");
    expect(f.store.run(detail.delivery!.runId!)?.status).toBe("running");
    expect(
      args[4]
        ?.filter((tool) => tool.name.startsWith("human_todo_"))
        .map((tool) => tool.name),
    ).toHaveLength(4);
    expect(args[0].instructions).toContain("contextual data");
    return original(...args);
  };
  const input = { requestId: "continue", expectedRevision: 2 };
  f.service.changeHumanTodo("continue", todo.id, input);
  f.service.changeHumanTodo("continue", todo.id, input);
  await f.service.settled();
  expect(creations).toBe(1);
  expect(f.store.runs(f.agent.id)).toHaveLength(1);
  let detail = f.service.humanTodos.detail(todo.id);
  expect(detail.run?.status).toBe("completed");
  expect(detail.todo.status).toBe("done");
  expect(detail.run?.source?.source).toBe("human_todo");
  expect(f.store.pendingMessages(f.agent.id)).toHaveLength(0);
  expect(() =>
    f.service.changeHumanTodo("continue", todo.id, {
      ...input,
      requestId: "new-click",
    }),
  ).toThrow("Already started");
  expect(f.store.context(f.agent.id)).toBeTruthy();
  detail = f.service.humanTodos.detail(todo.id);
  expect(detail.delivery?.runId).toBe(f.store.runs(f.agent.id)[0]?.id);
});
test("busy agents retain tasks; human queue wins, no steer/concurrency; useful unrelated ordinary work remains available", async () => {
  const f = await fixture(70),
    todo = f.create();
  f.service.start(f.agent.id, "ordinary", "Ordinary unrelated work");
  f.service.start(f.agent.id, "human-queue", "Queued human input");
  const completion = f.complete(todo);
  expect(f.service.humanTodos.detail(todo.id).delivery?.state).toBe("waiting");
  expect(f.store.pendingMessages(f.agent.id).map((item) => item.id)).toEqual([
    "human-queue",
  ]);
  await f.service.settled();
  const runs = f.store.db
    .query("SELECT requestId,source FROM runs WHERE agentId=? ORDER BY rowid")
    .all(f.agent.id) as { requestId: string; source: string | null }[];
  expect(runs.map((run) => run.requestId).slice(0, 2)).toEqual([
    "ordinary",
    "human-queue",
  ]);
  expect(runs).toHaveLength(3);
  expect(f.service.humanTodos.detail(todo.id).delivery?.id).toBe(
    completion.delivery?.id,
  );
  expect(f.service.humanTodos.detail(todo.id).run?.status).toBe("completed");
});
test.each(["reopen", "delete", "reassign", "edit", "stop"])(
  "%s before busy settlement invalidates unstarted continuation",
  async (operation) => {
    const f = await fixture(70),
      todo = f.create();
    f.service.start(f.agent.id, "busy", "Useful work");
    const completed = f.complete(todo).todo;
    if (operation === "stop") await f.service.stop(f.agent.id);
    else if (operation === "delete")
      f.service.changeHumanTodo("delete", todo.id, {
        requestId: "delete",
        expectedRevision: completed.revision,
      });
    else
      f.service.changeHumanTodo("update", todo.id, {
        requestId: "invalidate",
        expectedRevision: completed.revision,
        ...(operation === "reopen"
          ? { status: "open" }
          : operation === "reassign"
            ? { agentId: null }
            : { instructions: "New dependency context" }),
      });
    await f.service.settled();
    expect(f.store.runs(f.agent.id)).toHaveLength(1);
    expect(f.service.humanTodos.detail(todo.id).delivery?.state).toBe(
      "cancelled",
    );
  },
);
test("failure holds waiting delivery for explicit retry; archive/restore and Fresh Session never trigger it", async () => {
  const f = await fixture(30),
    todo = f.create();
  const original = f.service.harness.create;
  f.service.harness.create = async () => {
    await Bun.sleep(60);
    throw new Error("fixture failure");
  };
  f.service.start(f.agent.id, "failure", "Work");
  f.complete(todo);
  await f.service.settled();
  expect(f.service.humanTodos.detail(todo.id).delivery?.state).toBe(
    "needs_retry",
  );
  f.service.harness.create = original;
  f.service.archiveAgent(f.agent.id, true);
  f.service.archiveAgent(f.agent.id, false);
  expect(f.service.humanTodos.detail(todo.id).delivery?.state).toBe(
    "cancelled",
  );
  expect(f.service.humanTodos.list({ status: "history" }).items[0]?.id).toBe(
    todo.id,
  );
  f.service.freshSession(f.agent.id, "fresh");
  await f.service.settled();
  expect(f.store.runs(f.agent.id)).toHaveLength(2);
  expect(f.service.humanTodos.detail(todo.id).todo.status).toBe("done");
});
test("goal activation prevents ordinary delivery and goal blocking is atomic without silent resume", async () => {
  const f = await fixture(20),
    todo = f.create();
  // Persist an active goal without starting a second run, like the activation/admission boundary.
  const goal = f.service.goals.mutate(f.agent.id, "create", {
    requestId: "goal",
    objective: "Authorized objective",
  }).goal;
  const active = f.service.goals.mutate(f.agent.id, "resume", {
    requestId: "resume",
    goalId: goal.id,
    expectedRevision: goal.revision,
  }).goal;
  f.complete(todo);
  expect(f.service.humanTodos.detail(todo.id).delivery?.state).toBe(
    "needs_retry",
  );
  expect(f.store.runs(f.agent.id)).toHaveLength(0);
  expect(f.service.goals.get(f.agent.id)?.epoch).toBe(active.epoch);
  expect(f.service.goals.get(f.agent.id)?.compactions).toBe(active.compactions);
  f.service.goals.stop(f.agent.id, "explicit pause");
  expect(f.service.humanTodos.detail(todo.id).delivery?.state).toBe(
    "needs_retry",
  );
});
test("admission rollback leaves Done and retry without provider work; shared automated capacity is bounded", async () => {
  const f = await fixture(),
    todo = f.create();
  let called = false;
  const original = f.service.harness.create;
  f.service.harness.create = async (...args) => {
    called = true;
    return original.apply(f.service.harness, args);
  };
  f.store.db.exec(
    "CREATE TRIGGER fail_todo_run BEFORE UPDATE ON human_todo_deliveries WHEN NEW.state='admitted' BEGIN SELECT RAISE(ABORT,'admission rollback'); END;",
  );
  f.complete(todo);
  expect(called).toBe(false);
  expect(f.store.runs(f.agent.id)).toHaveLength(0);
  expect(f.service.humanTodos.detail(todo.id).todo.status).toBe("done");
  expect(f.service.humanTodos.detail(todo.id).delivery?.state).toBe(
    "needs_retry",
  );
  f.store.db.exec("DROP TRIGGER fail_todo_run");
  f.service.changeHumanTodo("continue", todo.id, {
    requestId: "retry",
    expectedRevision: 2,
  });
  await f.service.settled();
  expect(called).toBe(true);
  expect(f.store.runs(f.agent.id)).toHaveLength(1);
});

test("automated capacity includes private/child settlement and waiting goal activation requires renewed review", async () => {
  const f = await fixture(20, 1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanup.push(() => release());
  const settle = f.service.harness.settle.bind(f.service.harness);
  let reached = false;
  f.service.harness.settle = async (session) => {
    await settle(session);
    reached = true;
    await gate;
  };
  const first = f.create();
  f.complete(first);
  const other = f.service.createAgent({
    name: "Second requester",
    instructions: "",
    color: "#fff",
  });
  const second = f.service.changeHumanTodo("create", null, {
    requestId: "second",
    agentId: other.id,
    title: "Second action",
  }).todo;
  f.service.changeHumanTodo("complete", second.id, {
    requestId: "second-done",
    expectedRevision: 1,
    continueAgent: true,
  });
  for (let n = 0; n < 100 && !reached; n++) await Bun.sleep(10);
  expect(reached).toBe(true);
  expect(f.service.humanTodos.detail(first.id).run?.status).toBe("running");
  expect(f.service.humanTodos.detail(second.id).delivery?.state).toBe(
    "waiting",
  );
  const createSession = f.service.harness.create.bind(f.service.harness);
  f.service.harness.create = async (...args) => {
    if (args[0].id === other.id)
      throw new Error("Fixture goal provider unavailable");
    return createSession(...args);
  };
  const goal = f.service.changeGoal(other.id, "create", {
    requestId: "new-goal",
    objective: "Current goal work",
  }).goal!;
  f.service.changeGoal(other.id, "resume", {
    requestId: "goal-resume",
    goalId: goal.id,
    expectedRevision: goal.revision,
  });
  expect(f.service.humanTodos.detail(second.id).delivery?.state).toBe(
    "needs_retry",
  );
  // Fence goal work before releasing the fixture settlement gate.
  f.service.goals.stop(other.id, "Operator pause");
  release();
  await f.service.settled();
  expect(f.service.humanTodos.detail(second.id).delivery?.state).toBe(
    "needs_retry",
  );
});

test("running goal holds ordinary continuations requested before/during admission; all its blockers retain goal identity after settlement", async () => {
  const f = await fixture();
  const waitingOrdinary = f.create();
  // Durable completion boundary before dispatch: subsequent goal admission must hold it immediately.
  f.service.humanTodos.mutate("complete", waitingOrdinary.id, {
    requestId: "before-goal", expectedRevision: 1, continueAgent: true,
  });
  expect(f.service.humanTodos.detail(waitingOrdinary.id).delivery?.state).toBe("waiting");
  const createSession = f.service.harness.create.bind(f.service.harness);
  f.service.harness.create = async (...args) => {
    const session = await createSession(...args);
    let turn = 0;
    session.agent.streamFunction = model => {
      const first = turn++ === 0;
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: first ? "toolUse" : "stop",
        content: first ? ["First dependency", "Second dependency"].map(title => ({
          type: "toolCall" as const, id: title, name: "human_todo_create",
          arguments: { requestId: title, title, blocking: true },
        })) : [{ type: "text", text: "Both dependencies recorded. Waiting for explicit goal review." }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
      stream.end(message);
      return stream;
    };
    return session;
  };
  const goal = f.service.changeGoal(f.agent.id, "create", { requestId: "goal", objective: "File documents" }).goal!;
  f.service.changeGoal(f.agent.id, "resume", { requestId: "resume", goalId: goal.id, expectedRevision: goal.revision });
  expect(f.service.humanTodos.detail(waitingOrdinary.id).delivery?.state).toBe("needs_retry");
  const active = f.service.goals.get(f.agent.id)!;
  expect(active.state).toBe("active");
  expect(f.store.runs(f.agent.id)[0]?.status).toBe("running");
  const duringGoal = f.create();
  const receipt = f.complete(duringGoal);
  expect(receipt.todo.status).toBe("done");
  expect(receipt.delivery?.state).toBe("needs_retry");
  expect(f.service.goals.get(f.agent.id)).toEqual(active);
  await f.service.settled();
  for (const todo of [waitingOrdinary, duringGoal]) {
    expect(f.service.humanTodos.detail(todo.id).delivery?.state).toBe("needs_retry");
    expect(f.service.humanTodos.detail(todo.id).run).toBeNull();
  }
  const created = f.service.humanTodos.list({ agentId: f.agent.id }).items.map(item => f.service.humanTodos.get(item.id));
  expect(created).toHaveLength(2);
  for (const todo of created) {
    expect(todo.goalId).toBe(goal.id);
    expect(todo.originGoalId).toBe(goal.id);
    expect(() => f.complete(todo)).toThrow("Review the linked goal");
    const done = f.service.changeHumanTodo("complete", todo.id, { requestId: `done-${todo.id}`, expectedRevision: 1 }).todo;
    expect(() => f.service.changeHumanTodo("continue", todo.id, { requestId: `continue-${todo.id}`, expectedRevision: done.revision })).toThrow("Review the linked goal");
    expect(f.service.humanTodos.detail(todo.id).delivery).toBeNull();
  }
  expect(f.service.goals.get(f.agent.id)?.state).toBe("blocked");
  expect(f.store.runs(f.agent.id)).toHaveLength(1);
});

test("saving a Done task note does not run; explicit Continue snapshots the saved note", async () => {
  const f = await fixture(), todo = f.create();
  const done = f.service.changeHumanTodo("complete", todo.id, { requestId: "done", expectedRevision: 1 }).todo;
  const updated = f.service.changeHumanTodo("update", todo.id, {
    requestId: "note", expectedRevision: done.revision, resolutionNote: "Uploaded signed-agreement.pdf",
  }).todo;
  expect(f.store.runs(f.agent.id)).toHaveLength(0);
  f.service.changeHumanTodo("continue", todo.id, { requestId: "continue", expectedRevision: updated.revision });
  await f.service.settled();
  const detail = f.service.humanTodos.detail(todo.id);
  expect(detail.delivery?.snapshot.resolutionNote).toBe("Uploaded signed-agreement.pdf");
  expect(detail.delivery?.snapshot.revision).toBe(updated.revision);
  expect(detail.run?.status).toBe("completed");
});

test("mixed schedule/todo backlogs alternate actual admission turns without starvation from paired settlement/wake ticks", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const f = await fixture(20, 1, () => now);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  cleanup.push(() => release());
  const createSession = f.service.harness.create.bind(f.service.harness);
  let first = true;
  f.service.harness.create = async (...args) => {
    if (first) { first = false; await gate; }
    return createSession(...args);
  };
  f.complete(f.create());
  for (let index = 0; index < 5; index++) {
    const other = f.service.createAgent({ name: `Queued ${index}`, instructions: "", color: "#fff" });
    const task = f.service.changeHumanTodo("create", null, { requestId: `todo-${index}`, agentId: other.id, title: "Queued dependency" }).todo;
    f.complete(task);
  }
  const scheduled = f.service.createAgent({ name: "Scheduled", instructions: "", color: "#fff" });
  for (let index = 0; index < 5; index++)
    f.service.schedules.create(scheduled.id, { requestId: `schedule-${index}`, title: "Scheduled work", prompt: "Local fixture", kind: "once", runAt: new Date(now + 60000).toISOString(), timezone: "UTC" });
  now += 60000;
  f.service.scheduler.tick();
  await Bun.sleep(20);
  expect(f.store.db.query("SELECT count(*) n FROM runs WHERE status='running'").get()).toEqual({ n: 1 });
  release();
  await f.service.settled();
  const sources = (f.store.db.query("SELECT json_extract(source,'$.source') source FROM runs ORDER BY rowid").all() as { source: string }[]).map(row => row.source);
  expect(sources).toEqual(Array.from({ length: 11 }, (_, index) => index % 2 ? "schedule" : "human_todo"));
});
