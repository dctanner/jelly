import type { Database } from "bun:sqlite";
import type { ScheduleRecord } from "../shared/types";
import { HttpError } from "./errors";

/**
 * Per-agent cron schedules. A due schedule sends its prompt through the same
 * idempotent `start(agentId, requestId, prompt)` path as a typed message, so
 * busy agents queue it and the timeline records it like any other message.
 * Schedules use the server's local time zone and only fire while Jelly runs;
 * times missed while stopped are skipped, not replayed. A one-time schedule
 * fires at its next matching time and then pauses itself.
 */
const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};
const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const FIELDS: {
  name: string;
  min: number;
  max: number;
  names?: string[];
  offset?: number;
}[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, offset: 1 },
  { name: "day of week", min: 0, max: 7, names: DAYS },
];
export const MAX_SCHEDULES_PER_AGENT = 20;
export const SCHEDULE_PROMPT_MAX = 24000;

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  anyDay: boolean;
  anyWeekday: boolean;
}

export function parseCron(expression: string): Cron {
  const source = MACROS[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = source.split(/\s+/);
  if (parts.length !== 5)
    throw new Error(
      "Use five fields: minute hour day-of-month month day-of-week.",
    );
  const sets = parts.map((part, index) => {
    const field = FIELDS[index]!;
    const value = (text: string) => {
      const named = field.names?.indexOf(text.toLowerCase()) ?? -1;
      if (named >= 0) return named + (field.offset ?? 0);
      if (!/^\d+$/.test(text))
        throw new Error(`Invalid ${field.name} "${text}".`);
      const number = Number(text);
      if (number < field.min || number > field.max)
        throw new Error(
          `The ${field.name} must be between ${field.min} and ${field.max}.`,
        );
      return number;
    };
    const set = new Set<number>();
    for (const item of part.split(",")) {
      const [range, stepText, extra] = item.split("/");
      if (extra !== undefined || !range)
        throw new Error(`Invalid ${field.name} "${item}".`);
      const step = stepText === undefined ? 1 : Number(stepText);
      if (!Number.isInteger(step) || step < 1)
        throw new Error(`Invalid ${field.name} step "${stepText}".`);
      let [low, high] = [field.min, field.max];
      if (range !== "*") {
        const bounds = range.split("-");
        if (bounds.length > 2)
          throw new Error(`Invalid ${field.name} "${item}".`);
        low = value(bounds[0]!);
        high =
          bounds.length === 2
            ? value(bounds[1]!)
            : stepText === undefined
              ? low
              : field.max;
        if (low > high)
          throw new Error(`Invalid ${field.name} range "${range}".`);
      }
      for (let n = low; n <= high; n += step)
        set.add(index === 4 && n === 7 ? 0 : n);
    }
    return set;
  });
  return {
    minute: sets[0]!,
    hour: sets[1]!,
    day: sets[2]!,
    month: sets[3]!,
    weekday: sets[4]!,
    anyDay: parts[2] === "*",
    anyWeekday: parts[4] === "*",
  };
}

/** The first local wall-clock minute strictly after `after`, or null within five years. */
export function nextCron(cron: Cron, after: Date): Date | null {
  const date = new Date(after);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 86_400_000;
  // POSIX cron: when both day fields are restricted, either may match.
  const dayMatches = () =>
    cron.anyDay && cron.anyWeekday
      ? true
      : cron.anyDay
        ? cron.weekday.has(date.getDay())
        : cron.anyWeekday
          ? cron.day.has(date.getDate())
          : cron.day.has(date.getDate()) || cron.weekday.has(date.getDay());
  while (date.getTime() <= limit) {
    if (!cron.month.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1);
      date.setHours(0, 0, 0, 0);
    } else if (!dayMatches()) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
    } else if (!cron.hour.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0);
    } else if (!cron.minute.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0);
    } else return date;
  }
  return null;
}

function nextRun(cron: string, after: Date) {
  let parsed: Cron;
  try {
    parsed = parseCron(cron);
  } catch (error) {
    throw new HttpError(400, `Invalid schedule: ${(error as Error).message}`);
  }
  const next = nextCron(parsed, after);
  if (!next) throw new HttpError(400, "This schedule never runs.");
  return next.toISOString();
}

