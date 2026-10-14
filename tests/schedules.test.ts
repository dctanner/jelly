import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startApp } from "./fixtures/app";
import { Store } from "../src/server/store";
import {
  nextCron,
  parseCron,
  Schedules,
  suggestionFromModel,
} from "../src/server/schedules";
import type { ScheduleRecord } from "../src/shared/types";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-schedules-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300 && !predicate(); i++) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}
const next = (expression: string, after: Date) =>
  nextCron(parseCron(expression), after);

test("cron parser follows five-field local-time POSIX semantics", () => {
  const at = new Date(2026, 9, 13, 10, 7, 30); // Tue 13 Oct 2026 10:07:30 local
  expect(next("*/15 * * * *", at)).toEqual(new Date(2026, 9, 13, 10, 15));
  expect(next("0 9 * * 1-5", at)).toEqual(new Date(2026, 9, 14, 9, 0));
  expect(next("0 9 * * MON", at)).toEqual(new Date(2026, 9, 19, 9, 0));
  expect(next("30 8 1 jan *", at)).toEqual(new Date(2027, 0, 1, 8, 30));
  expect(next("@daily", at)).toEqual(new Date(2026, 9, 14, 0, 0));
  expect(next("@hourly", at)).toEqual(new Date(2026, 9, 13, 11, 0));
  expect(next("0 0 * * 7", at)).toEqual(new Date(2026, 9, 18, 0, 0)); // 7 is Sunday
  expect(next("5/20 * * * *", at)).toEqual(new Date(2026, 9, 13, 10, 25));
  // Restricted day-of-month and day-of-week match either (Fri 16th before the 20th).
  expect(next("0 0 20 * fri", at)).toEqual(new Date(2026, 9, 16, 0, 0));
  // Strictly after: an exact match does not repeat the same minute.
  expect(next("7 10 * * *", new Date(2026, 9, 13, 10, 7))).toEqual(
    new Date(2026, 9, 14, 10, 7),
  );
  expect(next("0 0 30 2 *", at)).toBeNull();
  for (const bad of [
    "",
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "*/0 * * * *",
    "5-1 * * * *",
    "x * * * *",
    "1/2/3 * * * *",
  ])
    expect(() => parseCron(bad)).toThrow();
});

test("due schedules send once, skip missed times on start, queue at most one copy and ignore archived agents", () => {
  const dir = temp();
  const store = new Store(join(dir, "jelly.sqlite"), join(dir, "workspaces"));
  cleanups.push(() => store.close());
  const agent = store.addAgent({
    name: "Scout",
    instructions: "",
    color: "#b5bafc",
  });
  let now = new Date(2026, 9, 13, 8, 59, 50);
  const sent: string[] = [];
  const schedules = new Schedules(
    store.db,
    (agentId, requestId, prompt) => {
      if (prompt === "fail") throw new Error("No model connection.");
      sent.push(requestId);
      store.enqueueMessage(requestId, agentId, prompt, "queue"); // a busy agent queues the message
    },
    () => now,
  );
  const daily = schedules.create(agent.id, {
    cron: "0 9 * * *",
    prompt: "Check my inbox",
  });
  expect(daily).toMatchObject({
    enabled: true,
    nextRunAt: new Date(2026, 9, 13, 9, 0).toISOString(),
    lastRunAt: null,
  });

  schedules.tick();
  expect(sent).toEqual([]);
  now = new Date(2026, 9, 13, 9, 0, 10);
  schedules.tick();
  schedules.tick();
  expect(sent).toEqual([
    `schedule:${daily.id}:${new Date(2026, 9, 13, 9, 0).toISOString()}`,
  ]);
  expect(schedules.get(daily.id)).toMatchObject({
    lastRunAt: now.toISOString(),
    lastError: null,
    nextRunAt: new Date(2026, 9, 14, 9, 0).toISOString(),
  });

  // The first copy is still queued at the next due time, so the second is skipped.
  now = new Date(2026, 9, 14, 9, 0, 5);
  schedules.tick();
  expect(sent).toHaveLength(1);
  expect(schedules.get(daily.id)!.lastError).toMatch(/still queued/);

  // Failures to start are recorded and the schedule advances.
  const failing = schedules.create(agent.id, {
    cron: "* * * * *",
    prompt: "fail",
  });
  now = new Date(2026, 9, 14, 9, 2);
  schedules.tick();
  expect(schedules.get(failing.id)).toMatchObject({
    lastError: "No model connection.",
    nextRunAt: new Date(2026, 9, 14, 9, 3).toISOString(),
  });

  // Disabled and archived schedules never send.
  schedules.update(failing.id, { enabled: false });
  store.db.query("UPDATE pending_messages SET status='delivered'").run();
  store.archiveAgent(agent.id, true);
  now = new Date(2026, 9, 20, 9, 0);
  schedules.tick();
  expect(sent).toHaveLength(1);

  // Times missed while stopped are skipped, not replayed.
  store.archiveAgent(agent.id, false);
  now = new Date(2026, 9, 21, 12, 0);
  schedules.start(60_000);
  schedules.stop();
  schedules.tick();
  expect(sent).toHaveLength(1);
  expect(schedules.get(daily.id)!.nextRunAt).toBe(
    new Date(2026, 9, 22, 9, 0).toISOString(),
  );
});

