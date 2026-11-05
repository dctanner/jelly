import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store";
import { Goals } from "../src/server/goals";
import { HumanTodos } from "../src/server/human-todos";
import { humanTodoTools } from "../src/server/human-todo-tools";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
test("four parent-bound tools reject forged scope/provenance/wakes, support human tasks, and fence stopped owners", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-todo-tools-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "test.sqlite"));
  cleanup.push(() => store.close());
  const agent = store.addAgent({
    name: "Parent",
    instructions: "",
    color: "#fff",
  });
  const other = store.addAgent({
    name: "Other",
    instructions: "",
    color: "#fff",
  });
  const run = store.createRun(agent.id, "work", "work", "api", agent.model);
  const todos = new HumanTodos(store, new Goals(store));
  let active = true;
  const tools = humanTodoTools(todos, agent.id, run.id, () => active);
  expect(tools.map((tool) => tool.name)).toEqual([
    "human_todo_list",
    "human_todo_create",
    "human_todo_update",
    "human_todo_delete",
  ]);
  const call = async (
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    const result = await tools
      .find((tool) => tool.name === name)!
      .execute("tool", input, signal, undefined, {} as never);
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  for (const forged of [
    { agentId: other.id },
    { creator: { kind: "human" } },
    { sourceActivityId: 123 },
    { continueAgent: true },
    { goalId: "fake" },
  ])
    await expect(
      call("human_todo_create", {
        title: "Task",
        requestId: crypto.randomUUID(),
        ...forged,
      }),
    ).rejects.toThrow("server-owned");
  const human = todos.mutate("create", null, {
    title: "Manually linked",
    agentId: agent.id,
    requestId: "human",
  }).todo;
  const edited = await call("human_todo_update", {
    todoId: human.id,
    expectedRevision: 1,
    requestId: "edit",
    instructions: "Updated instructions",
  });
  expect(edited.todo.creator).toEqual({ kind: "human" });
  expect(edited.todo.instructions).toBe("Updated instructions");
  const foreign = todos.mutate("create", null, {
    title: "Other",
    agentId: other.id,
    requestId: "other",
  }).todo;
  await expect(call("human_todo_list", { todoId: foreign.id })).rejects.toThrow(
    "not found",
  );
  const created = await call("human_todo_create", {
    title: "Action",
    requestId: "create",
    dedupeKey: "blocker",
  });
  expect(created.todo.creator).toEqual({
    kind: "agent",
    agentId: agent.id,
    runId: run.id,
  });
  expect(
    (
      await call("human_todo_create", {
        title: "Action",
        requestId: "create",
        dedupeKey: "blocker",
      })
    ).todo.id,
  ).toBe(created.todo.id);
  await expect(
    call("human_todo_update", {
      todoId: created.todo.id,
      expectedRevision: 1,
      requestId: "done",
      status: "done",
    }),
  ).rejects.toThrow("evidence");
  await call("human_todo_update", {
    todoId: created.todo.id,
    expectedRevision: 1,
    requestId: "done",
    status: "done",
    resolutionNote: "User explicitly confirmed completion",
  });
  expect(todos.waiting()).toHaveLength(0);
  const summary = todos.summary(agent.id);
  expect(summary).toContain("contextual data");
  expect(summary).not.toContain("Updated instructions");
  active = false;
  await expect(call("human_todo_list", {})).rejects.toThrow("no longer active");
  active = true;
  const abort = new AbortController();
  abort.abort();
  await expect(call("human_todo_list", {}, abort.signal)).rejects.toThrow();
});
