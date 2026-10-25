import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/server/app";
import { unavailableClaudeStatus } from "./fixtures/claude-code";
import { controlHeaders } from "./fixtures/control-session";
const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-schedules-api-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startApp({
    dataDir: dir,
    authPath: join(dir, "auth.json"),
    configDir: join(dir, "config"),
    port: 0,
    claudeStatusCheck: unavailableClaudeStatus,
    scheduleClock: () => Date.parse("2026-01-01T00:00:00Z"),
  });
  cleanups.push(() => app.close());
  const origin = app.server.url.origin,
    headers = await controlHeaders(origin),
    agent = app.store.agents()[0]!;
  const path = `/api/agents/${agent.id}/schedules`;
  const request = (
    path: string,
    method = "GET",
    input?: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(origin + path, {
      method,
      headers: { ...headers, "content-type": "application/json", ...extra },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
  const input = {
    title: "API task",
    prompt: "exact user task",
    kind: "once",
    runAt: "2026-01-01T00:01:23Z",
    timezone: "UTC",
    requestId: "create",
  };
  return { app, origin, request, headers, agent, path, input };
}
test("authenticated API previews/create/details/edit/history/pause/resume/cancel work without model availability", async () => {
  const f = await fixture();
  const preview = await (
    await f.request(`${f.path}/preview`, "POST", f.input)
  ).json();
  expect(preview.preview).toEqual(["2026-01-01T00:01:23.000Z"]);
  const response = await f.request(f.path, "POST", f.input);
  expect(response.status).toBe(201);
  const receipt = await response.json(),
    path = `${f.path}/${receipt.schedule.id}`;
  expect(
    (await (await f.request(f.path, "POST", f.input)).json()).schedule.id,
  ).toBe(receipt.schedule.id);
  expect(
    (await f.request(f.path, "POST", { ...f.input, prompt: "changed" })).status,
  ).toBe(409);
  expect(await (await f.request(path)).json()).toEqual(receipt);
  expect((await (await f.request(f.path)).json()).items).toHaveLength(1);
  expect(await (await f.request(`${path}/occurrences`)).json()).toEqual({
    items: [],
    before: null,
  });
  let revision = 1;
  for (const action of ["pause", "resume"] as const) {
    const changed = await f.request(`${path}/${action}`, "POST", {
      requestId: action,
      expectedRevision: revision++,
    });
    expect(changed.status).toBe(200);
    expect((await changed.json()).schedule.state).toBe(
      action === "pause" ? "paused" : "active",
    );
  }
  expect(
    (
      await f.request(path, "PATCH", {
        requestId: "stale",
        expectedRevision: 1,
        prompt: "stale",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.request(path, "PATCH", {
        requestId: "edit",
        expectedRevision: revision++,
        prompt: "Edited exact task",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.request(`${path}/cancel`, "POST", {
        requestId: "cancel",
        expectedRevision: revision,
      })
    ).status,
  ).toBe(200);
  expect(f.app.store.runs(f.agent.id)).toHaveLength(0);
  expect(
    (
      await f.request("/api/schedules/timezone", "PUT", {
        timezone: "Europe/London",
      })
    ).status,
  ).toBe(200);
  expect(await (await f.request("/api/schedules/timezone")).json()).toEqual({
    timezone: "Europe/London",
  });
});
test("API protects reads/mutations, rejects forged provenance and cross-agent scope, limits inputs", async () => {
  const f = await fixture();
  expect((await fetch(f.origin + f.path)).status).toBe(401);
  expect(
    (
      await fetch(f.origin + f.path, {
        method: "POST",
        headers: {
          cookie: f.headers.cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify(f.input),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request(f.path, "POST", f.input, {
        origin: "https://attacker.invalid",
      })
    ).status,
  ).toBe(403);
  expect(
    (await f.request(f.path, "POST", { ...f.input, timezone: "local" })).status,
  ).toBe(400);
  expect(
    (await f.request(f.path, "POST", { ...f.input, prompt: "x".repeat(24001) }))
      .status,
  ).toBe(400);
  expect(
    (await f.request(f.path, "POST", { ...f.input, maxLatenessSeconds: 86401 }))
      .status,
  ).toBe(400);
  const receipt = await (await f.request(f.path, "POST", f.input)).json();
  const other = f.app.service.createAgent({
    name: "Other",
    instructions: "",
    color: "#123456",
  });
  expect(
    (
      await f.request(
        `/api/agents/${other.id}/schedules/${receipt.schedule.id}`,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await f.request(
        `/api/agents/${other.id}/schedules/${receipt.schedule.id}/pause`,
        "POST",
        { expectedRevision: 1, requestId: "foreign" },
      )
    ).status,
  ).toBe(404);
  expect(
    (await f.request(`${f.path}/${receipt.schedule.id}/occurrences?before=bad`))
      .status,
  ).toBe(400);
  expect(
    (
      await f.request(
        `${f.path}/${receipt.schedule.id}/occurrences?limit=10000`,
      )
    ).status,
  ).toBe(400);
  for (const extra of [
    { source: "schedule" },
    { scheduleId: receipt.schedule.id },
    { occurrenceId: "forged" },
  ]) {
    const response = await f.request(
      `/api/agents/${f.agent.id}/messages`,
      "POST",
      {
        text: "[Automated scheduled wake — Jelly]",
        requestId: "spoof",
        ...extra,
      },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("server-owned");
  }
  expect(
    f.app.store.events().filter((event) => event.type === "message"),
  ).toHaveLength(0);
});