/** The next few run times, for confirming a schedule before saving it. */
export function previewRuns(cron: string, after: Date, count = 3) {
  const runs = [nextRun(cron, after)];
  while (runs.length < count) {
    const next = nextCron(parseCron(cron), new Date(runs.at(-1)!));
    if (!next) break;
    runs.push(next.toISOString());
  }
  return runs;
}

export interface ScheduleSuggestion {
  cron: string;
  once: boolean;
  prompt: string | null;
  summary: string | null;
  nextRuns: string[];
}

/** Validate a model's natural-language parse with the same rules as a typed schedule. */
export function suggestionFromModel(
  raw: string | null,
  now: Date,
): ScheduleSuggestion {
  const unclear =
    "Couldn't understand that schedule. Try rephrasing, pick a preset or enter a cron expression.";
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw?.match(/\{[\s\S]*\}/)?.[0] ?? "");
  } catch {
    throw new HttpError(422, unclear);
  }
  if (typeof value.error === "string" && value.error.trim())
    throw new HttpError(422, `${value.error.trim().slice(0, 200)} ${unclear}`);
  if (typeof value.cron !== "string") throw new HttpError(422, unclear);
  const cron = value.cron.trim().replace(/\s+/g, " ");
  let nextRuns: string[];
  try {
    if (!cron || cron.length > 100) throw new Error();
    nextRuns = previewRuns(cron, now);
  } catch {
    throw new HttpError(
      422,
      `The suggested schedule "${cron.slice(0, 100)}" is not valid. ${unclear}`,
    );
  }
  const text = (field: unknown, max: number) =>
    typeof field === "string" && field.trim()
      ? field.trim().slice(0, max)
      : null;
  return {
    cron,
    once: value.once === true,
    prompt: text(value.message, SCHEDULE_PROMPT_MAX),
    summary: text(value.summary, 200),
    nextRuns,
  };
}

export function scheduleInput(input: Record<string, unknown>, partial = false) {
  const result: {
    cron?: string;
    prompt?: string;
    enabled?: boolean;
    once?: boolean;
  } = {};
  if (!partial || input.cron !== undefined) {
    if (
      typeof input.cron !== "string" ||
      !input.cron.trim() ||
      input.cron.length > 100
    )
      throw new HttpError(
        400,
        "Schedule must be between 1 and 100 characters.",
      );
    result.cron = input.cron.trim().replace(/\s+/g, " ");
  }
  if (!partial || input.prompt !== undefined) {
    if (
      typeof input.prompt !== "string" ||
      !input.prompt.trim() ||
      input.prompt.length > SCHEDULE_PROMPT_MAX
    )
      throw new HttpError(
        400,
        `Prompt must be between 1 and ${SCHEDULE_PROMPT_MAX} characters.`,
      );
    result.prompt = input.prompt.trim();
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean")
      throw new HttpError(400, "Enabled must be true or false.");
    result.enabled = input.enabled;
  }
  if (input.once !== undefined) {
    if (typeof input.once !== "boolean")
      throw new HttpError(400, "Once must be true or false.");
    result.once = input.once;
  }
  return result;
}

type Row = Omit<ScheduleRecord, "enabled" | "once"> & {
  enabled: number;
  once: number;
};
const record = (row: Row): ScheduleRecord => ({
  ...row,
  enabled: !!row.enabled,
  once: !!row.once,
});

