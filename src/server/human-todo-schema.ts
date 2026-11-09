import type { Database } from "bun:sqlite";

export function migrateHumanTodos(db: Database) {
  db.exec(`
    CREATE TABLE human_todos (
      id TEXT PRIMARY KEY, agentId TEXT REFERENCES agents(id), status TEXT NOT NULL,
      blocking INTEGER NOT NULL, createdAt TEXT NOT NULL, resolvedAt TEXT,
      deletedAt TEXT, record TEXT NOT NULL CHECK(json_valid(record))
    );
    CREATE INDEX idx_human_todos_open ON human_todos(status,blocking DESC,createdAt,id) WHERE deletedAt IS NULL;
    CREATE INDEX idx_human_todos_agent ON human_todos(agentId,status,deletedAt);
    CREATE INDEX idx_human_todos_history ON human_todos(resolvedAt DESC,id DESC) WHERE deletedAt IS NULL;
    CREATE TABLE human_todo_mutations (
      scope TEXT NOT NULL, requestId TEXT NOT NULL, todoId TEXT NOT NULL REFERENCES human_todos(id),
      payload TEXT NOT NULL, receipt TEXT NOT NULL, audit TEXT NOT NULL, PRIMARY KEY(scope,requestId)
    );
    CREATE INDEX idx_human_todo_audit ON human_todo_mutations(todoId);
    CREATE TABLE human_todo_dedupe (
      agentId TEXT NOT NULL REFERENCES agents(id), key TEXT NOT NULL, payload TEXT NOT NULL,
      receipt TEXT NOT NULL, PRIMARY KEY(agentId,key)
    );
    CREATE TABLE human_todo_deliveries (
      id TEXT PRIMARY KEY, todoId TEXT NOT NULL REFERENCES human_todos(id), completionId TEXT NOT NULL,
      agentId TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL, runId TEXT UNIQUE REFERENCES runs(id),
      record TEXT NOT NULL CHECK(json_valid(record))
    );
    CREATE INDEX idx_human_todo_deliveries_pending ON human_todo_deliveries(state,agentId);
    CREATE UNIQUE INDEX idx_human_todo_completion_delivery ON human_todo_deliveries(completionId)
      WHERE state IN ('waiting','needs_retry','admitted');
    DROP INDEX IF EXISTS idx_timeline_notifications;
    PRAGMA user_version=20;
  `);
}

/** v21: collapse instructions/reason/criteria into one free-form body and drop
 * the blocking flag. Text is preserved verbatim under short headings. */
export function mergeLegacyTodoText(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const part = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const instructions = part(record.instructions),
    reason = part(record.reason),
    criteria = part(record.criteria);
  const body =
    typeof record.body === "string"
      ? record.body
      : [
          instructions,
          reason && (instructions || criteria ? `Why: ${reason}` : reason),
          criteria && `Done when: ${criteria}`,
        ]
          .filter(Boolean)
          .join("\n\n");
  const {
    instructions: _i,
    reason: _r,
    criteria: _c,
    blocking: _b,
    ...rest
  } = record;
  return { ...rest, body };
}
export function migrateHumanTodoBody(db: Database) {
  const todos = db.query("SELECT id, record FROM human_todos").all() as {
    id: string;
    record: string;
  }[];
  const update = db.query("UPDATE human_todos SET record=? WHERE id=?");
  for (const row of todos)
    update.run(JSON.stringify(mergeLegacyTodoText(JSON.parse(row.record))), row.id);
  const deliveries = db
    .query("SELECT id, record FROM human_todo_deliveries")
    .all() as { id: string; record: string }[];
  const updateDelivery = db.query(
    "UPDATE human_todo_deliveries SET record=? WHERE id=?",
  );
  for (const row of deliveries) {
    const delivery = JSON.parse(row.record);
    delivery.snapshot = mergeLegacyTodoText(delivery.snapshot ?? {});
    updateDelivery.run(JSON.stringify(delivery), row.id);
  }
  db.exec(`
    DROP INDEX IF EXISTS idx_human_todos_open;
    ALTER TABLE human_todos DROP COLUMN blocking;
    CREATE INDEX idx_human_todos_open ON human_todos(status,createdAt DESC,id DESC) WHERE deletedAt IS NULL;
    PRAGMA user_version=21;
  `);
}