test("schedule API validates input and due schedules run through the normal message path", async () => {
  const dir = temp();
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
    fixtureDelayMs: 1,
  });
  cleanups.push(() => app.close());
  app.service.setMode("api");
  const url = `http://127.0.0.1:${app.server.port}`;
  const id = app.store.agents()[0]!.id;
  const bootstrap = await fetch(url + "/api/control-session");
  const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
  const { csrf } = (await bootstrap.json()) as { csrf: string };
  const request = (path: string, method = "GET", data?: unknown) =>
    fetch(url + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        cookie,
        "x-jelly-csrf": csrf,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });

  expect(
    (
      await request(`/api/agents/${id}/schedules`, "POST", {
        cron: "61 * * * *",
        prompt: "x",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(`/api/agents/${id}/schedules`, "POST", {
        cron: "0 0 30 2 *",
        prompt: "x",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(`/api/agents/${id}/schedules`, "POST", {
        cron: "* * * * *",
        prompt: " ",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(`/api/agents/missing/schedules`, "POST", {
        cron: "* * * * *",
        prompt: "x",
      })
    ).status,
  ).toBe(404);
  const created = await request(`/api/agents/${id}/schedules`, "POST", {
    cron: "*/5  *  * * *",
    prompt: " Check for new mail ",
  });
  expect(created.status).toBe(201);
  const schedule = (await created.json()) as ScheduleRecord;
  expect(schedule).toMatchObject({
    agentId: id,
    cron: "*/5 * * * *",
    prompt: "Check for new mail",
    enabled: true,
  });

  const patched = await request(`/api/schedules/${schedule.id}`, "PATCH", {
    enabled: false,
    prompt: "Check mail",
  });
  expect(await patched.json()).toMatchObject({
    enabled: false,
    prompt: "Check mail",
    cron: "*/5 * * * *",
  });
  expect(
    (
      await request(`/api/schedules/${schedule.id}`, "PATCH", {
        enabled: "yes",
      })
    ).status,
  ).toBe(400);
  await request(`/api/schedules/${schedule.id}`, "PATCH", { enabled: true });

  // Make it due now and let the scheduler fire it.
  const due = new Date(Date.now() - 1000).toISOString();
  app.store.db
    .query("UPDATE schedules SET nextRunAt=? WHERE id=?")
    .run(due, schedule.id);
  app.service.schedules.tick();
  await until(() => app.store.agent(id)!.status === "idle");
  const run = app.store.byRequest(`schedule:${schedule.id}:${due}`)!;
  expect(run.prompt).toBe("Check mail");
  expect(app.store.run(run.id)!.status).toBe("completed");
  const { timeZone, schedules: listed } = (await (
    await request(`/api/agents/${id}/schedules`)
  ).json()) as { timeZone: string; schedules: ScheduleRecord[] };
  expect(timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(listed).toHaveLength(1);
  expect(listed[0]!.lastRunAt).not.toBeNull();
  expect(listed[0]!.lastError).toBeNull();
  expect(new Date(listed[0]!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  const snapshot = app.service.snapshot(id);
  const message = snapshot.events.find(
    (e) => e.type === "message" && e.data.role === "user",
  )!;
  expect(String(message.data.messageId)).toStartWith(
    `schedule:${schedule.id}:`,
  );

  expect(
    (await request(`/api/schedules/${schedule.id}`, "DELETE")).status,
  ).toBe(200);
  expect(
    (await request(`/api/schedules/${schedule.id}`, "DELETE")).status,
  ).toBe(404);
  expect(
    (
      (await (await request(`/api/agents/${id}/schedules`)).json()) as {
        schedules: unknown[];
      }
    ).schedules,
  ).toEqual([]);
});

test("any task can be scheduled: weekly reports, polls and audits share agents, queues and concurrency like typed messages", async () => {
  const dir = temp();
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
    fixtureDelayMs: 40,
  });
  cleanups.push(() => app.close());
  app.service.setMode("api");
  const { service, store } = app;
  const writer = store.agents()[0]!;
  const auditor = service.createAgent({
    name: "Auditor",
    instructions: "",
    color: "#b5bafc",
  });
  const weekly = service.schedules.create(writer.id, {
    cron: "0 17 * * fri",
    prompt: "Write the weekly report into reports/",
  });
  const inbox = service.schedules.create(writer.id, {
    cron: "*/15 * * * *",
    prompt: "Check the inbox MCP for new bug reports",
  });
  const audit = service.schedules.create(auditor.id, {
    cron: "@monthly",
    prompt: "Audit dependencies and open a PR",
  });
  const now = new Date();
  expect(weekly.nextRunAt).toBe(next("0 17 * * 5", now)!.toISOString());
  expect(new Date(weekly.nextRunAt!).getDay()).toBe(5);
  expect(audit.nextRunAt).toBe(next("0 0 1 * *", now)!.toISOString());
  expect(new Date(audit.nextRunAt!).getDate()).toBe(1);

  // All three come due together.
  const due = (id: string, ms: number) => {
    const at = new Date(Date.now() - ms).toISOString();
    store.db.query("UPDATE schedules SET nextRunAt=? WHERE id=?").run(at, id);
    return at;
  };
  const slots = {
    weekly: due(weekly.id, 3000),
    inbox: due(inbox.id, 2000),
    audit: due(audit.id, 1000),
  };
  service.schedules.tick();
  // The writer runs its weekly report and queues the inbox check; the auditor runs concurrently.
  expect(store.agent(writer.id)!.status).toBe("running");
  expect(store.agent(auditor.id)!.status).toBe("running");
  expect(store.pendingMessages(writer.id).map((m) => m.text)).toEqual([
    "Check the inbox MCP for new bug reports",
  ]);
  // A typed message waits behind the scheduled one (FIFO), and nothing fires twice.
  service.start(writer.id, "typed-1", "Also summarise yesterday's deploys");
  service.schedules.tick();
  expect(store.pendingMessages(writer.id).map((m) => m.id)).toEqual([
    `schedule:${inbox.id}:${slots.inbox}`,
    "typed-1",
  ]);

  await until(
    () =>
      store.agent(writer.id)!.status === "idle" &&
      store.agent(auditor.id)!.status === "idle",
  );
  const runs = [
    `schedule:${weekly.id}:${slots.weekly}`,
    `schedule:${inbox.id}:${slots.inbox}`,
    "typed-1",
  ].map((id) => store.byRequest(id)!);
  expect(runs.map((r) => store.run(r.id)!.status)).toEqual([
    "completed",
    "completed",
    "completed",
  ]);
  expect(runs.map((r) => store.run(r.id)!.startedAt)).toEqual(
    runs.map((r) => store.run(r.id)!.startedAt).sort(),
  );
  expect(
    store.run(store.byRequest(`schedule:${audit.id}:${slots.audit}`)!.id)!
      .status,
  ).toBe("completed");
  for (const s of service.schedules
    .list(writer.id)
    .concat(service.schedules.list(auditor.id))) {
    expect(s.lastError).toBeNull();
    expect(new Date(s.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  }

  // Without a usable model connection the failure is recorded on the schedule, not lost.
  service.setMode("chatgpt");
  due(inbox.id, 500);
  service.schedules.tick();
  expect(service.schedules.get(inbox.id)!.lastError).toMatch(
    /ChatGPT|connect|sign/i,
  );
  expect(store.agent(writer.id)!.status).toBe("idle");
});

test("schedules survive a restart with their configuration and status intact", async () => {
  const dir = temp();
  const options = {
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
    fixtureDelayMs: 1,
  };
  let app = await startApp(options);
  const id = app.store.agents()[0]!.id;
  const kept = app.service.schedules.create(id, {
    cron: "0 9 * * 1-5",
    prompt: "Morning digest",
  });
  const paused = app.service.schedules.update(
    app.service.schedules.create(id, { cron: "@hourly", prompt: "Poll" }).id,
    { enabled: false },
  );
  app.store.db
    .query("UPDATE schedules SET lastRunAt=?, lastError=? WHERE id=?")
    .run("2026-10-12T09:00:00.000Z", "Earlier failure", kept.id);
  await app.close();

  app = await startApp(options);
  cleanups.push(() => app.close());
  const after = app.service.schedules.list(id);
  expect(after.map((s) => [s.id, s.cron, s.prompt, s.enabled])).toEqual([
    [kept.id, "0 9 * * 1-5", "Morning digest", true],
    [paused.id, "@hourly", "Poll", false],
  ]);
  expect(after[0]).toMatchObject({
    lastRunAt: "2026-10-12T09:00:00.000Z",
    lastError: "Earlier failure",
    nextRunAt: kept.nextRunAt,
  });
});

test("model schedule suggestions are validated with the same cron rules", () => {
  const now = new Date(2026, 9, 13, 10, 7);
  expect(
    suggestionFromModel(
      '```json\n{"cron": "0  9 * * 1-5", "message": "Check my inbox", "summary": "Weekdays at 9:00"}\n```',
      now,
    ),
  ).toEqual({
    cron: "0 9 * * 1-5",
    once: false,
    prompt: "Check my inbox",
    summary: "Weekdays at 9:00",
    nextRuns: [
      new Date(2026, 9, 14, 9, 0).toISOString(),
      new Date(2026, 9, 15, 9, 0).toISOString(),
      new Date(2026, 9, 16, 9, 0).toISOString(),
    ],
  });
  expect(
    suggestionFromModel('{"cron":"@weekly","message":"","summary":""}', now),
  ).toMatchObject({ prompt: null, summary: null });
  for (const raw of [
    null,
    "",
    "not json",
    '{"cron": 5}',
    '{"cron": "every day"}',
    '{"cron": "0 0 30 2 *"}',
  ])
    expect(() => suggestionFromModel(raw, now)).toThrow(/Couldn't understand/);
  expect(() => suggestionFromModel('{"error": "No time given."}', now)).toThrow(
    /^No time given\. Couldn't/,
  );
});

test("schedule parsing previews cron directly and asks the model beside a busy agent without queueing", async () => {
  const dir = temp();
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
    fixtureDelayMs: 300,
  });
  cleanups.push(() => app.close());
  app.service.setMode("api");
  const id = app.store.agents()[0]!.id;
  const harness = app.service.harness;
  const calls: string[] = [];
  let reply: () => Promise<string | null> = async () =>
    '{"cron":"0 9 * * 1-5","message":"Check my inbox for bug reports","summary":"Weekdays at 9:00"}';
  harness.parseSchedule = async (text, now, timeZone) => {
    calls.push(`${text}|${timeZone}|${now}`);
    return reply();
  };
  const parse = (input: Record<string, unknown>) =>
    app.service.parseSchedule(id, input);

  // Typed cron needs no model.
  expect((await parse({ cron: "*/30 * * * *" })).nextRuns).toHaveLength(3);
  expect(await parse({ text: " @daily " })).toMatchObject({
    cron: "@daily",
    prompt: null,
  });
  await expect(parse({ cron: "61 * * * *" })).rejects.toThrow(
    /Invalid schedule/,
  );
  expect(calls).toEqual([]);

  // Natural language while the agent is busy: answered directly, nothing queued or saved.
  app.service.start(id, "busy-1", "A long task");
  expect(app.store.agent(id)!.status).toBe("running");
  const messages = app.store.history(id).length;
  const suggestion = await parse({
    text: "every weekday at 9am check my inbox for bug reports",
  });
  expect(suggestion).toMatchObject({
    cron: "0 9 * * 1-5",
    prompt: "Check my inbox for bug reports",
    summary: "Weekdays at 9:00",
  });
  expect(app.store.agent(id)!.status).toBe("running");
  expect(app.store.pendingMessages(id)).toEqual([]);
  expect(app.store.history(id).length).toBe(messages);
  expect(calls[0]).toStartWith(
    `every weekday at 9am check my inbox for bug reports|${Intl.DateTimeFormat().resolvedOptions().timeZone}|`,
  );
  expect(app.service.schedules.list(id)).toEqual([]);

  reply = async () => '{"error":"That is a one-off time."}';
  await expect(parse({ text: "tomorrow at 3pm" })).rejects.toThrow(/one-off/);
  reply = async () => {
    throw new Error("rate limited");
  };
  await expect(parse({ text: "every hour" })).rejects.toThrow(
    /Couldn't reach the model/,
  );
  await expect(parse({ text: "" })).rejects.toThrow(/1 to 1000/);
  app.service.setMode("chatgpt");
  await expect(parse({ text: "every hour" })).rejects.toThrow(/ChatGPT/);
  await expect(
    app.service.parseSchedule("missing", { text: "every hour" }),
  ).rejects.toThrow(/Agent not found/);
});

test("the schedule parse side call is a single tool-free completion with the local clock and time zone", async () => {
  const dir = temp();
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
    fixtureDelayMs: 1,
  });
  cleanups.push(() => app.close());
  app.service.setMode("api");
  const runtime = app.service.harness.runtime;
  const seen: any[] = [];
  const original = runtime.completeSimple.bind(runtime);
  runtime.completeSimple = (async (model: any, context: any, options: any) => {
    seen.push({ context, options });
    const result = await original(model, context, options);
    return {
      ...result,
      stopReason: "stop",
      content: [
        {
          type: "text",
          text: '{"cron":"0 17 * * 5","message":"Write the weekly report","summary":"Fridays at 17:00"}',
        },
      ],
    };
  }) as typeof runtime.completeSimple;
  const id = app.store.agents()[0]!.id;
  const result = await app.service.parseSchedule(id, {
    text: "weekly report every Friday at 5pm",
  });
  expect(result).toMatchObject({
    cron: "0 17 * * 5",
    prompt: "Write the weekly report",
  });
  expect(new Date(result.nextRuns[0]!).getDay()).toBe(5);
  expect(seen).toHaveLength(1);
  expect(seen[0].context.messages).toEqual([
    expect.objectContaining({
      role: "user",
      content: "weekly report every Friday at 5pm",
    }),
  ]);
  expect(seen[0].context.systemPrompt).toContain(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  expect(seen[0].context.tools).toBeUndefined();
  expect(seen[0].options).toMatchObject({
    maxRetries: 0,
    reasoning: "minimal",
  });
  expect(app.store.runs(id)).toEqual([]);
});

test("one-time schedules fire once, pause, keep their time, and flag a time missed while stopped", () => {
  const dir = temp();
  const store = new Store(join(dir, "jelly.sqlite"), join(dir, "workspaces"));
  cleanups.push(() => store.close());
  const agent = store.addAgent({
    name: "Scout",
    instructions: "",
    color: "#b5bafc",
  });
  let now = new Date(2026, 9, 13, 10, 0);
  const sent: string[] = [];
  const schedules = new Schedules(
    store.db,
    (_agentId, requestId) => void sent.push(requestId),
    () => now,
  );
  const reminder = schedules.create(agent.id, {
    cron: "0 15 14 10 *",
    prompt: "Review the PR",
    once: true,
  });
  const due = new Date(2026, 9, 14, 15, 0).toISOString();
  expect(reminder).toMatchObject({ once: true, enabled: true, nextRunAt: due });

  now = new Date(2026, 9, 14, 15, 0, 5);
  schedules.tick();
  schedules.tick();
  expect(sent).toEqual([`schedule:${reminder.id}:${due}`]);
  expect(schedules.get(reminder.id)).toMatchObject({
    enabled: false,
    nextRunAt: due,
    lastRunAt: now.toISOString(),
    lastError: null,
  });
  // A later restart does not treat the paused reminder as missed.
  schedules.start(60_000);
  schedules.stop();
  expect(schedules.get(reminder.id)!.lastError).toBeNull();

  // Re-enabling moves it to the next matching date (next year), still once.
  const again = schedules.update(reminder.id, { enabled: true });
  expect(again).toMatchObject({
    once: true,
    enabled: true,
    nextRunAt: new Date(2027, 9, 14, 15, 0).toISOString(),
  });

  // Missed while stopped: paused with a reason, never sent late.
  const missed = schedules.create(agent.id, {
    cron: "30 16 14 10 *",
    prompt: "Call back",
    once: true,
  });
  now = new Date(2026, 9, 14, 18, 0);
  schedules.start(60_000);
  schedules.stop();
  schedules.tick();
  expect(sent).toHaveLength(1);
  expect(schedules.get(missed.id)).toMatchObject({
    enabled: false,
    lastError: "Missed while Jelly was stopped.",
  });
  expect(() =>
    schedules.create(agent.id, { cron: "* * * * *", prompt: "x", once: "yes" }),
  ).toThrow(/Once must be/);

  // An existing table from before one-time schedules gains the column.
  store.db.exec(
    "CREATE TABLE legacy AS SELECT id,agentId,cron,prompt,enabled,nextRunAt,lastRunAt,lastError,createdAt FROM schedules; DROP TABLE schedules; ALTER TABLE legacy RENAME TO schedules;",
  );
  const upgraded = new Schedules(
    store.db,
    () => {},
    () => now,
  );
  expect(upgraded.get(missed.id)!.once).toBe(false);
});

test("model suggestions carry the one-time flag", () => {
  const now = new Date(2026, 9, 13, 10, 7);
  expect(
    suggestionFromModel(
      '{"cron":"0 15 14 10 *","once":true,"message":"Review the PR","summary":"Tomorrow at 3:00 PM"}',
      now,
    ),
  ).toMatchObject({
    cron: "0 15 14 10 *",
    once: true,
    prompt: "Review the PR",
    nextRuns: [
      new Date(2026, 9, 14, 15, 0).toISOString(),
      new Date(2027, 9, 14, 15, 0).toISOString(),
      new Date(2028, 9, 14, 15, 0).toISOString(),
    ],
  });
  expect(
    suggestionFromModel('{"cron":"0 9 * * *","once":"yes"}', now).once,
  ).toBe(false);
});
