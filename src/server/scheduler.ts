import type { ScheduleOccurrence } from "../shared/schedules";
import type { Schedules } from "./schedules";

/** In-process timer hints only: all work, cursor movement and admission are durable.
 * tick/admit are synchronous, so shutdown and user mutations cannot interleave. */
export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private lastTick: number | null = null;
  private missedThrough: number | null = null;
  constructor(
    readonly schedules: Schedules,
    readonly admit: (occurrence: ScheduleOccurrence) => boolean,
    readonly options: {
      concurrency?: number;
      batchSize?: number;
      pollMs?: number;
    } = {},
    private todoOpportunity: () => void = () => {},
  ) {
    for (const [key, value] of Object.entries(options))
      if (
        !Number.isInteger(value) ||
        value < (key === "pollMs" ? 1000 : 1) ||
        value > (key === "pollMs" ? 60_000 : key === "concurrency" ? 16 : 1000)
      )
        throw new Error(`Invalid scheduler ${key}`);
  }
  start() {
    if (!this.stopped) return;
    this.schedules.recover();
    this.lastTick = this.schedules.now();
    this.missedThrough = this.lastTick;
    this.stopped = false;
    this.timer = setInterval(
      () => this.safeTick(),
      this.options.pollMs ?? 5000,
    );
    this.wake();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.wakeTimer);
    this.timer = undefined;
    this.wakeTimer = undefined;
  }
  wake() {
    if (this.stopped || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.safeTick();
    }, 0);
  }
  private safeTick() {
    try {
      this.tick();
    } catch (error) {
      console.error(
        "Scheduler tick failed; durable work retained:",
        error instanceof Error ? error.message : "unknown error",
      );
    }
  }
  tick() {
    if (this.stopped) return;
    const now = this.schedules.now(),
      batch = this.options.batchSize ?? 100;
    const downtime =
      this.lastTick === null ||
      now - this.lastTick > Math.max(15_000, (this.options.pollMs ?? 5000) * 3);
    if (downtime) this.missedThrough = now;
    this.schedules.due(now, this.missedThrough, batch);
    this.schedules.noteBusy(batch);
    this.lastTick = now;
    // Expiration is independent of provider/capacity and therefore always advances.
    for (const occurrence of this.schedules.pending(batch, true))
      if (
        now - Date.parse(occurrence.scheduledFor) >
        occurrence.snapshot.maxLatenessSeconds * 1000
      )
        this.schedules.expire(occurrence);
    // Alternate admitted work, not timer ticks: settlement and its queued wake
    // can produce two ticks per run, otherwise starving the other backlog.
    const last = this.schedules.store.db.query(`SELECT json_extract(source,'$.source') AS source
      FROM runs WHERE json_extract(source,'$.source') IN ('schedule','human_todo')
      ORDER BY rowid DESC LIMIT 1`).get() as { source: string } | null;
    const todoFirst = last?.source !== "human_todo";
    if (todoFirst) this.todoOpportunity();
    let running = (
      this.schedules.store.db
        .query(
          "SELECT count(*) AS n FROM runs WHERE status='running' AND json_extract(source,'$.source') IN ('schedule','human_todo')",
        )
        .get() as { n: number }
    ).n;
    for (const occurrence of this.schedules.pending(batch)) {
      if (
        now - Date.parse(occurrence.scheduledFor) >
        occurrence.snapshot.maxLatenessSeconds * 1000
      ) {
        this.schedules.expire(occurrence);
        continue;
      }
      if (running >= (this.options.concurrency ?? 2)) {
        this.schedules.noteWaiting(occurrence.id, "capacity");
        continue;
      }
      if (occurrence.attempts >= 32) {
        this.schedules.expire(
          occurrence,
          "Safe delivery retry limit reached; no run was admitted",
          "retry_limit",
        );
        continue;
      }
      try {
        if (this.admit(occurrence)) running++;
      } catch (error) {
        this.schedules.blocked(occurrence, error);
      }
    }
    if (!todoFirst) this.todoOpportunity();
  }
}
