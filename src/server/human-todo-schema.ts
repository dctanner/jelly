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
