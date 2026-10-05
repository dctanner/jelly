import { DEFAULT_AGENT_NAME } from "../shared/agent-names";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { MODEL_OPTIONS, EFFORT_OPTIONS, type ModelId, type Effort } from "../shared/models";
import { activityPreview, thinkingPreview } from "./activity-preview";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type {
  ProjectRecord,
  AgentInput,
  Activity,
  Intervention,
  AgentRecord,
  Mode,
  RunRecord,
  Status,
  PendingMessage,
  MessageMode,
} from "../shared/types";

const assistantMessageFilter = `type='message' AND json_extract(data, '$.role')='assistant'
  AND length(trim(COALESCE(json_extract(data, '$.text'), ''))) > 0`;

export class Store {
  readonly db: Database;
  constructor(
    path: string,
    readonly workspaceRoot = resolve(dirname(path), "workspaces"),
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    const version = (
      this.db.query("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version > 11)
      throw new Error("This database was created by a newer Jelly version.");
    if (version === 0)
      this.db.transaction(() => {
        this.db.exec(`
        CREATE TABLE instance (id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'auto');
        CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, instructions TEXT NOT NULL, color TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle', createdAt TEXT NOT NULL);
        CREATE TABLE runs (id TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id), requestId TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL, status TEXT NOT NULL, mode TEXT NOT NULL, model TEXT NOT NULL, startedAt TEXT NOT NULL, endedAt TEXT, error TEXT);
        CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, agentId TEXT NOT NULL REFERENCES agents(id), runId TEXT NOT NULL REFERENCES runs(id), payload TEXT NOT NULL);
        CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, agentId TEXT REFERENCES agents(id), runId TEXT REFERENCES runs(id), type TEXT NOT NULL, data TEXT NOT NULL, createdAt TEXT NOT NULL);
        CREATE INDEX idx_messages_agent ON messages(agentId, id);
        CREATE INDEX idx_events_agent ON events(agentId, id);
        CREATE INDEX idx_runs_agent ON runs(agentId, startedAt);
        CREATE UNIQUE INDEX idx_runs_active_agent ON runs(agentId) WHERE status = 'running';
        PRAGMA user_version=1;
      `);
        this.db
          .query("INSERT INTO instance (id,name) VALUES (?,?)")
          .run(crypto.randomUUID(), "This computer");
      })();
    if (version < 2)
      this.db.transaction(() => {
        this.db
          .exec(`CREATE TABLE interventions (id TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id), runId TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, result TEXT, createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL);
      CREATE INDEX idx_interventions_run ON interventions(runId);
      PRAGMA user_version=2;`);
      })();
    if (version < 3)
      this.db.transaction(() => {
        this.db.exec(
          "ALTER TABLE instance ADD COLUMN model TEXT NOT NULL DEFAULT 'gpt-6-astra'; ALTER TABLE instance ADD COLUMN effort TEXT NOT NULL DEFAULT 'medium'; PRAGMA user_version=3;",
        );
      })();
    if (version < 4)
      this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE agents ADD COLUMN archivedAt TEXT;
          CREATE INDEX idx_agents_archive ON agents(archivedAt, id);
          CREATE TABLE contexts (agentId TEXT PRIMARY KEY REFERENCES agents(id), runId TEXT NOT NULL REFERENCES runs(id), entries TEXT NOT NULL);
          CREATE TABLE timeline (id INTEGER PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id), runId TEXT REFERENCES runs(id), type TEXT NOT NULL, data TEXT NOT NULL, createdAt TEXT NOT NULL);
          CREATE INDEX idx_timeline_agent ON timeline(agentId, id);
          INSERT INTO timeline SELECT * FROM events WHERE agentId IS NOT NULL;
          PRAGMA user_version=4;
        `);
      })();
    if (version < 5)
      this.db.transaction(() => {
        this.db
          .exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, nameKey TEXT NOT NULL UNIQUE, defaultCwd TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
        ALTER TABLE agents ADD COLUMN projectId TEXT REFERENCES projects(id) ON DELETE SET NULL;
        ALTER TABLE agents ADD COLUMN cwd TEXT NOT NULL DEFAULT '';
        ALTER TABLE agents ADD COLUMN managedCwd INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE agents ADD COLUMN avatarId TEXT NOT NULL DEFAULT 'jellyfish';
        CREATE INDEX idx_agents_project ON agents(projectId, archivedAt);`);
        for (const agent of this.agents())
          this.db
            .query("UPDATE agents SET cwd=? WHERE id=?")
            .run(join(this.workspaceRoot, agent.id), agent.id);
        this.db.exec("PRAGMA user_version=5;");
      })();
    if (version < 6)
      this.db.transaction(() => {
        this.db.exec(`
          UPDATE agents SET instructions = trim(role) ||
            CASE WHEN instructions = '' THEN '' ELSE char(10) || instructions END
            WHERE trim(role) != '';
          ALTER TABLE agents DROP COLUMN role;
          PRAGMA user_version=6;
        `);
      })();
    if (version < 7)
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS pending_messages (
            id TEXT PRIMARY KEY, agentId TEXT NOT NULL REFERENCES agents(id),
            text TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
            runId TEXT REFERENCES runs(id), createdAt TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_pending_messages_agent ON pending_messages(agentId, status);
          PRAGMA user_version=7;
        `);
      })();
    if (version < 8)
      this.db.transaction(() => {
        // Keep historical demo conversations, but require credentials for new runs.
        this.db.exec("UPDATE instance SET mode='auto' WHERE mode='demo'; PRAGMA user_version=8;");
      })();
    if (version < 9)
      this.db.transaction(() => {
        // Existing agents have no pending job: never rename an old profile.
        this.db.exec(`CREATE TABLE IF NOT EXISTS agent_naming (
          agentId TEXT PRIMARY KEY REFERENCES agents(id),
          state TEXT NOT NULL CHECK(state IN ('pending','manual','attempted','generated'))
        ); PRAGMA user_version=9;`);
      })();
    if (version < 10)
      this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE agents ADD COLUMN model TEXT NOT NULL DEFAULT 'gpt-6-astra';
          ALTER TABLE agents ADD COLUMN effort TEXT NOT NULL DEFAULT 'medium';
        `);
        const defaults = this.instance();
        for (const agent of this.agents()) {
          // Old versions stored choices globally. Preserve each agent's last
          // recorded run where possible; never guess a missing historical choice.
          const last = this.db.query(`SELECT id, data FROM timeline
            WHERE agentId=? AND type='run_started' ORDER BY id DESC LIMIT 1`)
            .get(agent.id) as { id: number; data: string } | null;
          const recorded = last ? JSON.parse(last.data) : {};
          const run = this.db.query("SELECT model FROM runs WHERE agentId=? ORDER BY rowid DESC LIMIT 1")
            .get(agent.id) as { model: string } | null;
          let model = recorded.selectedModel ?? recorded.model ?? run?.model ?? defaults.model;
          // Older run events used the upstream Astra ID for Ultrafast. A
          // retained config event can disambiguate without assuming today's tier.
          if (last && model === "gpt-6-astra") {
            const prior = this.db.query(`SELECT data FROM events
              WHERE type='config_changed' AND id<? ORDER BY id DESC LIMIT 1`)
              .get(last.id) as { data: string } | null;
            if (prior && JSON.parse(prior.data).model === "gpt-6-astra-ultrafast")
              model = "gpt-6-astra-ultrafast";
          }
          const effort = recorded.effort ?? defaults.effort;
          this.setAgentConfig(agent.id,
            MODEL_OPTIONS.some(option => option.id === model) ? model : defaults.model,
            EFFORT_OPTIONS.some(option => option.id === effort) ? effort : defaults.effort);
        }
        this.db.exec("PRAGMA user_version=10;");
      })();
    if (version < 11)
      this.db.transaction(() => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS subagent_views (
          runId TEXT PRIMARY KEY REFERENCES runs(id),
          agentId TEXT NOT NULL REFERENCES agents(id),
          snapshot TEXT NOT NULL, sources TEXT NOT NULL
        ); PRAGMA user_version=11;`);
      })();
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_timeline_assistant_message
      ON timeline(agentId, id) WHERE ${assistantMessageFilter}`);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_timeline_thinking ON timeline(runId, id) WHERE type='thinking';
      CREATE INDEX IF NOT EXISTS idx_timeline_tool_starts
        ON timeline(runId, id) WHERE type='tool_started';
      CREATE INDEX IF NOT EXISTS idx_timeline_tool_ends
        ON timeline(runId, json_extract(data, '$.toolCallId')) WHERE type='tool_completed';
    `);
    this.pruneReplay();
  }
  pendingMessage(id: string) {
    return this.db
      .query("SELECT * FROM pending_messages WHERE id=?")
      .get(id) as PendingMessage | null;
  }
  pendingMessages(agentId?: string) {
    return this.db
      .query(
        `SELECT * FROM pending_messages WHERE status='pending' ${agentId ? "AND agentId=?" : ""} ORDER BY rowid`,
      )
      .all(...(agentId ? [agentId] : [])) as PendingMessage[];
  }
  enqueueMessage(id: string, agentId: string, text: string, mode: MessageMode) {
    this.db
      .query(
        "INSERT INTO pending_messages(id,agentId,text,mode,createdAt) VALUES (?,?,?,?,?)",
      )
      .run(id, agentId, text, mode, new Date().toISOString());
    return this.pendingMessage(id)!;
  }
  deliverMessage(id: string, runId: string) {
    this.db
      .query(
        "UPDATE pending_messages SET status='delivered',runId=? WHERE id=?",
      )
      .run(runId, id);
  }
  cancelPendingMessages(agentId: string, reason: string) {
    return this.pendingMessages(agentId).map((message) => {
      this.db
        .query("UPDATE pending_messages SET status='cancelled' WHERE id=?")
        .run(message.id);
      return this.event(agentId, null, "message", {
        role: "user",
        text: message.text,
        messageId: message.id,
        mode: message.mode,
        deliveryStatus: "cancelled",
        reason,
      });
    });
  }
  createIntervention(
    kind: Intervention["kind"],
    agentId: string,
    runId: string,
    payload: Record<string, unknown>,
    expiresAt: string,
  ) {
    const id = crypto.randomUUID();
    this.db
      .query(
        "INSERT INTO interventions (id,agentId,runId,kind,status,payload,createdAt,expiresAt) VALUES (?,?,?,?,'pending',?,?,?)",
      )
      .run(
        id,
        agentId,
        runId,
        kind,
        JSON.stringify(payload),
        new Date().toISOString(),
        expiresAt,
      );
    return this.intervention(id)!;
  }
  private parseIntervention(row: unknown): Intervention | null {
    if (!row) return null;
    const r = row as Omit<Intervention, "payload" | "result"> & {
      payload: string;
      result: string | null;
    };
    return {
      ...r,
      payload: JSON.parse(r.payload),
      result: r.result ? JSON.parse(r.result) : null,
    };
  }
  intervention(id: string) {
    return this.parseIntervention(
      this.db.query("SELECT * FROM interventions WHERE id=?").get(id),
    );
  }
  interventions() {
    return this.db
      .query("SELECT * FROM interventions ORDER BY createdAt")
      .all()
      .map((row) => this.parseIntervention(row)!);
  }
  updateIntervention(
    id: string,
    status: Intervention["status"],
    result: Record<string, unknown> | null,
  ) {
    this.db
      .query("UPDATE interventions SET status=?,result=? WHERE id=?")
      .run(status, result ? JSON.stringify(result) : null, id);
  }
  instance() {
    return this.db.query("SELECT * FROM instance").get() as {
      id: string;
      name: string;
      mode: Mode;
      model: ModelId;
      effort: Effort;
    };
  }
  setMode(mode: Mode) {
    this.db.query("UPDATE instance SET mode=?").run(mode);
  }
  setConfig(mode: Mode, model: ModelId, effort: Effort) {
    this.db
      .query("UPDATE instance SET mode=?,model=?,effort=?")
      .run(mode, model, effort);
  }
  latestAssistantMessages(): Record<string, number> {
    const rows = this.db
      .query(
        `SELECT agents.id AS agentId,
      (SELECT id FROM timeline WHERE agentId=agents.id AND ${assistantMessageFilter}
        ORDER BY id DESC LIMIT 1) AS messageId
      FROM agents WHERE archivedAt IS NULL`,
      )
      .all() as { agentId: string; messageId: number | null }[];
    return Object.fromEntries(
      rows
        .filter((row) => row.messageId !== null)
        .map((row) => [row.agentId, row.messageId!]),
    );
  }
  agentPreviews(): Record<string, { text: string; createdAt: string }> {
    const rows = this.db
      .query(
        `SELECT agents.id AS agentId,
      substr(json_extract(t.data, '$.text'), 1, 220) AS text, t.createdAt
      FROM agents JOIN timeline t ON t.id = (
        SELECT id FROM timeline WHERE agentId=agents.id AND ${assistantMessageFilter}
        ORDER BY id DESC LIMIT 1
      ) WHERE agents.archivedAt IS NULL`,
      )
      .all() as { agentId: string; text: string; createdAt: string }[];
    return Object.fromEntries(
      rows.map(({ agentId, text, createdAt }) => [
        agentId,
        { text, createdAt },
      ]),
    );
  }
  agentActivity(): Record<string, string> {
    // Latest outstanding tool, not merely the latest event: one parallel tool
    // can finish while another is still working. Scope both sides to this run.
    // The completion index avoids repeatedly parsing large tool-result bodies.
    const rows = this.db.query(`
      SELECT r.agentId,
        (SELECT substr(json_extract(th.data, '$.text'), -8192) FROM timeline th
          WHERE th.runId=r.id AND th.type='thinking'
          ORDER BY th.id DESC LIMIT 1) AS thinking,
        substr(json_extract(t.data, '$.name'), 1, 96) AS name,
        substr(json_extract(t.data, '$.args.command'), 1, 512) AS command
      FROM runs r JOIN agents a ON a.id=r.agentId
      LEFT JOIN timeline t ON t.id=(
        SELECT s.id FROM timeline s
        WHERE s.runId=r.id AND s.type='tool_started'
          AND NOT EXISTS (
            SELECT 1 FROM timeline e WHERE e.runId=s.runId AND e.type='tool_completed'
              AND json_extract(e.data, '$.toolCallId')=json_extract(s.data, '$.toolCallId')
          )
        ORDER BY s.id DESC LIMIT 1
      )
      WHERE r.status='running' AND a.status='running' AND a.archivedAt IS NULL
    `).all() as { agentId: string; thinking: string | null; name: string | null; command: string | null }[];
    return Object.fromEntries(rows.map(({ agentId, thinking, name, command }) => [agentId, thinkingPreview(thinking ?? "") || activityPreview(name, command)]));
  }
  agents(includeArchived = true) {
    return this.db
      .query(
        `SELECT * FROM agents ${includeArchived ? "" : "WHERE archivedAt IS NULL"} ORDER BY createdAt, id`,
      )
      .all() as AgentRecord[];
  }
  agent(id: string) {
    return this.db
      .query("SELECT * FROM agents WHERE id=?")
      .get(id) as AgentRecord | null;
  }
  addAgent(input: AgentInput) {
    const id = crypto.randomUUID();
    const defaults = this.instance();
    const { nameEdited, ...profile } = input;
    const agent: AgentRecord = {
      ...profile,
      model: defaults.model,
      effort: defaults.effort,
      projectId: input.projectId ?? null,
      cwd: input.projectId
        ? this.project(input.projectId)!.defaultCwd
        : join(this.workspaceRoot, id),
      managedCwd: input.projectId ? 0 : 1,
      avatarId: input.avatarId ?? "jellyfish",
      id,
      status: "idle",
      archivedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .query(
        "INSERT INTO agents (id,name,instructions,color,status,createdAt,projectId,cwd,managedCwd,avatarId,model,effort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        agent.id,
        agent.name,
        agent.instructions,
        agent.color,
        agent.status,
        agent.createdAt,
        agent.projectId,
        agent.cwd,
        agent.managedCwd,
        agent.avatarId,
        agent.model,
        agent.effort,
      );
    this.db.query("INSERT INTO agent_naming(agentId,state) VALUES (?,?)")
      .run(id, agent.name === DEFAULT_AGENT_NAME && !nameEdited ? "pending" : "manual");
    return agent;
  }
  setAgentConfig(id: string, model: ModelId, effort: Effort) {
    this.db.query("UPDATE agents SET model=?,effort=? WHERE id=?").run(model, effort, id);
  }
  updateAgent(id: string, input: AgentInput) {
    if (input.nameEdited || input.name !== this.agent(id)?.name)
      this.db.query("UPDATE agent_naming SET state='manual' WHERE agentId=?").run(id);
    this.db
      .query(
        "UPDATE agents SET name=?,instructions=?,color=?,avatarId=? WHERE id=?",
      )
      .run(
        input.name,
        input.instructions,
        input.color,
        input.avatarId ?? this.agent(id)!.avatarId,
        id,
      );
    return this.agent(id)!;
  }
  claimAgentName(id: string) {
    return this.db.query(`UPDATE agent_naming SET state='attempted'
      WHERE agentId=? AND state='pending'
      AND EXISTS (SELECT 1 FROM agents WHERE id=? AND name=?)
      AND NOT EXISTS (SELECT 1 FROM messages WHERE agentId=? AND json_extract(payload,'$.role')='user')`)
      .run(id, id, DEFAULT_AGENT_NAME, id).changes > 0;
  }
  applyAgentName(id: string, name: string) {
    const changed = this.db.query(`UPDATE agents SET name=? WHERE id=? AND name=?
      AND EXISTS (SELECT 1 FROM agent_naming WHERE agentId=? AND state='attempted')`)
      .run(name, id, DEFAULT_AGENT_NAME, id).changes;
    if (!changed) return null;
    this.db.query("UPDATE agent_naming SET state='generated' WHERE agentId=?").run(id);
    return this.agent(id)!;
  }
  archiveAgent(id: string, archived: boolean) {
    this.db
      .query("UPDATE agents SET archivedAt=? WHERE id=?")
      .run(archived ? new Date().toISOString() : null, id);
    return this.agent(id)!;
  }
  archivedAgents(
    after = "",
    limit = 50,
    scope: string = "all",
    projectId: string | null = null,
  ) {
    const rows = this.db
      .query(
        `SELECT * FROM agents WHERE archivedAt IS NOT NULL AND id>? ${scope === "ungrouped" ? "AND projectId IS NULL" : scope === "project" ? "AND projectId=?" : ""} ORDER BY id LIMIT ?`,
      )
      .all(
        ...(scope === "project"
          ? [after, projectId, limit + 1]
          : [after, limit + 1]),
      ) as AgentRecord[];
    return {
      agents: rows.slice(0, limit),
      after: rows.length > limit ? rows[limit - 1]!.id : null,
    };
  }
  projects() {
    return this.db
      .query(
        "SELECT id,name,defaultCwd,createdAt,updatedAt FROM projects ORDER BY nameKey,id",
      )
      .all() as ProjectRecord[];
  }
  project(id: string) {
    return this.db
      .query(
        "SELECT id,name,defaultCwd,createdAt,updatedAt FROM projects WHERE id=?",
      )
      .get(id) as ProjectRecord | null;
  }
  saveProject(id: string, name: string, nameKey: string, defaultCwd: string) {
    const now = new Date().toISOString();
    this.db
      .query(
        "INSERT INTO projects(id,name,nameKey,defaultCwd,createdAt,updatedAt) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,nameKey=excluded.nameKey,defaultCwd=excluded.defaultCwd,updatedAt=excluded.updatedAt",
      )
      .run(id, name, nameKey, defaultCwd, now, now);
    return this.project(id)!;
  }
  deleteProject(id: string) {
    this.db.query("DELETE FROM projects WHERE id=?").run(id);
  }
  moveAgent(id: string, projectId: string | null) {
    this.db
      .query("UPDATE agents SET projectId=? WHERE id=?")
      .run(projectId, id);
    return this.agent(id)!;
  }
  context(agentId: string): FileEntry[] | null {
    const row = this.db
      .query("SELECT entries FROM contexts WHERE agentId=?")
      .get(agentId) as { entries: string } | null;
    return row ? JSON.parse(row.entries) : null;
  }
  saveContext(agentId: string, runId: string, entries: FileEntry[]) {
    this.db
      .query(
        "INSERT INTO contexts(agentId,runId,entries) VALUES (?,?,?) ON CONFLICT(agentId) DO UPDATE SET runId=excluded.runId,entries=excluded.entries",
      )
      .run(agentId, runId, JSON.stringify(entries));
  }
  setStatus(id: string, status: Status) {
    this.db.query("UPDATE agents SET status=? WHERE id=?").run(status, id);
  }
  createRun(
    agentId: string,
    requestId: string,
    prompt: string,
    mode: string,
    model: string,
  ): RunRecord {
    const id = crypto.randomUUID();
    this.db
      .query(
        "INSERT INTO runs (id,agentId,requestId,prompt,status,mode,model,startedAt) VALUES (?,?,?,?,'running',?,?,?)",
      )
      .run(
        id,
        agentId,
        requestId,
        prompt,
        mode,
        model,
        new Date().toISOString(),
      );
    return this.run(id)!;
  }
  run(id: string) {
    return this.db
      .query(
        "SELECT id,agentId,status,mode,model,startedAt,endedAt,error FROM runs WHERE id=?",
      )
      .get(id) as RunRecord | null;
  }
  byRequest(id: string) {
    return this.db.query("SELECT * FROM runs WHERE requestId=?").get(id) as
      (RunRecord & { prompt: string }) | null;
  }
  runs(agentId: string) {
    return this.db
      .query(
        "SELECT id,agentId,status,mode,model,startedAt,endedAt,error FROM runs WHERE agentId=? ORDER BY startedAt",
      )
      .all(agentId) as RunRecord[];
  }
  finishRun(id: string, status: RunRecord["status"], error: string | null) {
    this.db
      .query("UPDATE runs SET status=?,error=?,endedAt=? WHERE id=?")
      .run(status, error, new Date().toISOString(), id);
  }
  saveMessage(agentId: string, runId: string, message: Message) {
    this.db
      .query("INSERT INTO messages (agentId,runId,payload) VALUES (?,?,?)")
      .run(agentId, runId, JSON.stringify(message));
  }
  history(agentId: string): Message[] {
    // Only settled, successful runs form model context. Partial runs stay visible in activity.
    const rows = this.db
      .query(
        "SELECT m.payload FROM messages m JOIN runs r ON r.id=m.runId WHERE m.agentId=? AND r.status='completed' ORDER BY m.id",
      )
      .all(agentId) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload));
  }
  event(
    agentId: string | null,
    runId: string | null,
    type: string,
    data: Record<string, unknown>,
  ): Activity {
    return this.db.transaction(() => {
      const createdAt = new Date().toISOString();
      const result = this.db
        .query(
          "INSERT INTO events (agentId,runId,type,data,createdAt) VALUES (?,?,?,?,?)",
        )
        .run(agentId, runId, type, JSON.stringify(data), createdAt);
      const id = Number(result.lastInsertRowid);
      // Live projections have their own durable row. Do not fill chat history
      // with snapshots every few seconds; SSE still carries replayable updates.
      if (agentId && !["subagents_updated", "extension_status", "extension_widget"].includes(type))
        this.db
          .query(
            "INSERT INTO timeline(id,agentId,runId,type,data,createdAt) VALUES (?,?,?,?,?,?)",
          )
          .run(id, agentId, runId, type, JSON.stringify(data), createdAt);
      // DELETE uses the primary key; the bounded log retains the newest 10,000 IDs.
      this.pruneReplay(id);
      return {
        id,
        agentId,
        runId,
        type,
        data,
        createdAt,
      };
    })();
  }
  timelineEvent(id: number): Activity | null {
    const row = this.db.query("SELECT * FROM timeline WHERE id=?").get(id) as
      | (Omit<Activity, "data"> & { data: string })
      | null;
    return row ? { ...row, data: JSON.parse(row.data) } : null;
  }
  pruneReplay(cursor = this.cursor()) {
    this.db.query("DELETE FROM events WHERE id<=?").run(cursor - 10000);
  }
  replayFloor() {
    return (
      this.db
        .query("SELECT COALESCE(MIN(id)-1,0) AS floor FROM events")
        .get() as { floor: number }
    ).floor;
  }
  historyPage(agentId: string, before = Number.MAX_SAFE_INTEGER, limit = 100) {
    const rows = this.db
      .query(
        "SELECT * FROM timeline WHERE agentId=? AND id<? ORDER BY id DESC LIMIT ?",
      )
      .all(agentId, before, limit + 1) as (Omit<Activity, "data"> & {
      data: string;
    })[];
    const more = rows.length > limit;
    const events = rows
      .slice(0, limit)
      .reverse()
      .map((row) => ({ ...row, data: JSON.parse(row.data) })) as Activity[];
    const runIds = [
      ...new Set(events.flatMap((e) => (e.runId ? [e.runId] : []))),
    ];
    const active = this.db
      .query("SELECT id FROM runs WHERE agentId=? AND status='running'")
      .get(agentId) as { id: string } | null;
    if (active && !runIds.includes(active.id)) runIds.push(active.id);
    const runs = runIds.length
      ? (this.db
          .query(
            `SELECT id,agentId,status,mode,model,startedAt,endedAt,error FROM runs WHERE id IN (${runIds.map(() => "?").join(",")}) ORDER BY startedAt`,
          )
          .all(...runIds) as RunRecord[])
      : [];
    return {
      events,
      runs,
      interventions: this.snapshotInterventions(
        agentId,
        runs.map((run) => run.id),
      ),
      before: more ? events[0]!.id : null,
    };
  }
  snapshotInterventions(agentId: string | undefined, runIds: string[]) {
    if (!agentId || !runIds.length) return [];
    return this.db
      .query(
        `SELECT * FROM interventions WHERE agentId=? AND runId IN (${runIds.map(() => "?").join(",")}) ORDER BY createdAt DESC LIMIT 100`,
      )
      .all(agentId, ...runIds)
      .map((row) => this.parseIntervention(row)!);
  }
  events(after = 0, agentId?: string, limit = 512) {
    const rows = (
      agentId
        ? this.db
            .query(
              "SELECT * FROM timeline WHERE id>? AND agentId=? ORDER BY id LIMIT ?",
            )
            .all(after, agentId, limit)
        : this.db
            .query("SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?")
            .all(after, limit)
    ) as (Omit<Activity, "data"> & { data: string })[];
    return rows.map((row) => ({
      ...row,
      data: JSON.parse(row.data),
    })) as Activity[];
  }
  cursor() {
    return (
      this.db
        .query("SELECT COALESCE(MAX(id),0) AS cursor FROM events")
        .get() as { cursor: number }
    ).cursor;
  }
  recover() {
    const runs = this.db
      .query("SELECT id,agentId FROM runs WHERE status='running'")
      .all() as { id: string; agentId: string }[];
    this.db.transaction(() => {
      for (const agentId of new Set(
        this.pendingMessages().map((message) => message.agentId),
      ))
        this.cancelPendingMessages(
          agentId,
          "Not sent: the server restarted. Send this message again to continue.",
        );
      this.db
        .query(
          "UPDATE interventions SET status='interrupted' WHERE status IN ('pending','executing')",
        )
        .run();
      for (const run of runs) {
        const error =
          "The server stopped before this run finished. Send a new message to continue.";
        this.finishRun(run.id, "interrupted", error);
        this.setStatus(run.agentId, "interrupted");
        this.event(run.agentId, run.id, "run_interrupted", { error });
      }
    })();
  }
  close() {
    this.db.close();
  }
}
