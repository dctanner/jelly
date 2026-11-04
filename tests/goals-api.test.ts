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
  const dir = mkdtempSync(join(tmpdir(), "jelly-goals-api-"));
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
    headers = await controlHeaders(origin),
    agent = app.store.agents()[0]!;
  const path = `/api/agents/${agent.id}/goal`;
  const request = (path: string, input?: unknown, extra = {}) =>
    fetch(origin + path, {
      method: input === undefined ? "GET" : "POST",
      headers: { ...headers, "content-type": "application/json", ...extra },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
  return { ...app, origin, headers, agent, path, request };
}
test("goal API create/edit/pause/resume/complete/clear without credentials; replay, scoped revisions and committed SSE history", async () => {
  const f = await fixture();
  expect(await (await f.request(f.path)).json()).toEqual({
    goal: null,
    runningRunId: null,
  });
  const create = {
    objective: "API fixture objective",
    requestId: "create",
  };
  let goal = (await (await f.request(f.path + "/create", create)).json()).goal;
  expect(goal.state).toBe("paused");
  expect(
    (await (await f.request(f.path + "/create", create)).json()).goal.id,
  ).toBe(goal.id);
  expect(
    (await f.request(f.path + "/create", { ...create, objective: "changed" }))
      .status,
  ).toBe(409);
  const events: string[] = [];
  const off = f.service.subscribe((e) => {
    if (e.type === "goal_changed") {
      expect(f.store.db.inTransaction).toBe(false);
      expect(f.service.goals.get(f.agent.id)?.revision).toBe(
        Number(e.data.revision),
      );
      events.push(e.type);
    }
  });
  for (const action of ["edit", "resume", "pause", "complete"] as const) {
    const response = await f.request(`${f.path}/${action}`, {
      goalId: goal.id,
      expectedRevision: goal.revision,
      requestId: action,
      ...(action === "edit" ? { objective: "Edited fixture" } : {}),
      ...(action === "complete"
        ? { summary: "Operator verified fixture evidence" }
        : {}),
    });
    expect(response.status).toBe(200);
    goal = (await response.json()).goal;
    expect(goal.state).toBe(
      action === "resume"
        ? "blocked"
        : action === "complete"
          ? "completed"
          : "paused",
    );
  }
  off();
  expect(events.length).toBeGreaterThanOrEqual(4);
  expect(f.store.runs(f.agent.id)).toHaveLength(0);
  expect(
    f.store
      .historyPage(f.agent.id)
      .events.some(
        (e) => e.type === "goal_changed" && e.data.state === "completed",
      ),
  ).toBe(true);
  const clear = {
    goalId: goal.id,
    expectedRevision: goal.revision,
    requestId: "clear",
  };
  expect(
    (await (await f.request(f.path + "/clear", clear)).json()).goal,
  ).toBeNull();
  expect((await f.request(f.path + "/clear", clear)).status).toBe(200);
});
test("goal endpoints share cookie/CSRF/origin boundary and reject forged ownership/usage, wrong scope and oversize input", async () => {
  const f = await fixture();
  const input = { objective: "Fixture", requestId: "create" };
  expect((await fetch(f.origin + f.path)).status).toBe(401);
  expect(
    (
      await fetch(f.origin + f.path + "/create", {
        method: "POST",
        headers: {
          cookie: f.headers.cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request(f.path + "/create", input, {
        origin: "https://attacker.invalid",
      })
    ).status,
  ).toBe(403);
  for (const extra of [
    { agentId: "forged" },
    { tokensUsed: 0 },
    { runId: "forged" },
    { state: "active" },
    { objective: "x".repeat(16001) },
    { tokenBudget: 100 },
    { compactions: 0 },
    { compactionLimit: 200 },
  ])
    expect(
      (await f.request(f.path + "/create", { ...input, ...extra })).status,
    ).toBe(400);
  const goal = (await (await f.request(f.path + "/create", input)).json()).goal;
  const other = f.service.createAgent({
    name: "Other",
    instructions: "",
    color: "#123456",
  });
  expect(
    (
      await f.request(`/api/agents/${other.id}/goal/pause`, {
        goalId: goal.id,
        expectedRevision: goal.revision,
        requestId: "foreign",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.request(f.path + "/pause", {
        goalId: goal.id,
        expectedRevision: 0,
        requestId: "stale",
      })
    ).status,
  ).toBe(409);
  expect((await f.request("/api/agents/missing/goal")).status).toBe(404);
});
