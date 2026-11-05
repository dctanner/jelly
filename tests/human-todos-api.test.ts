import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/server/app";
import { unavailableClaudeStatus } from "./fixtures/claude-code";
import { controlHeaders } from "./fixtures/control-session";
const cleanup: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-todo-api-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startApp({
    dataDir: dir,
    authPath: join(dir, "auth.json"),
    configDir: join(dir, "config"),
    port: 0,
    claudeStatusCheck: unavailableClaudeStatus,
    desktopOptions: { cliPath: null },
  });
  cleanup.push(() => app.close());
  const origin = app.server.url.origin,
    headers = await controlHeaders(origin);
  const request = (
    path: string,
    input?: unknown,
    method = "POST",
    extra = {},
  ) =>
    fetch(origin + path, {
      method: input === undefined ? "GET" : method,
      headers: { ...headers, "content-type": "application/json", ...extra },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
  return { ...app, origin, headers, request, agent: app.store.agents()[0]! };
}
test("authenticated CRUD works without provider; atomic Done & continue failure retains Done, stable receipts and source lookup", async () => {
  const f = await fixture();
  const created = await f.request("/api/human-todos", {
    requestId: "create",
    title: "Signed document",
    agentId: f.agent.id,
  });
  expect(created.status).toBe(201);
  let todo = (await created.json()).todo;
  expect(f.service.snapshot().humanTodoCounts?.total).toBe(1);
  const updates: string[] = [],
    off = f.service.subscribe((event) => {
      if (event.type.startsWith("human_todo")) {
        expect(f.store.db.inTransaction).toBe(false);
        updates.push(event.type);
      }
    });
  const edit = {
    requestId: "edit",
    expectedRevision: 1,
    instructions: "Use uploads",
  };
  let response = await f.request(`/api/human-todos/${todo.id}`, edit, "PATCH");
  expect(response.status).toBe(200);
  todo = (await response.json()).todo;
  expect(
    (
      await f.request(
        `/api/human-todos/${todo.id}`,
        { ...edit, requestId: "stale" },
        "PATCH",
      )
    ).status,
  ).toBe(409);
  const completion = {
    requestId: "complete",
    expectedRevision: todo.revision,
    continueAgent: true,
    resolutionNote: "Uploaded",
  };
  response = await f.request(
    `/api/human-todos/${todo.id}/complete`,
    completion,
  );
  expect(response.status).toBe(200);
  const receipt = await response.json();
  expect(receipt.todo.status).toBe("done");
  expect(
    await (
      await f.request(`/api/human-todos/${todo.id}/complete`, completion)
    ).json(),
  ).toEqual(receipt);
  const detail = await (await f.request(`/api/human-todos/${todo.id}`)).json();
  expect(detail.delivery.state).toBe("needs_retry");
  expect(detail.todo.status).toBe("done");
  expect(f.store.runs(f.agent.id)).toHaveLength(0);
  const source = await f.request(
    `/api/agents/${f.agent.id}/activity/${todo.sourceActivityId}`,
  );
  expect(source.status).toBe(200);
  expect(
    (await source.json()).events.some(
      (event: any) => event.data.todoId === todo.id,
    ),
  ).toBe(true);
  const other = f.service.createAgent({
    name: "Other",
    color: "#fff",
    instructions: "",
  });
  expect(
    (
      await f.request(
        `/api/agents/${other.id}/activity/${todo.sourceActivityId}`,
      )
    ).status,
  ).toBe(404);
  expect(updates).toContain("human_todo_continuation_changed");
  off();
});
test("cookie/CSRF/origin/body/field boundaries, private IDs and deleted tombstone cannot authorize a handoff", async () => {
  const f = await fixture(),
    path = "/api/human-todos";
  expect((await fetch(f.origin + path)).status).toBe(401);
  expect(
    (
      await fetch(f.origin + path, {
        method: "POST",
        headers: {
          cookie: f.headers.cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "Bad", requestId: "bad" }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request(path, { title: "Bad", requestId: "bad" }, "POST", {
        origin: "https://attacker.invalid",
      })
    ).status,
  ).toBe(403);
  for (const extra of [
    { actor: "agent" },
    { sourceActivityId: 1 },
    { runId: "forged" },
    { goalId: "forged" },
    { title: "x".repeat(161) },
  ])
    expect(
      (
        await f.request(path, {
          title: "Bad",
          requestId: crypto.randomUUID(),
          ...extra,
        })
      ).status,
    ).toBe(400);
  expect(
    (
      await f.request(path, {
        title: "Bad",
        requestId: "big",
        instructions: "x".repeat(70000),
      })
    ).status,
  ).toBe(413);
  const todo = (
    await (
      await f.request(path, { title: "Delete", requestId: "create" })
    ).json()
  ).todo;
  expect(
    (
      await f.request(`${path}/${todo.id}/delete`, {
        requestId: "delete",
        expectedRevision: 1,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.request(
        `${path}/${todo.id}`,
        { requestId: "after-delete", expectedRevision: 2, title: "No" },
        "PATCH",
      )
    ).status,
  ).toBe(410);
  expect(
    (
      await f.request(`${path}/not-a-todo/complete`, {
        requestId: "private",
        expectedRevision: 1,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.request(path, {
        title: "Private",
        agentId: f.agent.id,
        interventionId: "missing",
        requestId: "link",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.request(`/api/agents/${f.agent.id}/messages`, {
        requestId: "human-todo:forged",
        text: "Run",
      })
    ).status,
  ).toBe(400);
});
