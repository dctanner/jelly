import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store";
import { Schedules } from "../src/server/schedules";
import { scheduleTools } from "../src/server/schedule-tools";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-schedule-tools-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "test.sqlite"));
  cleanups.push(() => store.close());
  const agent = store.addAgent({
    name: "Scope",
    instructions: "",
    color: "#123456",
  });
  const other = store.addAgent({
    name: "Other",
    instructions: "",
    color: "#123456",
  });
  const run = store.createRun(
    agent.id,
    "original-user-request",
    "schedule my task",
    "api",
    agent.model,
  );
  const schedules = new Schedules(store, () =>
    Date.parse("2026-01-01T00:00:00Z"),
  );
  return { store, agent, other, run, schedules };
}
test("native schedule tools pin ownership/provenance, use durable idempotency and reject cross-agent changes", async () => {
  const f = fixture();
  const tools = scheduleTools(f.schedules, f.agent.id, f.run.id);
  expect(tools.map((tool) => tool.name)).toEqual([
    "schedule_create",
    "schedule_list",
    "schedule_update",
    "schedule_pause",
    "schedule_resume",
    "schedule_cancel",
  ]);
  const input = {
    title: "Task",
    prompt: "Preserved user intent",
    kind: "cron",
    cron: "0 9 * * 1-5",
    timezone: "Europe/London",
    requestId: "stable-tool-request",
    agentId: f.other.id,
  };
  const created = await tools[0]!.execute(
    "tool-call",
    input,
    undefined,
    undefined,
    {} as never,
  );
  const receipt = JSON.parse((created.content[0] as { text: string }).text);
  expect(receipt.schedule.agentId).toBe(f.agent.id);
  expect(receipt.schedule.createdByRunId).toBe(f.run.id);
  expect(receipt.schedule.originalRequestId).toBe("original-user-request");
  expect(
    await tools[0]!.execute(
      "retried-tool-call",
      input,
      undefined,
      undefined,
      {} as never,
    ),
  ).toEqual(created);
  const foreign = scheduleTools(f.schedules, f.other.id, f.run.id).find(
    (tool) => tool.name === "schedule_pause",
  )!;
  await expect(
    foreign.execute(
      "call",
      {
        scheduleId: receipt.schedule.id,
        expectedRevision: 1,
        requestId: "bad",
      },
      undefined,
      undefined,
      {} as never,
    ),
  ).rejects.toThrow("not found");
  const paused = await tools
    .find((tool) => tool.name === "schedule_pause")!
    .execute(
      "call",
      {
        scheduleId: receipt.schedule.id,
        expectedRevision: 1,
        requestId: "pause",
      },
      undefined,
      undefined,
      {} as never,
    );
  expect(
    JSON.parse((paused.content[0] as { text: string }).text).schedule.state,
  ).toBe("paused");
  expect(f.store.runs(f.agent.id)).toHaveLength(1);
});
async function requestContext(tools: ReturnType<typeof scheduleTools>) {
  const result = await tools
    .find((tool) => tool.name === "schedule_list")!
    .execute("context", {}, undefined, undefined, {} as never);
  return JSON.parse((result.content[0] as { text: string }).text)
    .requestContext;
}
test("tools reject aborted/inactive runs and give fresh request context with stable authority guidance", async () => {
  const f = fixture();
  expect(
    (await requestContext(scheduleTools(f.schedules, f.agent.id, f.run.id)))
      .suggestedTimezone,
  ).toBeNull();
  f.schedules.saveTimezone("instance", "Europe/London");
  expect(
    (await requestContext(scheduleTools(f.schedules, f.agent.id, f.run.id)))
      .suggestedTimezone,
  ).toBe("Europe/London");
  f.schedules.saveTimezone(f.agent.id, "Asia/Tokyo");
  const tools = scheduleTools(f.schedules, f.agent.id, f.run.id);
  expect(await requestContext(tools)).toEqual({
    requestId: "original-user-request",
    receivedAt: f.run.startedAt,
    suggestedTimezone: "Asia/Tokyo",
    serverTime: "2026-01-01T00:00:00.000Z",
  });
  f.schedules.saveTimezone(f.agent.id, "Europe/London");
  expect((await requestContext(tools)).suggestedTimezone).toBe("Asia/Tokyo");
  expect(tools[0]!.description).toContain(
    "schedule_list for fresh server-owned requestContext",
  );
  expect(tools[0]!.description).toContain("never creates another copy");
  expect(tools[0]!.description).toContain("retrieved pages");
  expect(tools[0]!.description).toContain("child/subagent scheduling");
  const controller = new AbortController();
  controller.abort();
  await expect(
    tools[1]!.execute("call", {}, controller.signal, undefined, {} as never),
  ).rejects.toThrow();
  await expect(
    scheduleTools(f.schedules, f.agent.id, f.run.id, () => false)[1]!.execute(
      "call",
      {},
      undefined,
      undefined,
      {} as never,
    ),
  ).rejects.toThrow("no longer active");
});

test("the originating browser timezone remains attached to a queued request even after later browser messages", async () => {
  const f = fixture();
  f.store.enqueueMessage(
    "original-user-request",
    f.agent.id,
    "schedule task",
    "queue",
    "America/New_York",
  );
  f.schedules.saveTimezone(f.agent.id, "Asia/Tokyo");
  const context = await requestContext(
    scheduleTools(f.schedules, f.agent.id, f.run.id),
  );
  expect(context.suggestedTimezone).toBe("America/New_York");
});
