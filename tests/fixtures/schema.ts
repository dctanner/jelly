import type { Database } from "bun:sqlite";

/** Synthetic legacy fixtures start from today's schema, then remove later features.
 * Never use this on an instance database: it exists only to construct migration tests. */
export function removeScheduleSchemaForLegacyFixture(db: Database) {
  db.exec(`
    DROP TABLE schedule_mutations;
    DROP TABLE schedule_occurrences;
    DROP TABLE agent_schedules;
    DROP TABLE schedule_timezones;
    ALTER TABLE pending_messages DROP COLUMN timezone;
    ALTER TABLE messages DROP COLUMN source;
    ALTER TABLE runs DROP COLUMN source;
  `);
}
