import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store";
import { Schedules, scheduledWake } from "../src/server/schedules";
import { cronInstant, validateSchedule } from "../src/server/schedule-timing";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-schedules-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "test.sqlite"));
  cleanups.push(() => store.close());
  const agent = store.addAgent({
    name: "Clock",
    instructions: "Keep context",
    color: "#123456",
  });
  let now = Date.parse("2026-01-01T00:00:00Z");
  const schedules = new Schedules(store, () => now);
  const create = (extra: Record<string, unknown> = {}) =>
    schedules.create(agent.id, {
      title: "Review",
      prompt: "  exact\ntext  ",
      kind: "cron",
      cron: "* * * * *",
      timezone: "UTC",
      requestId: crypto.randomUUID(),
      ...extra,
    });
  return {
    store,
    agent,
    schedules,
    create,
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}
test("schedule schema migration, durable receipt, mutation idempotency and revision conflicts", () => {
  const f = fixture();
  const receipt = f.create({ requestId: "stable" });
  expect(f.create({ requestId: "stable" })).toEqual(receipt);
  expect(() => f.create({ requestId: "stable", prompt: "different" })).toThrow(
    "different payload",
  );
  expect(receipt.preview).toHaveLength(3);
  expect(receipt.schedule.prompt).toBe("  exact\ntext  ");
  expect(receipt.schedule.maxLatenessSeconds).toBe(86400);
  expect(f.store.runs(f.agent.id)).toEqual([]);
  expect(f.store.db.query("PRAGMA user_version").get()).toEqual({
    user_version: 20,
  });
  const paused = f.schedules.change(f.agent.id, receipt.schedule.id, "pause", {
    requestId: "pause",
    expectedRevision: 1,
  });
  expect(paused.schedule.revision).toBe(2);
  expect(() =>
    f.schedules.change(f.agent.id, receipt.schedule.id, "resume", {
      requestId: "stale",
      expectedRevision: 1,
    }),
  ).toThrow("Schedule changed");
  expect(
    f.schedules.change(f.agent.id, receipt.schedule.id, "pause", {
      requestId: "pause",
      expectedRevision: 1,
    }),
  ).toEqual(paused);
});
test("five-field cron validation, offsets, invalid dates, bounds and no OS timezone inference", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const base = {
    title: "Task",
    prompt: "Task",
    kind: "cron",
    timezone: "UTC",
    cron: "0 9 * * 1-5",
  };
  for (const extra of [
    { cron: "0 0 9 * * *" },
    { cron: "@daily" },
    { cron: "* * * * * shell" },
    { cron: "H * * * *" },
    { cron: "0 0 31 2 *" },
    { timezone: "bad/zone" },
    { timezone: undefined },
    { maxLatenessSeconds: 0 },
    { maxLatenessSeconds: 86401 },
    { prompt: "x".repeat(24001) },
  ])
    expect(() => validateSchedule({ ...base, ...extra }, now)).toThrow();
  const once = {
    title: "Task",
    prompt: "Task",
    kind: "once",
    timezone: "Europe/London",
  };
  for (const runAt of [
    "in two hours",
    "2026-01-01T02:00:00",
    "2025-01-01T00:00:00Z",
    "2026-02-30T00:00:00Z",
  ])
    expect(() => validateSchedule({ ...once, runAt }, now)).toThrow();
  expect(
    validateSchedule({ ...once, runAt: "2026-01-01T03:00:00+01:00" }, now)
      .runAt,
  ).toBe("2026-01-01T02:00:00.000Z");
});
test("cron wrapper handles OR, sparse leap days, DST gaps and first folds in both directions", () => {
  const next = (cron: string, date: string, zone = "UTC") =>
    cronInstant(cron, zone, Date.parse(date));
  expect(next("0 0 1 * MON", "2026-01-02T00:00:00Z")).toBe(
    "2026-01-05T00:00:00.000Z",
  );
  expect(next("0 0 29 2 *", "2026-01-01T00:00:00Z")).toBe(
    "2028-02-29T00:00:00.000Z",
  );
  expect(next("30 2 * * *", "2026-03-08T00:00:00Z", "America/New_York")).toBe(
    "2026-03-09T06:30:00.000Z",
  );
  expect(next("30 1 * * *", "2026-11-01T00:00:00Z", "America/New_York")).toBe(
    "2026-11-01T05:30:00.000Z",
  );
  expect(next("30 1 * * *", "2026-11-01T05:30:00Z", "America/New_York")).toBe(
    "2026-11-02T06:30:00.000Z",
  );
  expect(
    cronInstant(
      "* * * * *",
      "America/New_York",
      Date.parse("2026-11-01T06:59:59Z"),
      "prev",
    ),
  ).toBe("2026-11-01T05:59:00.000Z");
  expect(next("* * * * *", "2026-11-01T06:00:00Z", "America/New_York")).toBe(
    "2026-11-01T07:00:00.000Z",
  );
  expect(
    next("15 2 * * *", "2026-10-03T00:00:00Z", "Australia/Lord_Howe"),
  ).toBe("2026-10-04T15:15:00.000Z");
});
test("atomic cursor/occurrence creation, missed latest coalescing, overlap and stable deduplication", () => {
  const f = fixture(),
    receipt = f.create();
  f.advance(10 * 60_000);
  f.schedules.due(f.now(), f.now(), 100);
  const first = f.schedules.pending(100)[0]!;
  expect(first.scheduledFor).toBe("2026-01-01T00:10:00.000Z");
  f.schedules.due(f.now(), null, 100);
  expect(
    f.schedules.occurrences(f.agent.id, receipt.schedule.id).items,
  ).toHaveLength(1);
  f.advance(60_000);
  f.schedules.due(f.now(), null, 100);
  expect(f.schedules.pending(100)).toHaveLength(1);
  expect(
    f.schedules.occurrences(f.agent.id, receipt.schedule.id).items[0]!.state,
  ).toBe("skipped");
  const wake = scheduledWake(first, new Date(f.now()).toISOString());
  expect(wake.text.endsWith("--- Stored task ---\n  exact\ntext  ")).toBe(true);
  expect(wake.source.taskSnapshot).toBe(first.snapshot.prompt);
  expect(wake.text).toContain("Do not schedule another copy");
});
test("catch-up none and overdue one-off expiry are visible without any admitted run", () => {
  const f = fixture();
  const cron = f.create({ catchUp: "none" });
  const once = f.create({
    kind: "once",
    cron: undefined,
    runAt: "2026-01-01T00:01:00Z",
    maxLatenessSeconds: 60,
  });
  f.advance(10 * 60_000);
  f.schedules.due(f.now(), f.now(), 100);
  expect(f.schedules.get(f.agent.id, once.schedule.id).state).toBe("expired");
  expect(
    f.schedules.occurrences(f.agent.id, cron.schedule.id).items[0]!.state,
  ).toBe("skipped");
  expect(f.store.runs(f.agent.id)).toHaveLength(0);
  expect(
    f.store.events().some((event) => event.type === "schedule_expired"),
  ).toBe(true);
});
test("pause/update/cancel remove pending work; cron resume skips paused interval; one-off must be rescheduled", () => {
  const f = fixture();
  let receipt = f.create();
  f.advance(60_000);
  f.schedules.due(f.now(), null, 100);
  receipt = f.schedules.change(f.agent.id, receipt.schedule.id, "pause", {
    requestId: "pause",
    expectedRevision: 1,
  });
  expect(f.schedules.pending(100)).toHaveLength(0);
  f.advance(60 * 60_000);
  receipt = f.schedules.change(f.agent.id, receipt.schedule.id, "resume", {
    requestId: "resume",
    expectedRevision: 2,
  });
  expect(Date.parse(receipt.schedule.nextRunAt!)).toBe(f.now() + 60_000);
  const old = f.schedules.occurrences(f.agent.id, receipt.schedule.id)
    .items[0]!;
  receipt = f.schedules.change(f.agent.id, receipt.schedule.id, "update", {
    requestId: "edit",
    expectedRevision: 3,
    prompt: "new task",
  });
  expect(f.schedules.occurrence(old.id)!.snapshot.prompt).toBe(
    "  exact\ntext  ",
  );
  f.schedules.change(f.agent.id, receipt.schedule.id, "cancel", {
    requestId: "cancel",
    expectedRevision: 4,
  });
  expect(() =>
    f.schedules.change(f.agent.id, receipt.schedule.id, "resume", {
      requestId: "again",
      expectedRevision: 5,
    }),
  ).toThrow("terminal");
  const once = f.create({
    kind: "once",
    cron: undefined,
    runAt: new Date(f.now() + 60_000).toISOString(),
  });
  f.schedules.change(f.agent.id, once.schedule.id, "pause", {
    requestId: "pause-once",
    expectedRevision: 1,
  });
  f.advance(120_000);
  expect(() =>
    f.schedules.change(f.agent.id, once.schedule.id, "resume", {
      requestId: "resume-once",
      expectedRevision: 2,
    }),
  ).toThrow("future time");
});
test("crash before occurrence commit rolls back cursor and deduplication; pending survives normal recovery", () => {
  const f = fixture(),
    receipt = f.create();
  f.advance(60_000);
  expect(() =>
    f.store.db.transaction(() => {
      f.schedules.due(f.now(), null, 100);
      throw new Error("crash");
    })(),
  ).toThrow("crash");
  expect(f.schedules.get(f.agent.id, receipt.schedule.id).nextRunAt).toBe(
    "2026-01-01T00:01:00.000Z",
  );
  expect(f.schedules.pending(100)).toHaveLength(0);
  f.schedules.due(f.now(), null, 100);
  f.store.enqueueMessage("manual", f.agent.id, "draft", "queue");
  f.store.recover();
  f.schedules.recover();
  expect(f.store.pendingMessage("manual")!.status).toBe("cancelled");
  expect(f.schedules.pending(100)).toHaveLength(1);
});
test("history pagination, provider backoff notices, expiry and scoped identity", () => {
  const f = fixture(),
    receipt = f.create();
  f.advance(60_000);
  f.schedules.due(f.now(), null, 100);
  const occurrence = f.schedules.pending(100)[0]!;
  f.schedules.blocked(occurrence, new Error("Connect provider"));
  f.schedules.blocked(
    f.schedules.occurrence(occurrence.id)!,
    new Error("Connect provider"),
  );
  expect(
    f.store.events().filter((event) => event.type === "schedule_blocked"),
  ).toHaveLength(1);
  expect(f.schedules.pending(100)).toHaveLength(0);
  f.advance(60_000);
  f.schedules.due(f.now(), null, 100);
  const page = f.schedules.occurrences(
    f.agent.id,
    receipt.schedule.id,
    undefined,
    1,
  );
  expect(page.before).not.toBeNull();
  expect(
    f.schedules.occurrences(f.agent.id, receipt.schedule.id, page.before!, 1)
      .items[0]!.id,
  ).toBe(occurrence.id);
  const other = f.store.addAgent({
    name: "Other",
    instructions: "",
    color: "#123456",
  });
  expect(() => f.schedules.get(other.id, receipt.schedule.id)).toThrow(
    "not found",
  );
  f.advance(86400_000);
  f.schedules.expire(occurrence);
  expect(f.schedules.occurrence(occurrence.id)!.state).toBe("expired");
  expect(f.schedules.occurrence(occurrence.id)!.reasonCode).toBe("lateness");
  expect(f.schedules.occurrence(occurrence.id)!.delays).toContain("delivery");
  expect(f.store.agentNotifications().some(event => event.type === "schedule_expired")).toBe(true);
});

