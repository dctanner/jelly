import type { Activity } from "../shared/types";
import type {
  AgentSchedule,
  ScheduleOccurrence,
  ScheduleReceipt,
  OccurrencesPage,
  ScheduleSource,
  SchedulesPage,
  ScheduleReasonCode,
  ScheduleDelay,
} from "../shared/schedules";
import { Store } from "./store";
import { HttpError } from "./errors";
import {
  cronInstant,
  previewSchedule,
  timezone,
  validateSchedule,
} from "./schedule-timing";

const iso = (now: number) => new Date(now).toISOString();
const canonical = (value: unknown): string =>
  JSON.stringify(value, function (_key, val) {
    return val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val).sort(([a], [b]) => a.localeCompare(b)),
        )
      : val;
  });
export const SCHEDULE_NOTICE =
  "Runs here using current agent settings while Jelly is running. Cannot wake a sleeping host or promise exact delivery time. No automatic replay after admission. Pause/cancel only cancels unstarted work; Stop is separate. Cron uses day-of-month OR day-of-week when both are restricted; DST gaps skip and repeated local times run once, at the first instant.";
function policyNotice(
  policy: Pick<AgentSchedule, "catchUp" | "maxLatenessSeconds">,
) {
  return `${SCHEDULE_NOTICE} After downtime: ${policy.catchUp === "latest" ? "deliver at most the latest missed occurrence" : "skip missed occurrences"}. All unstarted work, including busy/capacity/provider-blocked work, expires after ${policy.maxLatenessSeconds} seconds of lateness.`;
}
export class Schedules {
  constructor(
    readonly store: Store,
    readonly now: () => number = Date.now,
    readonly notify: (event: Activity) => void = () => {},
  ) {}
  private agent(agentId: string) {
    const agent = this.store.agent(agentId);
    if (!agent) throw new HttpError(404, "Agent not found.");
    return agent;
  }
  private key(value: unknown) {
    if (typeof value !== "string" || !value.trim() || value.length > 100)
      throw new HttpError(
        400,
        "A stable requestId (1–100 characters) is required.",
      );
    return value;
  }
  get(agentId: string, id: string): AgentSchedule {
    this.agent(agentId);
    const row = this.store.db
      .query("SELECT * FROM agent_schedules WHERE id=? AND agentId=?")
      .get(id, agentId) as AgentSchedule | null;
    if (!row) throw new HttpError(404, "Schedule not found for this agent.");
    return row;
  }
  list(
    agentId: string,
    query: { before?: string; limit?: number; state?: string } = {},
  ): SchedulesPage {
    this.agent(agentId);
    const limit = query.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new HttpError(400, "Schedule list limit must be 1–100.");
    if (
      query.state !== undefined &&
      !["active", "paused", "terminal"].includes(query.state)
    )
      throw new HttpError(400, "Invalid schedule state filter.");
    const cursor = this.cursor(query.before);
    const stateFilter =
      query.state === "terminal"
        ? " AND state IN ('completed','cancelled','expired')"
        : query.state
          ? " AND state=?"
          : "";
    const rows = this.store.db
      .query(
        `SELECT * FROM agent_schedules WHERE agentId=? AND (createdAt,id)<(?,?)${stateFilter} ORDER BY createdAt DESC,id DESC LIMIT ?`,
      )
      .all(
        agentId,
        ...cursor,
        ...(query.state && query.state !== "terminal" ? [query.state] : []),
        limit + 1,
      ) as AgentSchedule[];
    const summary = this.store.db
      .query(
        "SELECT count(*) AS activeCount,min(nextRunAt) AS nextRunAt FROM agent_schedules WHERE agentId=? AND state='active'",
      )
      .get(agentId) as { activeCount: number; nextRunAt: string | null };
    const items = rows.slice(0, limit).map((row) => this.receipt(row));
    const last = items.at(-1)?.schedule;
    return {
      ...summary,
      items,
      before:
        rows.length > limit && last
          ? this.encodeCursor(last.createdAt, last.id)
          : null,
    };
  }
  private encodeCursor(time: string, id: string) {
    return Buffer.from(JSON.stringify([time, id])).toString("base64url");
  }
  private cursor(before?: string): [string, string] {
    if (!before) return ["9999", ""];
    let cursor: unknown;
    try {
      if (before.length > 400) throw new Error();
      cursor = JSON.parse(Buffer.from(before, "base64url").toString());
    } catch {
      throw new HttpError(400, "Invalid schedule history cursor.");
    }
    if (
      !Array.isArray(cursor) ||
      cursor.length !== 2 ||
      cursor.some((value) => typeof value !== "string" || value.length > 100)
    )
      throw new HttpError(400, "Invalid schedule history cursor.");
    return cursor as [string, string];
  }
  receipt(schedule: AgentSchedule): ScheduleReceipt {
    const latest =
      this.occurrences(schedule.agentId, schedule.id, undefined, 1).items[0] ??
      null;
    const running = this.store.db
      .query(
        "SELECT runId FROM schedule_occurrences WHERE scheduleId=? AND state='running'",
      )
      .get(schedule.id) as { runId: string } | null;
    return {
      schedule,
      preview:
        schedule.state === "active" && schedule.nextRunAt
          ? previewSchedule(schedule, Date.parse(schedule.nextRunAt) - 1)
          : [],
      latest,
      runningRunId: running?.runId ?? null,
      notice: policyNotice(schedule),
    };
  }
  preview(input: Record<string, unknown>) {
    const value = validateSchedule(input, this.now());
    return {
      ...value,
      preview: previewSchedule(
        { ...value, runAt: value.runAt ?? null, cron: value.cron ?? null },
        this.now(),
      ),
      notice: policyNotice(value),
      dayMatching:
        "Day-of-month OR day-of-week when both are restricted. DST gaps skipped; repeated local times run once, at the first instant.",
    };
  }
  private mutation(
    agentId: string,
    requestId: unknown,
    payload: unknown,
    runId: string | null,
    originalRequestId: string | undefined,
    apply: () => AgentSchedule,
  ) {
    this.agent(agentId);
    const key = this.key(requestId),
      encoded = canonical(payload);
    let event: Activity | undefined;
    const receipt = this.store.db.transaction(() => {
      const prior = this.store.db
        .query(
          "SELECT payload,response FROM schedule_mutations WHERE agentId=? AND requestId=?",
        )
        .get(agentId, key) as { payload: string; response: string } | null;
      if (prior) {
        if (prior.payload !== encoded)
          throw new HttpError(
            409,
            "This schedule request ID was already used with a different payload.",
          );
        return JSON.parse(prior.response) as ScheduleReceipt;
      }
      const origin = runId
        ? (this.store.db
            .query("SELECT requestId FROM runs WHERE id=? AND agentId=?")
            .get(runId, agentId) as { requestId: string } | null)
        : null;
      const originatingRequestId =
        originalRequestId ?? origin?.requestId ?? key;
      const schedule = apply();
      const response = this.receipt(schedule);
      this.store.db
        .query(
          "INSERT INTO schedule_mutations (agentId,requestId,payload,response,runId,createdAt,originalRequestId) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          agentId,
          key,
          encoded,
          JSON.stringify(response),
          runId,
          iso(this.now()),
          originatingRequestId,
        );
      event = this.store.event(agentId, runId, "schedule_changed", {
        scheduleId: schedule.id,
        originalRequestId: originatingRequestId,
        revision: schedule.revision,
        state: schedule.state,
        title: schedule.title,
        runningRunId: response.runningRunId,
        timing: schedule.cron ?? schedule.runAt,
        timezone: schedule.timezone,
        nextRunAt: schedule.nextRunAt,
        catchUp: schedule.catchUp,
        maxLatenessSeconds: schedule.maxLatenessSeconds,
        storedPrompt: schedule.prompt,
        preview: response.preview,
      });
      return response;
    })();
    if (event) this.notify(event);
    return receipt;
  }
  create(
    agentId: string,
    input: Record<string, unknown>,
    runId: string | null = null,
    originalRequestId?: string,
  ) {
    return this.mutation(
      agentId,
      input.requestId,
      { action: "create", input },
      runId,
      originalRequestId,
      () => {
        if (this.agent(agentId).archivedAt)
          throw new HttpError(
            409,
            "Restore the agent before creating schedules.",
          );
        const count = this.store.db
          .query(
            "SELECT count(*) AS n FROM agent_schedules WHERE agentId=? AND state IN ('active','paused')",
          )
          .get(agentId) as { n: number };
        const total = this.store.db
          .query(
            "SELECT count(*) AS n FROM agent_schedules WHERE state IN ('active','paused')",
          )
          .get() as { n: number };
        if (count.n >= 100 || total.n >= 1000)
          throw new HttpError(
            409,
            "Schedule limit reached (100 active/paused per agent; 1000 active/paused per instance).",
          );
        const value = validateSchedule(input, this.now()),
          now = iso(this.now());
        const id = `sch_${crypto.randomUUID()}`;
        const origin = runId
          ? (this.store.db
              .query("SELECT requestId FROM runs WHERE id=? AND agentId=?")
              .get(runId, agentId) as { requestId: string } | null)
          : null;
        this.store.db
          .query(
            `INSERT INTO agent_schedules
        (id,agentId,title,prompt,revision,kind,runAt,cron,timezone,catchUp,maxLatenessSeconds,state,nextRunAt,createdAt,updatedAt,createdByRunId,updatedByRunId,originalRequestId)
        VALUES (?,?,?,?,1,?,?,?,?,?,?,'active',?,?,?,?,?,?)`,
          )
          .run(
            id,
            agentId,
            value.title,
            value.prompt,
            value.kind,
            value.runAt ?? null,
            value.cron ?? null,
            value.timezone,
            value.catchUp,
            value.maxLatenessSeconds,
            value.kind === "once"
              ? value.runAt
              : cronInstant(value.cron, value.timezone, this.now()),
            now,
            now,
            runId,
            runId,
            originalRequestId ?? origin?.requestId ?? String(input.requestId),
          );
        return this.get(agentId, id);
      },
    );
  }
  change(
    agentId: string,
    id: string,
    action: "update" | "pause" | "resume" | "cancel",
    input: Record<string, unknown>,
    runId: string | null = null,
    originalRequestId?: string,
  ) {
    return this.mutation(
      agentId,
      input.requestId,
      { id, action, input },
      runId,
      originalRequestId,
      () => {
        const old = this.get(agentId, id);
        if (
          !Number.isSafeInteger(input.expectedRevision) ||
          input.expectedRevision !== old.revision
        )
          throw new HttpError(
            409,
            "Schedule changed. Reload it and use its current revision.",
          );
        if (["cancelled", "completed", "expired"].includes(old.state)) {
          const running = this.store.db
            .query(
              "SELECT id FROM schedule_occurrences WHERE scheduleId=? AND state='running'",
            )
            .get(id);
          throw new HttpError(
            409,
            running
              ? "This one-off was already admitted and continues. Use Stop separately; it will not be automatically replayed."
              : "This schedule is terminal; create a new schedule instead.",
          );
        }
        if (
          (action === "resume" && old.state === "active") ||
          (action === "pause" && old.state === "paused")
        )
          return old;
        if (
          (action === "resume" || action === "update") &&
          this.agent(agentId).archivedAt
        )
          throw new HttpError(
            409,
            "Restore the agent first; schedules remain paused until resumed.",
          );
        let next = { ...old };
        if (action === "update") {
          const merged = { ...old, ...input };
          if (input.kind === "once") merged.cron = null;
          if (input.kind === "cron") merged.runAt = null;
          const value = validateSchedule(merged, this.now());
          next = {
            ...next,
            ...value,
            runAt: value.runAt ?? null,
            cron: value.cron ?? null,
          };
        }
        if (action === "resume") {
          if (old.kind === "once" && Date.parse(old.runAt!) <= this.now())
            throw new HttpError(
              409,
              "Edit this overdue one-off to a new future time before resuming.",
            );
          next.state = "active";
        } else if (action === "pause") next.state = "paused";
        else if (action === "cancel") next.state = "cancelled";
        next.nextRunAt =
          next.state === "active"
            ? next.kind === "once"
              ? next.runAt
              : cronInstant(next.cron!, next.timezone, this.now())
            : null;
        next.reason =
          action === "pause" || action === "cancel" ? `User ${action}` : null;
        this.cancelPending(old.agentId, `Schedule ${action}`, {
          scheduleId: old.id,
          reasonCode: (
            {
              update: "updated",
              pause: "paused",
              resume: "resumed",
              cancel: "cancelled",
            } as const
          )[action],
        });
        this.store.db
          .query(
            `UPDATE agent_schedules SET title=?,prompt=?,revision=revision+1,kind=?,runAt=?,cron=?,timezone=?,catchUp=?,maxLatenessSeconds=?,state=?,reason=?,nextRunAt=?,updatedAt=?,updatedByRunId=?,lastDispatchError=NULL,retryAt=NULL WHERE id=?`,
          )
          .run(
            next.title,
            next.prompt,
            next.kind,
            next.runAt,
            next.cron,
            next.timezone,
            next.catchUp,
            next.maxLatenessSeconds,
            next.state,
            next.reason,
            next.nextRunAt,
            iso(this.now()),
            runId,
            id,
          );
        return this.get(agentId, id);
      },
    );
  }
  occurrence(id: string) {
    const row = this.store.db
      .query("SELECT * FROM schedule_occurrences WHERE id=?")
      .get(id) as
      | (Omit<ScheduleOccurrence, "snapshot" | "delays"> & {
          snapshot: string;
          delays: string;
        })
      | null;
    return row
      ? ({
          ...row,
          snapshot: JSON.parse(row.snapshot),
          delays: JSON.parse(row.delays),
        } as ScheduleOccurrence)
      : null;
  }
  occurrences(
    agentId: string,
    id: string,
    before?: string,
    limit = 30,
  ): OccurrencesPage {
    this.get(agentId, id);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new HttpError(400, "Invalid history limit.");
    const cursor = this.cursor(before);
    const rows = this.store.db
      .query(
        "SELECT id FROM schedule_occurrences WHERE scheduleId=? AND (scheduledFor,id)<(?,?) ORDER BY scheduledFor DESC,id DESC LIMIT ?",
      )
      .all(id, ...cursor, limit + 1) as { id: string }[];
    const items = rows.slice(0, limit).map((row) => this.occurrence(row.id)!);
    const last = items.at(-1);
    return {
      items,
      before:
        rows.length > limit && last
          ? this.encodeCursor(last.scheduledFor, last.id)
          : null,
    };
  }
  cancelPending(
    agentId: string,
    reason: string,
    options: {
      scheduleId?: string;
      consumeOnce?: boolean;
      reasonCode: ScheduleReasonCode;
    },
  ) {
    const { scheduleId, consumeOnce = true, reasonCode } = options;
    this.store.db
      .query(
        `UPDATE schedule_occurrences SET state='cancelled',reason=?,reasonCode=?,finishedAt=? WHERE agentId=? AND state='pending'${scheduleId ? " AND scheduleId=?" : ""}`,
      )
      .run(
        reason,
        reasonCode,
        iso(this.now()),
        agentId,
        ...(scheduleId ? [scheduleId] : []),
      );
    // A consumed one-off cannot become eligible again after Stop.
    if (!scheduleId && consumeOnce)
      this.store.db
        .query(
          "UPDATE agent_schedules SET state='completed',reason=?,updatedAt=? WHERE agentId=? AND kind='once' AND state='active' AND nextRunAt IS NULL",
        )
        .run(reason, iso(this.now()), agentId);
  }
  stopAgent(agentId: string) {
    this.cancelPending(
      agentId,
      "Agent stopped; future cron ticks remain enabled",
      { reasonCode: "stopped" },
    );
    const now = this.now();
    const due = this.store.db
      .query(
        "SELECT * FROM agent_schedules WHERE agentId=? AND state='active' AND nextRunAt<=?",
      )
      .all(agentId, iso(now)) as AgentSchedule[];
    for (const schedule of due) {
      const id = `occ_${crypto.randomUUID()}`;
      this.store.db
        .query(
          `INSERT OR IGNORE INTO schedule_occurrences (id,scheduleId,scheduleRevision,agentId,scheduledFor,snapshot,state,requestId,wakeReason,reason,reasonCode,finishedAt)
        VALUES (?,?,?,?,?,?,'cancelled',?,'scheduled execution','Agent stopped before admission','stopped',?)`,
        )
        .run(
          id,
          schedule.id,
          schedule.revision,
          agentId,
          schedule.nextRunAt!,
          JSON.stringify(schedule),
          `schedule:${id}`,
          iso(now),
        );
      this.store.db
        .query(
          "UPDATE agent_schedules SET nextRunAt=?,state=?,updatedAt=? WHERE id=?",
        )
        .run(
          schedule.kind === "cron"
            ? cronInstant(schedule.cron!, schedule.timezone, now)
            : null,
          schedule.kind === "once" ? "completed" : "active",
          iso(now),
          schedule.id,
        );
    }
  }
  /** Called inside the archive transaction; restoring deliberately does nothing. */
  pauseAgent(agentId: string) {
    this.cancelPending(agentId, "Agent archived", {
      consumeOnce: false,
      reasonCode: "archived",
    });
    this.store.db
      .query(
        "UPDATE agent_schedules SET state='paused',reason='Agent archived',revision=revision+1,nextRunAt=NULL,updatedAt=? WHERE agentId=? AND state='active'",
      )
      .run(iso(this.now()), agentId);
  }
  suggestedTimezone(agentId: string) {
    const row = this.store.db
      .query(
        "SELECT timezone FROM schedule_timezones WHERE scope IN (?, 'instance') ORDER BY scope='instance' LIMIT 1",
      )
      .get(agentId) as { timezone: string } | null;
    return row?.timezone ?? null;
  }
  saveTimezone(scope: string, value: unknown) {
    const zone = timezone(value);
    this.store.db
      .query(
        "INSERT INTO schedule_timezones VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET timezone=excluded.timezone",
      )
      .run(scope, zone);
    return { timezone: zone };
  }
  due(now: number, missedThrough: number | null, limit: number) {
    const notices: Activity[] = [];
    this.store.db.transaction(() => {
      const rows = this.store.db
        .query(
          "SELECT * FROM agent_schedules WHERE state='active' AND nextRunAt<=? ORDER BY nextRunAt,id LIMIT ?",
        )
        .all(iso(now), limit) as AgentSchedule[];
      for (const schedule of rows) {
        const first = schedule.nextRunAt!;
        const scheduledFor =
          schedule.kind === "once"
            ? first
            : cronInstant(schedule.cron!, schedule.timezone, now + 1, "prev");
        const downtime =
          missedThrough !== null && Date.parse(scheduledFor) <= missedThrough;
        const outstanding = this.store.db
          .query(
            "SELECT id FROM schedule_occurrences WHERE scheduleId=? AND state IN ('pending','running')",
          )
          .get(schedule.id);
        const late =
          now - Date.parse(scheduledFor) > schedule.maxLatenessSeconds * 1000;
        const skip = outstanding
          ? "Skipped later ticks: an occurrence is already pending or running"
          : downtime && schedule.catchUp === "none"
            ? "Skipped downtime: catch-up disabled"
            : late
              ? "Lateness deadline exceeded"
              : null;
        const reasonCode = outstanding
          ? "overlap"
          : downtime && schedule.catchUp === "none"
            ? "downtime"
            : late
              ? "lateness"
              : null;
        const state = skip
          ? schedule.kind === "once" && !outstanding
            ? "expired"
            : "skipped"
          : "pending";
        const id = `occ_${crypto.randomUUID()}`;
        this.store.db
          .query(
            `INSERT OR IGNORE INTO schedule_occurrences
          (id,scheduleId,scheduleRevision,agentId,scheduledFor,snapshot,state,requestId,wakeReason,reason,reasonCode,finishedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            schedule.id,
            schedule.revision,
            schedule.agentId,
            scheduledFor,
            JSON.stringify(schedule),
            state,
            `schedule:${id}`,
            downtime
              ? "scheduled execution; latest missed occurrence after downtime"
              : "scheduled execution",
            skip,
            reasonCode,
            skip ? iso(now) : null,
          );
        this.store.db
          .query(
            "UPDATE agent_schedules SET nextRunAt=?,state=?,reason=?,updatedAt=? WHERE id=?",
          )
          .run(
            schedule.kind === "cron"
              ? cronInstant(schedule.cron!, schedule.timezone, now)
              : null,
            state === "expired" ? "expired" : "active",
            state === "expired" ? skip : null,
            iso(now),
            schedule.id,
          );
        if (skip || first !== scheduledFor)
          notices.push(
            this.store.event(
              schedule.agentId,
              null,
              state === "expired" ? "schedule_expired" : "schedule_skipped",
              {
                scheduleId: schedule.id,
                title: schedule.title,
                from: first,
                through: scheduledFor,
                reason: skip ?? "Coalesced missed ticks to latest occurrence",
                reasonCode: reasonCode ?? "coalesced",
                occurrenceId: id,
              },
            ),
          );
      }
    })();
    for (const event of notices) this.notify(event);
  }
  noteWaiting(id: string, reason: ScheduleDelay) {
    this.store.db
      .query(
        `UPDATE schedule_occurrences SET delays=json_insert(delays,'$[#]',?)
      WHERE id=? AND state='pending' AND NOT EXISTS(SELECT 1 FROM json_each(delays) WHERE value=?)`,
      )
      .run(reason, id, reason);
  }
  noteBusy(limit: number) {
    this.store.db
      .query(
        `UPDATE schedule_occurrences SET delays=json_insert(delays,'$[#]','busy') WHERE id IN (
      SELECT o.id FROM schedule_occurrences o WHERE o.state='pending'
      AND NOT EXISTS(SELECT 1 FROM json_each(o.delays) WHERE value='busy')
      AND (EXISTS(SELECT 1 FROM runs WHERE agentId=o.agentId AND status='running')
        OR EXISTS(SELECT 1 FROM pending_messages WHERE agentId=o.agentId AND status='pending'))
      ORDER BY o.scheduledFor,o.id LIMIT ?)`,
      )
      .run(limit);
  }
  pending(limit: number, expiring = false) {
    const now = iso(this.now());
    return (
      this.store.db
        .query(
          `SELECT o.id FROM schedule_occurrences o WHERE o.state='pending' AND ${
            expiring
              ? "julianday(o.scheduledFor) + json_extract(o.snapshot,'$.maxLatenessSeconds')/86400.0 < julianday(?)"
              : `(o.retryAt IS NULL OR o.retryAt<=?) AND NOT EXISTS(SELECT 1 FROM runs WHERE agentId=o.agentId AND status='running')
         AND NOT EXISTS(SELECT 1 FROM pending_messages WHERE agentId=o.agentId AND status='pending')`
          }
      ORDER BY o.scheduledFor,o.id LIMIT ?`,
        )
        .all(now, limit) as { id: string }[]
    ).map((row) => this.occurrence(row.id)!);
  }
  expire(
    occurrence: ScheduleOccurrence,
    reason = "Lateness deadline exceeded",
    reasonCode: ScheduleReasonCode = "lateness",
  ) {
    let event: Activity | undefined;
    this.store.db.transaction(() => {
      const changed = this.store.db
        .query(
          "UPDATE schedule_occurrences SET state='expired',reason=?,reasonCode=?,finishedAt=? WHERE id=? AND state='pending'",
        )
        .run(reason, reasonCode, iso(this.now()), occurrence.id).changes;
      if (!changed) return;
      this.store.db
        .query(
          "UPDATE agent_schedules SET state='expired',reason=?,updatedAt=? WHERE id=? AND kind='once' AND state='active'",
        )
        .run(reason, iso(this.now()), occurrence.scheduleId);
      event = this.store.event(occurrence.agentId, null, "schedule_expired", {
        scheduleId: occurrence.scheduleId,
        title: occurrence.snapshot.title,
        reason,
        reasonCode,
      });
    })();
    if (event) this.notify(event);
  }
  blocked(occurrence: ScheduleOccurrence, error: unknown) {
    const reason =
      error instanceof Error ? error.message : "Schedule delivery is blocked.";
    const attempts = occurrence.attempts + 1;
    const retryAt = iso(
      this.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(attempts - 1, 7)),
    );
    let event: Activity | undefined;
    this.store.db.transaction(() => {
      const changed = this.store.db
        .query(
          "UPDATE schedule_occurrences SET reason=?,reasonCode='delivery',attempts=?,retryAt=? WHERE id=? AND state='pending'",
        )
        .run(reason, attempts, retryAt, occurrence.id).changes;
      if (!changed) return;
      this.noteWaiting(occurrence.id, "delivery");
      this.store.db
        .query(
          "UPDATE agent_schedules SET lastDispatchError=?,retryAt=? WHERE id=?",
        )
        .run(reason, retryAt, occurrence.scheduleId);
      if (occurrence.reason !== reason)
        event = this.store.event(occurrence.agentId, null, "schedule_blocked", {
          scheduleId: occurrence.scheduleId,
          title: occurrence.snapshot.title,
          reason,
          reasonCode: "delivery",
          retryAt,
        });
    })();
    if (event) this.notify(event);
  }
  recover() {
    this.store.db.transaction(() => {
      this.store.db
        .exec(`UPDATE schedule_occurrences SET state=(SELECT status FROM runs WHERE id=runId),
        finishedAt=(SELECT endedAt FROM runs WHERE id=runId),reason=(SELECT error FROM runs WHERE id=runId),
        reasonCode=(SELECT CASE WHEN status='completed' THEN NULL ELSE status END FROM runs WHERE id=runId)
        WHERE runId IS NOT NULL AND state='running' AND (SELECT status FROM runs WHERE id=runId)!='running';
        UPDATE agent_schedules SET state='completed',nextRunAt=NULL WHERE kind='once' AND state='active'
        AND EXISTS(SELECT 1 FROM schedule_occurrences WHERE scheduleId=agent_schedules.id AND runId IS NOT NULL);`);
      for (const agent of this.store.db
        .query("SELECT id FROM agents WHERE archivedAt IS NOT NULL")
        .all() as { id: string }[])
        this.pauseAgent(agent.id);
    })();
  }
  /** Must run inside the same transaction as the normal run/message writes. */
  admit(id: string, runId: string, source: ScheduleSource) {
    const occurrence = this.occurrence(id);
    if (!occurrence || occurrence.state !== "pending")
      throw new HttpError(409, "Occurrence is no longer pending.");
    const schedule = this.get(occurrence.agentId, occurrence.scheduleId);
    if (
      schedule.state !== "active" ||
      schedule.revision !== occurrence.scheduleRevision ||
      this.agent(occurrence.agentId).archivedAt ||
      this.now() - Date.parse(occurrence.scheduledFor) >
        schedule.maxLatenessSeconds * 1000
    )
      throw new HttpError(409, "Schedule is no longer eligible.");
    this.store.db
      .query(
        "UPDATE schedule_occurrences SET state='running',runId=?,admittedAt=?,wakeReason=?,reason=NULL,reasonCode=NULL,retryAt=NULL WHERE id=?",
      )
      .run(runId, source.admittedAt, source.wakeReason, id);
    this.store.db
      .query(
        "UPDATE agent_schedules SET state=CASE WHEN kind='once' THEN 'completed' ELSE state END,lastDispatchError=NULL,retryAt=NULL WHERE id=?",
      )
      .run(schedule.id);
  }
}

export function scheduledWake(
  occurrence: ScheduleOccurrence,
  admittedAt: string,
): { text: string; source: ScheduleSource } {
  const schedule = occurrence.snapshot;
  const delays = occurrence.delays.map(
    (reason) =>
      ({
        busy: "the agent was busy or interactive messages were queued",
        capacity: "scheduled-run capacity was unavailable",
        delivery: "pre-admission delivery was blocked",
      })[reason],
  );
  const wakeReason = `${occurrence.wakeReason}${delays.length ? `; delayed because ${delays.join("; ")}` : occurrence.wakeReason === "scheduled execution" && Date.parse(admittedAt) - Date.parse(occurrence.scheduledFor) > 5000 ? "; delayed by scheduler availability" : ""}`;
  const source: ScheduleSource = {
    source: "schedule",
    scheduleId: schedule.id,
    occurrenceId: occurrence.id,
    scheduleRevision: occurrence.scheduleRevision,
    scheduledFor: occurrence.scheduledFor,
    admittedAt,
    wakeReason,
    delayReasons: occurrence.delays,
    taskSnapshot: schedule.prompt,
  };
  return {
    source,
    text: `[Automated scheduled wake — Jelly]\nYou were awakened automatically to execute a task previously scheduled by the user.\nThis is not a new live message from the user.\n\nSchedule: ${schedule.title} (${schedule.id})\nOccurrence: ${occurrence.id}\nTiming: ${schedule.cron ?? schedule.runAt}, ${schedule.timezone}\nScheduled for: ${occurrence.scheduledFor}\nStarted at: ${admittedAt}\nReason: ${wakeReason}\n\nExecute the stored task below now using your current conversation context.\nDo not schedule another copy merely because this wake occurred.\nNormal tool permissions and private handoff requirements still apply.\n\n--- Stored task ---\n${schedule.prompt}`,
  };
}
