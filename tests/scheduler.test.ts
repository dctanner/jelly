import { afterEach, expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./fixtures/app";
import { scheduledWake } from "../src/server/schedules";
import { useTestModel } from "./fixtures/app";

const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(delay = 1, concurrency = 2) {
  const dir = mkdtempSync(join(tmpdir(), "jelly-scheduler-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse("2026-01-01T00:00:00Z");
  const app = await startApp({
    dataDir: dir,
    authPath: join(dir, "auth.json"),
    configDir: join(dir, "config"),
    port: 0,
    fixtureDelayMs: delay,
    scheduleClock: () => now,
    schedulerOptions: { pollMs: 60000, concurrency },
  });
  cleanups.push(() => app.close());
  const { service, store } = app;
  service.scheduler.tick();
  const agent = service.createAgent({
    name: "Calendar",
    instructions: "Retain the blue lantern",
    color: "#123456",
  });
  const create = (extra: Record<string, unknown> = {}, agentId = agent.id) =>
    service.schedules.create(agentId, {
      title: "Review",
      prompt: "  Preserve exact\nuser intent  ",
      kind: "once",
      runAt: new Date(now + 60000).toISOString(),
      timezone: "Europe/London",
      requestId: crypto.randomUUID(),
      ...extra,
    });
  return {
    app,
    service,
    store,
    agent,
    create,
    now: () => now,
    advance: (ms = 60000) => (now += ms),
  };
}

test("one-off and cron run with no browser, preserving same-agent context/current settings and durable provenance", async () => {
  const f = await fixture();
  f.service.start(f.agent.id, "first", "remember blue lantern");
  await f.service.settled();
  const receipt = f.create();
  expect(f.store.runs(f.agent.id)).toHaveLength(1);
  f.service.setConfig({ agentId: f.agent.id, effort: "high" });
  const original = f.service.harness.create.bind(f.service.harness);
  let sawCommit = false;
  f.service.harness.create = async (...args) => {
    sawCommit = !f.store.db.inTransaction;
    expect(args[0].id).toBe(f.agent.id);
    expect(args[2].effort).toBe("high");
    expect(args[6]).toBeDefined();
    const occurrence = f.service.schedules.occurrences(
      f.agent.id,
      receipt.schedule.id,
    ).items[0]!;
    expect(occurrence.state).toBe("running");
    expect(f.store.run(occurrence.runId!)!.source?.occurrenceId).toBe(
      occurrence.id,
    );
    return original(...args);
  };
  f.advance();
  f.service.scheduler.tick();
  await f.service.settled();
  expect(sawCommit).toBe(true);
  let occurrence = f.service.schedules.occurrences(
    f.agent.id,
    receipt.schedule.id,
  ).items[0]!;
  expect(occurrence.state).toBe("completed");
  expect(f.service.schedules.get(f.agent.id, receipt.schedule.id).state).toBe(
    "completed",
  );
  expect(f.store.pendingMessage(occurrence.requestId)).toBeNull();
  const message = f.store
    .events()
    .find(
      (event) =>
        event.type === "message" && event.data.occurrenceId === occurrence.id,
    )!;
  expect(message.data.role).toBe("user");
  expect(message.data.taskSnapshot).toBe(receipt.schedule.prompt);
  expect(String(message.data.text).endsWith(receipt.schedule.prompt)).toBe(
    true,
  );
  const saved = f.store.db
    .query(
      "SELECT payload,source FROM messages WHERE runId=? ORDER BY id LIMIT 1",
    )
    .get(occurrence.runId!) as { payload: string; source: string };
  expect(JSON.parse(saved.payload).role).toBe("user");
  expect(JSON.parse(saved.source).occurrenceId).toBe(occurrence.id);
  expect(
    f.store
      .events()
      .some(
        (event) =>
          event.type === "message" &&
          event.data.role === "assistant" &&
          String(event.data.text).includes("2 saved user messages"),
      ),
  ).toBe(true);
  expect(
    f.store
      .historyPage(f.agent.id)
      .events.find((event) => event.id === message.id)?.data.source,
  ).toBe("schedule");
  f.service.harness.create = original;
  const cron = f.create({ kind: "cron", runAt: undefined, cron: "* * * * *" });
  f.advance();
  f.service.scheduler.tick();
  await f.service.settled();
  occurrence = f.service.schedules.occurrences(f.agent.id, cron.schedule.id)
    .items[0]!;
  expect(occurrence.state).toBe("completed");
  f.service.scheduler.tick();
  await f.service.settled();
  expect(f.store.runs(f.agent.id)).toHaveLength(3);
});
test("busy agents wait without steering; interactive queue wins; later overlap ticks are skipped", async () => {
  const f = await fixture(80);
  const receipt = f.create({
    kind: "cron",
    runAt: undefined,
    cron: "* * * * *",
  });
  f.service.start(f.agent.id, "manual-1", "first manual");
  f.service.start(f.agent.id, "manual-2", "queued manual");
  f.advance();
  f.service.scheduler.tick();
  expect(
    f.service.schedules.occurrences(f.agent.id, receipt.schedule.id).items[0]!
      .state,
  ).toBe("pending");
  f.advance();
  f.service.scheduler.tick();
  expect(
    f.service.schedules.occurrences(f.agent.id, receipt.schedule.id).items[0]!
      .state,
  ).toBe("skipped");
  await f.service.settled();
  f.service.scheduler.tick();
  await f.service.settled();
  const messages = f.store
    .events()
    .filter((e) => e.type === "message" && e.data.role === "user");
  expect(messages.map((e) => e.data.text).slice(0, 2)).toEqual([
    "first manual",
    "queued manual",
  ]);
  expect(messages[2]!.data.source).toBe("schedule");
  expect(messages[2]!.data.delayReasons).toContain("busy");
  expect(messages[2]!.data.wakeReason).toContain("agent was busy");
  expect(f.store.pendingMessage("manual-2")!.status).toBe("delivered");
});
test("scheduled concurrency includes child settlement; due order is fair across agents", async () => {
  const f = await fixture(1, 2);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  cleanups.push(() => release());
  const settle = f.service.harness.settle.bind(f.service.harness);
  f.service.harness.settle = async (session) => {
    await settle(session);
    await gate;
  };
  const agents = [
    f.agent,
    ...["Second", "Third"].map((name) =>
      f.service.createAgent({ name, instructions: "", color: "#123456" }),
    ),
  ];
  const receipts = agents.map((agent) => f.create({}, agent.id));
  f.advance();
  f.service.scheduler.tick();
  expect(
    f.store.db
      .query(
        "SELECT count(*) AS n FROM schedule_occurrences WHERE state='running'",
      )
      .get(),
  ).toEqual({ n: 2 });
  await Bun.sleep(80);
  f.service.scheduler.tick();
  expect(
    f.store.db
      .query("SELECT count(*) AS n FROM runs WHERE status='running'")
      .get(),
  ).toEqual({ n: 2 });
  expect(
    receipts
      .flatMap(
        (r) =>
          f.service.schedules.occurrences(r.schedule.agentId, r.schedule.id)
            .items,
      )
      .filter((o) => o.state === "pending"),
  ).toHaveLength(1);
  release();
  await f.service.settled();
  f.service.scheduler.tick();
  await f.service.settled();
  expect(
    receipts.every(
      (r) =>
        f.service.schedules.occurrences(r.schedule.agentId, r.schedule.id)
          .items[0]!.state === "completed",
    ),
  ).toBe(true);
});
test("pre-admission failure rolls back every write; retries only safe delivery; provider recovery is bounded", async () => {
  const f = await fixture();
  const receipt = f.create();
  const save = f.store.saveMessage.bind(f.store);
  f.store.saveMessage = () => {
    throw new Error("injected before commit");
  };
  let creates = 0;
  const create = f.service.harness.create.bind(f.service.harness);
  f.service.harness.create = async (...args) => {
    creates++;
    return create(...args);
  };
  f.advance();
  f.service.scheduler.tick();
  expect(f.store.runs(f.agent.id)).toHaveLength(0);
  expect(creates).toBe(0);
  let occurrence = f.service.schedules.occurrences(
    f.agent.id,
    receipt.schedule.id,
  ).items[0]!;
  expect(occurrence.state).toBe("pending");
  expect(occurrence.attempts).toBe(1);
  f.service.scheduler.tick();
  expect(f.service.schedules.occurrence(occurrence.id)!.attempts).toBe(1);
  f.store.saveMessage = save;
  f.advance(30_000);
  f.service.scheduler.tick();
  await f.service.settled();
  occurrence = f.service.schedules.occurrence(occurrence.id)!;
  expect(occurrence.state).toBe("completed");
  expect(creates).toBe(1);
  const unavailable = f.create();
  const requireConnection = f.service.harness.requireConnection.bind(
    f.service.harness,
  );
  f.service.harness.requireConnection = () => {
    throw new Error("Connect provider in Settings");
  };
  f.advance();
  f.service.scheduler.tick();
  occurrence = f.service.schedules.occurrences(
    f.agent.id,
    unavailable.schedule.id,
  ).items[0]!;
  expect(occurrence.runId).toBeNull();
  expect(
    f.store
      .events()
      .filter(
        (e) =>
          e.type === "schedule_blocked" &&
          e.data.scheduleId === unavailable.schedule.id,
      ),
  ).toHaveLength(1);
  f.service.harness.requireConnection = requireConnection;
  f.advance(30_000);
  f.service.scheduler.tick();
  await f.service.settled();
  expect(f.service.schedules.occurrence(occurrence.id)!.state).toBe(
    "completed",
  );
});
test("accepted provider failure is terminal and never automatically replayed", async () => {
  const f = await fixture();
  useTestModel(f.service.harness, { fixtureFail: true });
  const receipt = f.create();
  f.advance();
  f.service.scheduler.tick();
  await f.service.settled();
  const occurrence = f.service.schedules.occurrences(
    f.agent.id,
    receipt.schedule.id,
  ).items[0]!;
  expect(occurrence.state).toBe("failed");
  expect(f.service.schedules.get(f.agent.id, receipt.schedule.id).state).toBe(
    "completed",
  );
  f.advance();
  f.service.scheduler.tick();
  await f.service.settled();
  expect(f.store.runs(f.agent.id)).toHaveLength(1);
});
test("pause/edit while running preserves snapshot, cancellation reports admitted run, Stop does not immediately restart", async () => {
  const f = await fixture(80);
  const receipt = f.create({
    kind: "cron",
    runAt: undefined,
    cron: "* * * * *",
  });
  f.advance();
  f.service.scheduler.tick();
  const occurrence = f.service.schedules.occurrences(
    f.agent.id,
    receipt.schedule.id,
  ).items[0]!;
  const changed = f.service.schedules.change(
    f.agent.id,
    receipt.schedule.id,
    "update",
    { requestId: "edit", expectedRevision: 1, prompt: "new future task" },
  );
  expect(changed.runningRunId).toBe(occurrence.runId);
  expect(f.service.schedules.occurrence(occurrence.id)!.snapshot.prompt).toBe(
    receipt.schedule.prompt,
  );
  const extra = f.create();
  f.advance();
  f.service.scheduler.tick();
  await f.service.stop(f.agent.id);
  f.service.scheduler.tick();
  await f.service.settled();
  expect(f.service.schedules.occurrence(occurrence.id)!.state).toBe(
    "cancelled",
  );
  expect(
    f.service.schedules.occurrences(f.agent.id, extra.schedule.id).items[0]!
      .state,
  ).toBe("cancelled");
  expect(f.store.runs(f.agent.id)).toHaveLength(1);
  expect(f.service.schedules.get(f.agent.id, receipt.schedule.id).state).toBe(
    "active",
  );
  f.advance();
  f.service.scheduler.tick();
  await f.service.settled();
  expect(f.store.runs(f.agent.id)).toHaveLength(2);
});
test("archive pauses atomically, restore and Fresh Session do not resume or duplicate schedules", async () => {
  const f = await fixture();
  const receipt = f.create();
  f.advance();
  f.service.schedules.due(f.now(), null, 100);
  f.service.archiveAgent(f.agent.id, true);
  expect(f.service.schedules.get(f.agent.id, receipt.schedule.id).state).toBe(
    "paused",
  );
  expect(
    f.service.schedules.occurrences(f.agent.id, receipt.schedule.id).items[0]!
      .state,
  ).toBe("cancelled");
  f.service.archiveAgent(f.agent.id, false);
  f.service.scheduler.tick();
  expect(f.store.runs(f.agent.id)).toHaveLength(0);
  f.service.start(f.agent.id, "ordinary", "ordinary work");
  await f.service.settled();
  f.service.freshSession(f.agent.id, "fresh");
  await f.service.settled();
  expect(f.service.schedules.get(f.agent.id, receipt.schedule.id).state).toBe(
    "paused",
  );
});
test("crash after committed admission, even before first token, recovers interrupted without replay", async () => {
  const f = await fixture();
  const receipt = f.create();
  f.advance();
  f.service.schedules.due(f.now(), null, 100);
  const occurrence = f.service.schedules.pending(100)[0]!;
  const wake = scheduledWake(occurrence, new Date(f.now()).toISOString());
  const run = f.store.db.transaction(() => {
    const run = f.store.createRun(
      f.agent.id,
      occurrence.requestId,
      wake.text,
      "api",
      f.agent.model,
    );
    f.store.saveMessage(
      f.agent.id,
      run.id,
      { role: "user", content: wake.text, timestamp: f.now() },
      wake.source,
    );
    f.service.schedules.admit(occurrence.id, run.id, wake.source);
    return run;
  })();
  expect(() =>
    f.store.db.transaction(() => {
      f.store.finishRun(run.id, "completed", null);
      throw new Error("crash during finalization");
    })(),
  ).toThrow();
  expect(f.service.schedules.occurrence(occurrence.id)!.state).toBe("running");
  f.store.recover();
  f.service.schedules.recover();
  f.service.scheduler.tick();
  expect(f.service.schedules.occurrence(occurrence.id)!.state).toBe(
    "interrupted",
  );
  expect(f.store.runs(f.agent.id)).toHaveLength(1);
  expect(f.service.schedules.get(f.agent.id, receipt.schedule.id).state).toBe(
    "completed",
  );
});
test("busy and provider-blocked waiting expire at the same deadline", async () => {
  const f = await fixture(80, 1);
  const first = f.create({ maxLatenessSeconds: 60 });
  f.service.start(f.agent.id, "busy", "busy manual");
  f.advance();
  f.service.scheduler.tick();
  f.advance(61000);
  f.service.scheduler.tick();
  expect(
    f.service.schedules.occurrences(f.agent.id, first.schedule.id).items[0]!
      .state,
  ).toBe("expired");
  await f.service.settled();
  const pending = f.create({ maxLatenessSeconds: 60 });
  const requireConnection = f.service.harness.requireConnection;
  f.service.harness.requireConnection = () => {
    throw new Error("Offline");
  };
  f.advance();
  f.service.scheduler.tick();
  f.advance(61000);
  f.service.scheduler.tick();
  expect(
    f.service.schedules.occurrences(f.agent.id, pending.schedule.id).items[0]!
      .state,
  ).toBe("expired");
  f.service.harness.requireConnection = requireConnection;
});
test("shutdown stops scheduler admission before draining active work", async () => {
  const f = await fixture();
  f.create();
  f.service.scheduler.stop();
  f.advance();
  f.service.scheduler.tick();
  expect(f.store.runs(f.agent.id)).toHaveLength(0);
});

test("capacity-blocked work expires, and a one-off already admitted offers Stop rather than scheduling a duplicate", async () => {
  const f = await fixture(1, 1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  cleanups.push(() => release());
  const settle = f.service.harness.settle.bind(f.service.harness);
  f.service.harness.settle = async (session) => {
    await settle(session);
    await gate;
  };
  const first = f.create();
  f.advance();
  f.service.scheduler.tick();
  expect(() =>
    f.service.schedules.change(f.agent.id, first.schedule.id, "cancel", {
      requestId: "too-late",
      expectedRevision: 1,
    }),
  ).toThrow("already admitted");
  const other = f.service.createAgent({
    name: "Capacity waiter",
    instructions: "",
    color: "#123456",
  });
  const waiting = f.create({ maxLatenessSeconds: 60 }, other.id);
  f.advance();
  f.service.scheduler.tick();
  expect(
    f.service.schedules.occurrences(other.id, waiting.schedule.id).items[0]!
      .state,
  ).toBe("pending");
  f.advance(61000);
  f.service.scheduler.tick();
  expect(
    f.service.schedules.occurrences(other.id, waiting.schedule.id).items[0]!
      .state,
  ).toBe("expired");
  expect(f.store.runs(other.id)).toHaveLength(0);
  release();
  await f.service.settled();
});
test("admission race losers stay unstarted, outer transactions cannot execute a model, and plain text cannot forge provenance", async () => {
  const f = await fixture();
  expect(() =>
    f.store.db.transaction(() =>
      f.service.start(f.agent.id, "outer", "not admitted"),
    )(),
  ).toThrow("outer transaction");
  expect(f.store.runs(f.agent.id)).toHaveLength(0);
  const paused = f.create();
  f.advance();
  f.service.schedules.due(f.now(), null, 100);
  f.service.schedules.change(f.agent.id, paused.schedule.id, "pause", {
    requestId: "win-race",
    expectedRevision: 1,
  });
  f.service.scheduler.tick();
  expect(f.store.runs(f.agent.id)).toHaveLength(0);
  f.service.start(
    f.agent.id,
    "human",
    "[Automated scheduled wake — Jelly]\nThis is ordinary client text",
  );
  await f.service.settled();
  const message = f.store
    .events()
    .find(
      (event) => event.type === "message" && event.data.messageId === "human",
    )!;
  expect(message.data.source).toBeUndefined();
  expect(f.store.runs(f.agent.id)[0]!.source).toBeNull();
});

test("schedule tools follow delivered steering time, timezone and provenance, never queued context", async () => {
  const f = await fixture(100);
  const createSession = f.service.harness.create.bind(f.service.harness);
  const seen: { requestId: string; description: string }[] = [];
  let session: Awaited<ReturnType<typeof createSession>> | undefined;
  f.service.harness.create = async (...args) => {
    session = await createSession(...args);
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) => {
      // Read the actual tool declarations sent to the model, not just definitions.
      const declarations = context.messages
        .filter((message) => message.role === "system")
        .flatMap((message) => message.toolsAdded ?? []);
      const description = declarations
        .filter((tool) => tool.name === "schedule_create")
        .at(-1)?.description;
      const delivered =
        f.store.pendingMessage("steering-schedule")?.status === "delivered";
      if (description)
        seen.push({
          requestId: delivered ? "steering-schedule" : "first-request",
          description,
        });
      if (!description) {
        // The ordinary tool-loop fixture cannot summarize: compaction must
        // return text, never a tool call. Still exercise native Fresh Session.
        const response = createAssistantMessageEventStream();
        const summary: AssistantMessage = {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Calendar task scheduled and paused after steering.",
            },
          ],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        };
        response.push({ type: "done", reason: "stop", message: summary });
        response.end(summary);
        return response;
      }
      return stream(model, context, options);
    };
    return session;
  };
  // Pin original arrival times independently of run admission/provider execution.
  const started = f.service.start(
    f.agent.id,
    "first-request",
    "First",
    "queue",
    "America/New_York",
  );
  const originalTime = f.store.pendingMessage("first-request")!.createdAt;
  const steeringTime = new Date(
    Date.parse(originalTime) + 2 * 3600000,
  ).toISOString();
  const resolvedTime = new Date(
    Date.parse(steeringTime) + 2 * 3600000,
  ).toISOString();
  for (let n = 0; !seen.length && n < 200; n++) await Bun.sleep(5);
  expect(seen.length).toBeGreaterThan(0);
  f.store.enqueueMessage(
    "steering-schedule",
    f.agent.id,
    "In two hours, review",
    "queue",
    "Asia/Tokyo",
  );
  f.store.db
    .query("UPDATE pending_messages SET createdAt=? WHERE id=?")
    .run(steeringTime, "steering-schedule");
  f.service.schedules.saveTimezone(f.agent.id, "Asia/Tokyo");
  const nativeTool = session!.agent.state.tools.find(
    (tool) => tool.name === "schedule_create",
  )!;
  const definitions = () =>
    session!.agent.state.tools
      .filter((tool) => tool.name.startsWith("schedule_"))
      .map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }));
  const initialDefinitions = structuredClone(definitions());
  const readContext = async () => {
    const result = await session!.agent.state.tools
      .find((tool) => tool.name === "schedule_list")!
      .execute("context", {});
    return JSON.parse((result.content[0] as { text: string }).text)
      .requestContext;
  };
  expect(await readContext()).toMatchObject({
    requestId: "first-request",
    receivedAt: originalTime,
    suggestedTimezone: "America/New_York",
  });
  expect(nativeTool.description).toContain(
    "Call schedule_list for fresh server-owned requestContext",
  );
  f.service.steer(f.agent.id, "steering-schedule");
  for (
    let n = 0;
    !seen.some((item) => item.requestId === "steering-schedule") && n < 200;
    n++
  )
    await Bun.sleep(5);
  const delivered = seen.find(
    (item) => item.requestId === "steering-schedule",
  )!;
  expect(delivered).toBeDefined();
  expect(delivered.description).toBe(seen[0]!.description);
  expect(await readContext()).toMatchObject({
    requestId: "steering-schedule",
    receivedAt: steeringTime,
    suggestedTimezone: "Asia/Tokyo",
  });
  expect(definitions()).toEqual(initialDefinitions);
  const created = await nativeTool.execute("schedule-from-steering", {
    title: "Review",
    prompt: "Review in two hours",
    kind: "once",
    runAt: resolvedTime,
    timezone: "Asia/Tokyo",
    requestId: "create-from-steer",
    originalRequestId: "spoofed-origin",
  });
  const receipt = JSON.parse((created.content[0] as { text: string }).text);
  expect(receipt.schedule.originalRequestId).toBe("steering-schedule");
  expect(receipt.schedule.createdByRunId).toBe(started.run!.id);
  expect(receipt.schedule.runAt).toBe(resolvedTime);
  await session!.agent.state.tools
    .find((tool) => tool.name === "schedule_pause")!
    .execute("pause", {
      scheduleId: receipt.schedule.id,
      expectedRevision: 1,
      requestId: "pause-from-steer",
      originalRequestId: "spoofed-origin",
    });
  expect(
    f.store.db
      .query(
        "SELECT requestId,originalRequestId,runId FROM schedule_mutations ORDER BY requestId",
      )
      .all(),
  ).toEqual(
    ["create-from-steer", "pause-from-steer"].map((requestId) => ({
      requestId,
      originalRequestId: "steering-schedule",
      runId: started.run!.id,
    })),
  );
  await f.service.settled();
  expect(f.store.runs(f.agent.id)).toHaveLength(1);
  f.service.freshSession(f.agent.id, "fresh-after-steering");
  await f.service.settled();
  expect(f.store.runs(f.agent.id).at(-1)?.error).toBeNull();
  expect(f.store.runs(f.agent.id).at(-1)?.status).toBe("completed");
  expect(definitions()).toEqual(initialDefinitions);
  f.service.start(
    f.agent.id,
    "another-request",
    "Continue",
    "queue",
    "Europe/London",
  );
  await f.service.settled();
  expect(f.store.runs(f.agent.id).at(-1)?.status).toBe("completed");
  expect(definitions()).toEqual(initialDefinitions);
});