test("active/paused limits do not impose a lifetime cap; retained schedule history has stable bounded pagination", () => {
  const f = fixture();
  const receipts = Array.from({ length: 100 }, (_, index) =>
    f.create({ title: `Task ${index}` }),
  );
  expect(() => f.create()).toThrow("100 active/paused");
  const paused = f.schedules.change(
    f.agent.id,
    receipts[0]!.schedule.id,
    "pause",
    { requestId: "limit-pause", expectedRevision: 1 },
  );
  expect(() => f.create()).toThrow("100 active/paused");
  f.schedules.change(f.agent.id, paused.schedule.id, "cancel", {
    requestId: "limit-cancel",
    expectedRevision: 2,
  });
  const replacement = f.create({
    title: "Allowed despite 100 historical records",
  });
  expect(replacement.schedule.state).toBe("active");
  let before: string | undefined;
  const ids: string[] = [];
  do {
    const page = f.schedules.list(f.agent.id, { limit: 17, before });
    expect(page.items.length).toBeLessThanOrEqual(17);
    expect(page.activeCount).toBe(100);
    ids.push(...page.items.map((item) => item.schedule.id));
    before = page.before ?? undefined;
  } while (before);
  expect(ids).toHaveLength(101);
  expect(new Set(ids).size).toBe(101);
  expect(
    f.schedules
      .list(f.agent.id, { state: "terminal" })
      .items.map((item) => item.schedule.id),
  ).toEqual([paused.schedule.id]);
  expect(() => f.schedules.list(f.agent.id, { before: "invalid" })).toThrow(
    "cursor",
  );
  expect(() => f.schedules.list(f.agent.id, { limit: 101 })).toThrow("1–100");
});
test("timezone suggestion changes never shift existing schedules, one-off seconds are preserved, extension cron syntax is rejected", () => {
  const f = fixture();
  const receipt = f.create({
    kind: "once",
    cron: undefined,
    runAt: "2026-01-01T00:01:23.456+00:00",
  });
  f.schedules.saveTimezone(f.agent.id, "Asia/Tokyo");
  f.schedules.saveTimezone("instance", "Australia/Sydney");
  expect(f.schedules.get(f.agent.id, receipt.schedule.id).runAt).toBe(
    "2026-01-01T00:01:23.456Z",
  );
  expect(f.schedules.get(f.agent.id, receipt.schedule.id).timezone).toBe("UTC");
  for (const cron of ["0 0 * * 5L", "0 0 L * *", "0 0 * * 1#2", "H/5 * * * *"])
    expect(() => f.create({ cron })).toThrow();
  f.advance(83455);
  f.schedules.due(f.now(), null, 100);
  expect(f.schedules.pending(100)).toHaveLength(0);
  f.advance(1);
  f.schedules.due(f.now(), null, 100);
  expect(f.schedules.pending(100)).toHaveLength(1);
});
test("resume of an already active schedule is a safe no-op and never discards pending work", () => {
  const f = fixture(),
    receipt = f.create();
  f.advance(60000);
  f.schedules.due(f.now(), null, 100);
  const pending = f.schedules.pending(100)[0]!;
  const resumed = f.schedules.change(
    f.agent.id,
    receipt.schedule.id,
    "resume",
    { requestId: "already-active", expectedRevision: 1 },
  );
  expect(resumed.schedule.revision).toBe(1);
  expect(f.schedules.occurrence(pending.id)!.state).toBe("pending");
});
test("startup catch-up none stays effective across bounded batches and backwards clock jumps do not duplicate ticks", async () => {
  const { Scheduler } = await import("../src/server/scheduler");
  const f = fixture();
  const receipts = Array.from({ length: 3 }, () =>
    f.create({ catchUp: "none" }),
  );
  f.advance(10 * 60000);
  const scheduler = new Scheduler(f.schedules, () => false, {
    batchSize: 1,
    pollMs: 60000,
  });
  cleanups.push(() => scheduler.stop());
  scheduler.start();
  for (let i = 0; i < 3; i++) {
    scheduler.tick();
    f.advance(1000);
  }
  for (const receipt of receipts)
    expect(
      f.schedules.occurrences(f.agent.id, receipt.schedule.id).items[0]!.state,
    ).toBe("skipped");
  f.advance(57000);
  for (let i = 0; i < 3; i++) scheduler.tick();
  expect(f.schedules.pending(100)).toHaveLength(3);
  f.advance(-5 * 60000);
  scheduler.tick();
  f.advance(5 * 60000);
  scheduler.tick();
  for (const receipt of receipts)
    expect(
      f.schedules.occurrences(f.agent.id, receipt.schedule.id).items,
    ).toHaveLength(2);
});

test("impossible day-of-month retains the valid restricted weekday OR branch for preview and due delivery", () => {
  const f = fixture();
  for (const cron of ["0 0 30 2 MON", "0 0 31 2 1", "0 0 30,31 2 MON"]) {
    const receipt = f.create({ cron });
    expect(receipt.preview).toEqual([
      "2026-02-02T00:00:00.000Z",
      "2026-02-09T00:00:00.000Z",
      "2026-02-16T00:00:00.000Z",
    ]);
    expect(
      cronInstant(cron, "UTC", Date.parse("2026-02-10T00:00:00Z"), "prev"),
    ).toBe("2026-02-09T00:00:00.000Z");
  }
  for (const cron of [
    "0 0 30 2 *",
    "0 0 32 2 MON",
    "0 0 30 13 MON",
    "0 0 30 2 9",
  ])
    expect(() => f.create({ cron })).toThrow();
  f.advance(Date.parse("2026-02-09T00:00:00Z") - f.now());
  f.schedules.due(f.now(), f.now(), 100);
  expect(
    f.schedules.pending(100).map((occurrence) => occurrence.scheduledFor),
  ).toEqual(Array(3).fill("2026-02-09T00:00:00.000Z"));
});
