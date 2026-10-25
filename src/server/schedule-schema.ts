import type { Database } from "bun:sqlite";

export function migrateSchedules(db: Database) {
  db.exec(`
    CREATE TABLE agent_schedules (
      id TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id),
      title TEXT NOT NULL, prompt TEXT NOT NULL, revision INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('once','cron')), runAt TEXT, cron TEXT, timezone TEXT NOT NULL,
      catchUp TEXT NOT NULL CHECK(catchUp IN ('latest','none')), maxLatenessSeconds INTEGER NOT NULL CHECK(maxLatenessSeconds BETWEEN 60 AND 86400),
      state TEXT NOT NULL CHECK(state IN ('active','paused','completed','cancelled','expired')),
      reason TEXT, nextRunAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      createdByRunId TEXT REFERENCES runs(id), updatedByRunId TEXT REFERENCES runs(id), originalRequestId TEXT NOT NULL,
      lastDispatchError TEXT, retryAt TEXT,
      CHECK((kind='once' AND runAt IS NOT NULL AND cron IS NULL) OR (kind='cron' AND cron IS NOT NULL AND runAt IS NULL))
    );
    CREATE INDEX idx_schedules_due ON agent_schedules(nextRunAt,id) WHERE state='active';
    CREATE INDEX idx_schedules_agent ON agent_schedules(agentId,createdAt,id);
    CREATE INDEX idx_schedules_enabled_agent ON agent_schedules(agentId,state) WHERE state IN ('active','paused');
    CREATE TABLE schedule_occurrences (
      id TEXT PRIMARY KEY, scheduleId TEXT NOT NULL REFERENCES agent_schedules(id), scheduleRevision INTEGER NOT NULL,
      agentId TEXT NOT NULL REFERENCES agents(id), scheduledFor TEXT NOT NULL, snapshot TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed','cancelled','interrupted','skipped','expired')),
      requestId TEXT NOT NULL UNIQUE, runId TEXT UNIQUE REFERENCES runs(id), admittedAt TEXT, finishedAt TEXT,
      wakeReason TEXT NOT NULL, delays TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(delays)),
      reason TEXT, reasonCode TEXT, attempts INTEGER NOT NULL DEFAULT 0, retryAt TEXT,
      UNIQUE(scheduleId,scheduledFor)
    );
    CREATE UNIQUE INDEX idx_occurrence_outstanding ON schedule_occurrences(scheduleId) WHERE state IN ('pending','running');
    CREATE INDEX idx_occurrence_pending ON schedule_occurrences(scheduledFor,id) WHERE state='pending';
    CREATE INDEX idx_occurrence_history ON schedule_occurrences(scheduleId,scheduledFor DESC,id DESC);
    CREATE TABLE schedule_mutations (
      agentId TEXT NOT NULL REFERENCES agents(id), requestId TEXT NOT NULL, payload TEXT NOT NULL, response TEXT NOT NULL,
      runId TEXT REFERENCES runs(id), createdAt TEXT NOT NULL, originalRequestId TEXT NOT NULL, PRIMARY KEY(agentId,requestId)
    );
    CREATE TABLE schedule_timezones (scope TEXT PRIMARY KEY, timezone TEXT NOT NULL);
    ALTER TABLE pending_messages ADD COLUMN timezone TEXT;
    ALTER TABLE messages ADD COLUMN source TEXT;
    ALTER TABLE runs ADD COLUMN source TEXT;
    DROP INDEX IF EXISTS idx_timeline_notifications;
    PRAGMA user_version=17;
  `);
}