export class Schedules {
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private db: Database,
    private send: (
      agentId: string,
      requestId: string,
      prompt: string,
    ) => unknown,
    private now = () => new Date(),
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id),
      cron TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      nextRunAt TEXT, lastRunAt TEXT, lastError TEXT, createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_agent ON schedules(agentId);`);
    // One-time schedules pause themselves after firing.
    if (
      !(
        db.query("PRAGMA table_info(schedules)").all() as { name: string }[]
      ).some((c) => c.name === "once")
    )
      db.exec(
        "ALTER TABLE schedules ADD COLUMN once INTEGER NOT NULL DEFAULT 0",
      );
  }
  list(agentId: string) {
    return (
      this.db
        .query("SELECT * FROM schedules WHERE agentId=? ORDER BY createdAt, rowid")
        .all(agentId) as Row[]
    ).map(record);
  }
  get(id: string) {
    const row = this.db
      .query("SELECT * FROM schedules WHERE id=?")
      .get(id) as Row | null;
    return row && record(row);
  }
  create(agentId: string, input: Record<string, unknown>) {
    const { cron, prompt, enabled = true, once = false } = scheduleInput(input);
    const count = this.db
      .query("SELECT COUNT(*) AS n FROM schedules WHERE agentId=?")
      .get(agentId) as { n: number };
    if (count.n >= MAX_SCHEDULES_PER_AGENT)
      throw new HttpError(
        409,
        `An agent can have at most ${MAX_SCHEDULES_PER_AGENT} schedules.`,
      );
    const id = crypto.randomUUID();
    this.db
      .query(
        "INSERT INTO schedules (id,agentId,cron,prompt,enabled,once,nextRunAt,createdAt) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        agentId,
        cron!,
        prompt!,
        enabled ? 1 : 0,
        once ? 1 : 0,
        nextRun(cron!, this.now()),
        new Date().toISOString(),
      );
    return this.get(id)!;
  }
  update(id: string, input: Record<string, unknown>) {
    const existing = this.get(id);
    if (!existing) throw new HttpError(404, "Schedule not found.");
    const changes = scheduleInput(input, true);
    const cron = changes.cron ?? existing.cron;
    this.db
      .query(
        "UPDATE schedules SET cron=?,prompt=?,enabled=?,once=?,nextRunAt=?,lastError=? WHERE id=?",
      )
      .run(
        cron,
        changes.prompt ?? existing.prompt,
        (changes.enabled ?? existing.enabled) ? 1 : 0,
        (changes.once ?? existing.once) ? 1 : 0,
        nextRun(cron, this.now()),
        null,
        id,
      );
    return this.get(id)!;
  }
  remove(id: string) {
    if (!this.db.query("DELETE FROM schedules WHERE id=?").run(id).changes)
      throw new HttpError(404, "Schedule not found.");
  }
  start(intervalMs = 15_000) {
    // Skip times missed while Jelly was stopped rather than replaying them.
    // A missed one-time schedule pauses with a visible reason instead.
    const now = this.now();
    for (const row of this.db
      .query("SELECT id,cron,once,enabled FROM schedules WHERE nextRunAt<=?")
      .all(now.toISOString()) as Row[])
      if (row.once && row.enabled)
        this.db
          .query("UPDATE schedules SET enabled=0,lastError=? WHERE id=?")
          .run("Missed while Jelly was stopped.", row.id);
      else
        this.db
          .query("UPDATE schedules SET nextRunAt=? WHERE id=?")
          .run(nextRun(row.cron, now), row.id);
    this.timer = setInterval(() => this.tick(), intervalMs);
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
  tick() {
    const now = this.now();
    const due = this.db
      .query(
        `SELECT s.* FROM schedules s JOIN agents a ON a.id=s.agentId
        WHERE s.enabled=1 AND a.archivedAt IS NULL AND s.nextRunAt<=? ORDER BY s.nextRunAt`,
      )
      .all(now.toISOString()) as Row[];
    for (const schedule of due) {
      let error: string | null = null;
      // At most one queued copy: a slow agent should not accumulate a backlog.
      const queued = this.db
        .query(
          "SELECT 1 FROM pending_messages WHERE agentId=? AND status='pending' AND id LIKE ?",
        )
        .get(schedule.agentId, `schedule:${schedule.id}:%`);
      if (queued)
        error = "Skipped: the previous scheduled message is still queued.";
      else
        try {
          this.send(
            schedule.agentId,
            `schedule:${schedule.id}:${schedule.nextRunAt}`,
            schedule.prompt,
          );
        } catch (e) {
          error = (e as Error).message;
        }
      // A one-time schedule keeps its due time as a record and pauses.
      this.db
        .query(
          "UPDATE schedules SET nextRunAt=?,lastRunAt=?,lastError=?,enabled=? WHERE id=?",
        )
        .run(
          schedule.once ? schedule.nextRunAt : nextRun(schedule.cron, now),
          now.toISOString(),
          error,
          schedule.once ? 0 : 1,
          schedule.id,
        );
    }
  }
}
