import type { Database } from "bun:sqlite";

/** Synthetic legacy fixtures start from today's schema, then remove later features.
 * Never use this on an instance database: it exists only to construct migration tests. */
export function removePostV16SchemaForLegacyFixture(db: Database) {
  removePostV19SchemaForLegacyFixture(db);
  db.exec(`
    DROP TABLE goal_compactions;
    DROP TABLE goal_usage;
    DROP TABLE goal_runs;
    DROP TABLE goal_mutations;
    DROP TABLE agent_goals;
    DROP TABLE schedule_mutations;
    DROP TABLE schedule_occurrences;
    DROP TABLE agent_schedules;
    DROP TABLE schedule_timezones;
    ALTER TABLE pending_messages DROP COLUMN timezone;
    ALTER TABLE messages DROP COLUMN source;
    ALTER TABLE runs DROP COLUMN source;
  `);
}

export function removePostV19SchemaForLegacyFixture(db: Database) {
  db.exec("DROP TABLE human_todo_mutations; DROP TABLE human_todo_deliveries; DROP TABLE human_todo_dedupe; DROP TABLE human_todos;");
}
