import type { Database } from "bun:sqlite";
export function migrateGoals(db: Database) {
  db.exec(`
    CREATE TABLE agent_goals (
      id TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id),
      current INTEGER NOT NULL CHECK(current IN (0,1)), record TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_current_goal ON agent_goals(agentId) WHERE current=1;
    CREATE TABLE goal_runs (
      runId TEXT PRIMARY KEY REFERENCES runs(id), goalId TEXT NOT NULL REFERENCES agent_goals(id),
      epoch INTEGER NOT NULL, snapshot TEXT NOT NULL,
      UNIQUE(goalId,epoch)
    );
    CREATE TABLE goal_usage (
      runId TEXT NOT NULL REFERENCES goal_runs(runId), entryId TEXT NOT NULL,
      tokens INTEGER NOT NULL CHECK(tokens>=0), usage TEXT NOT NULL,
      PRIMARY KEY(runId,entryId)
    );
    CREATE TABLE goal_mutations (
      agentId TEXT NOT NULL REFERENCES agents(id), requestId TEXT NOT NULL,
      payload TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(agentId,requestId)
    );
    PRAGMA user_version=18;
  `);
}

/** Keep old run snapshots, usage and receipts as historical evidence, never authority. */
export function migrateGoalCompactions(db: Database) {
  db.exec(`CREATE TABLE goal_compactions (
    runId TEXT NOT NULL REFERENCES goal_runs(runId), entryId TEXT NOT NULL,
    goalId TEXT NOT NULL REFERENCES agent_goals(id), epoch INTEGER NOT NULL,
    PRIMARY KEY(runId,entryId)
  );`);
  const rows = db.query("SELECT id,record FROM agent_goals").all() as {
    id: string;
    record: string;
  }[];
  for (const row of rows) {
    const goal = JSON.parse(row.record);
    delete goal.tokenBudget;
    delete goal.tokensUsed;
    delete goal.usageUnknown;
    goal.compactions = 0;
    if (["active", "budget_exhausted", "blocked"].includes(goal.state)) {
      goal.state = "paused";
      goal.reason =
        "Goal policy updated. Previously admitted work may have taken effect. Inspect progress and explicitly resume.";
      goal.epoch++;
      goal.revision++;
    }
    db.query("UPDATE agent_goals SET record=? WHERE id=?").run(
      JSON.stringify(goal),
      row.id,
    );
  }
  db.exec("PRAGMA user_version=19;");
}
