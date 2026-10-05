import { test, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  existsSync,
  chmodSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startApp } from "./fixtures/app";
import { Store } from "../src/server/store";
import { Harness } from "../src/server/harness";
import { directories } from "../src/server/directories";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-projects-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startApp({
    dataDir: join(dir, "state"),
    configDir: join(dir, "config"),
    port: 0,
    fixtureDelayMs: 10,
  });
  cleanup.push(() => app.close());
  app.service.setMode("api");
  const base = `http://127.0.0.1:${app.server.port}`;
  const session = await fetch(base + "/api/control-session");
  const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  const { csrf } = (await session.json()) as { csrf: string };
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method,
      headers: {
        cookie,
        "x-jelly-csrf": csrf,
        "content-type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { dir, app, request, base };
}
const profile = {
  name: "Pearl",

  instructions: "Be concise",
  color: "#a4c8e8",
  avatarId: "sea-turtle",
};
test("project lifecycle snapshots immutable cwd, running moves, archived deletion and restart persistence", async () => {
  const { dir, app, request } = await fixture();
  const one = join(dir, "one"),
    two = join(dir, "two");
  mkdirSync(one);
  mkdirSync(two);
  writeFileSync(join(one, "keep.txt"), "preserved");
  const create = await request("/api/projects", "POST", {
    name: " Website ",
    defaultCwd: one,
  });
  expect(create.status).toBe(201);
  const p = (await create.json()) as any;
  expect(
    (
      await request("/api/projects", "POST", {
        name: "WEBSITE",
        defaultCwd: one,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await request("/api/projects", "POST", {
        name: "Ungrouped",
        defaultCwd: one,
      })
    ).status,
  ).toBe(400);
  const a = (await (
    await request("/api/agents", "POST", { ...profile, projectId: p.id })
  ).json()) as any;
  const b = app.service.createAgent({
    ...profile,
    name: "Milo",
    projectId: p.id,
  });
  expect(a.cwd).toBe(one);
  expect(b.cwd).toBe(one);
  expect(a.avatarId).toBe("sea-turtle");
  await request(`/api/projects/${p.id}`, "PATCH", {
    name: "New website",
    defaultCwd: two,
  });
  const c = app.service.createAgent({ ...profile, projectId: p.id });
  expect(c.cwd).toBe(two);
  expect(app.store.agent(a.id)!.cwd).toBe(one);
  app.service.start(a.id, "project-running", "Check the workspace");
  expect(
    (await request(`/api/agents/${a.id}/project`, "PATCH", { projectId: null }))
      .status,
  ).toBe(200);
  expect(app.store.agent(a.id)!.cwd).toBe(one);
  expect((await request(`/api/agents/${a.id}`, "PATCH", profile)).status).toBe(
    409,
  );
  app.service.archiveAgent(b.id, true);
  expect(
    (
      (await (
        await request(`/api/agents/archived?scope=project&projectId=${p.id}`)
      ).json()) as any
    ).agents.map((x: any) => x.id),
  ).toEqual([b.id]);
  const deleted = await request(`/api/projects/${p.id}`, "DELETE");
  expect(deleted.status).toBe(200);
  expect(app.store.agent(b.id)!.projectId).toBeNull();
  expect(app.store.agent(b.id)!.archivedAt).not.toBeNull();
  expect(app.store.agent(c.id)!.cwd).toBe(two);
  expect(readFileSync(join(one, "keep.txt"), "utf8")).toBe("preserved");
  await app.service.settled();
  expect(app.store.runs(a.id)[0]!.status).toBe("completed");
  expect(app.store.history(a.id).length).toBeGreaterThan(0);
  const reread = new Store(join(dir, "state", "jelly.sqlite"));
  expect(reread.agent(a.id)!.cwd).toBe(one);
  expect(reread.agent(b.id)!.projectId).toBeNull();
  reread.close();
  expect(
    app.store
      .events()
      .filter((e) => e.type.startsWith("project_"))
      .map((e) => e.type),
  ).toEqual(["project_created", "project_updated", "project_deleted"]);
});
test("new directories require control authorization, validate names and never overwrite existing entries", async () => {
  const { dir, request, base } = await fixture();
  const create = (name: unknown, parent: unknown = dir) =>
    request("/api/directories", "POST", { parent, name });
  expect((await fetch(`${base}/api/directories`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent: dir, name: "unauthorized" }),
  })).status).toBe(401);
  expect((await request("/api/directories", "POST", { parent: dir, name: "no-csrf" }, { "x-jelly-csrf": "" })).status).toBe(403);
  expect(existsSync(join(dir, "unauthorized"))).toBe(false);
  expect(existsSync(join(dir, "no-csrf"))).toBe(false);
  for (const name of [null, 1, "", " ", ".", "..", "../outside", "nested/child", "nested\\child", "/absolute", "a\0b", "line\nbreak", "a".repeat(256), "🌊".repeat(64)])
    expect((await create(name)).status).toBe(400);
  expect((await create("child", "relative")).status).toBe(400);
  expect((await create("child", join(dir, "missing"))).status).toBe(400);
  writeFileSync(join(dir, "keep.txt"), "preserved");
  expect((await create("keep.txt")).status).toBe(409);
  expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("preserved");
  const response = await create("  New Directory 🌊  ");
  expect(response.status).toBe(201);
  const created = (await response.json()) as { path: string };
  expect(created.path).toBe(join(dir, "New Directory 🌊"));
  expect(statSync(created.path).mode & 0o777).toBe(0o700);
  expect((await create("New Directory 🌊")).status).toBe(409);
  symlinkSync(created.path, join(dir, "alias"));
  expect((await create("alias")).status).toBe(409);
  const nested = await create(".hidden", join(dir, "alias"));
  expect(nested.status).toBe(201);
  expect((await nested.json() as { path: string }).path).toBe(join(created.path, ".hidden"));
  const locked = join(dir, "locked");
  mkdirSync(locked, { mode: 0o500 });
  try {
    if (process.getuid?.() !== 0) expect((await create("child", locked)).status).toBe(403);
  } finally { chmodSync(locked, 0o700); }
});

test("folder browser canonicalizes symlinks, pages, hides dotfolders, rejects invalid paths and respects access controls", async () => {
  const { dir, request, base } = await fixture();
  const root = join(dir, "folders");
  mkdirSync(root);
  mkdirSync(join(root, ".hidden"));
  mkdirSync(join(root, "target"));
  symlinkSync(join(root, "target"), join(root, "link"));
  writeFileSync(join(root, "file"), "no contents returned");
  for (let i = 0; i < 105; i++)
    mkdirSync(join(root, `folder-${String(i).padStart(3, "0")}`));
  const first = directories(root);
  expect(first.entries.length).toBe(100);
  expect(first.entries.some((e) => e.name === ".hidden")).toBe(false);
  expect(first.entries.some((e) => e.name === "file")).toBe(false);
  const last = directories(root, first.cursor!);
  expect(last.cursor).toBeNull();
  expect(last.entries.find((e) => e.name === "link")!.path).toBe(
    join(root, "target"),
  );
  expect(directories(root, "", true).entries[0]!.name).toBe(".hidden");
  expect(directories(join(root, "link")).path).toBe(join(root, "target"));
  expect(
    (
      await request(
        "/api/directories?path=" + encodeURIComponent(join(root, "file")),
      )
    ).status,
  ).toBe(400);
  expect((await request("/api/directories?path=relative")).status).toBe(400);
  expect(
    (await request("/api/directories?path=" + encodeURIComponent(root))).status,
  ).toBe(200);
  expect((await fetch(base + "/api/directories")).status).toBe(401);
  expect(
    (
      await request("/api/directories", "GET", undefined, {
        "x-jelly-managed-browser": "1",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        "/api/projects",
        "POST",
        { name: "Blocked", defaultCwd: root },
        { "x-jelly-csrf": "bad" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/api/directories", "GET", undefined, {
        origin: "https://example.com",
      })
    ).status,
  ).toBe(403);
});
test("empty selection never falls back and project folders are revalidated without recreation", async () => {
  const { dir, app, request } = await fixture();
  const path = join(dir, "gone");
  mkdirSync(path);
  const p = app.service.saveProject(null, { name: "Empty", defaultCwd: path });
  const empty = (await (
    await request("/api/state?selection=none")
  ).json()) as any;
  expect(empty.selectedAgentId).toBeNull();
  expect(empty.events).toEqual([]);
  expect(empty.projects).toHaveLength(1);
  expect(empty.agents.length).toBeGreaterThan(0);
  expect((await request("/api/state?selection=none&agentId=x")).status).toBe(
    400,
  );
  const a = app.service.createAgent({ ...profile, projectId: p.id });
  rmSync(path, { recursive: true });
  expect(() =>
    app.service.createAgent({ ...profile, projectId: p.id }),
  ).toThrow("missing or inaccessible");
  expect(
    (
      await request("/api/agents", "POST", {
        ...profile,
        projectId: p.id,
        cwd: dir,
      })
    ).status,
  ).toBe(400);
  app.service.start(a.id, "missing-cwd", "hi");
  await app.service.settled();
  expect(app.store.runs(a.id)[0]!.status).toBe("failed");
  expect(existsSync(path)).toBe(false);
  expect(
    (await request("/api/agents", "POST", { ...profile, projectId: "missing" }))
      .status,
  ).toBe(404);
  expect(
    (await request(`/api/agents/${a.id}/project`, "PATCH", {})).status,
  ).toBe(400);
});
test("v4 migration backfills exact legacy directories without making files or changing histories", () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-v4-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "db.sqlite"),
    workspace = join(dir, "custom-root");
  let s = new Store(path, workspace);
  const a = s.addAgent(profile);
  const run = s.createRun(a.id, "migration", "hello", "demo", "local-demo");
  s.event(a.id, run.id, "message", { role: "user", text: "hello" });
  s.finishRun(run.id, "completed", null);
  s.db.exec(
    "ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT ''; DROP INDEX idx_agents_project; ALTER TABLE agents DROP COLUMN projectId; ALTER TABLE agents DROP COLUMN cwd; ALTER TABLE agents DROP COLUMN managedCwd; ALTER TABLE agents DROP COLUMN avatarId; ALTER TABLE agents DROP COLUMN model; ALTER TABLE agents DROP COLUMN effort; DROP TABLE projects; PRAGMA user_version=4",
  );
  s.close();
  s = new Store(path, workspace);
  expect(s.agent(a.id)!.cwd).toBe(join(workspace, a.id));
  expect(s.agent(a.id)!.projectId).toBeNull();
  expect(s.historyPage(a.id).events[0]!.data.text).toBe("hello");
  expect(existsSync(workspace)).toBe(false);
  expect(s.projects()).toEqual([]);
  expect(s.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  s.close();
});
test("two real sessions share project files and cwd while keeping context and config isolated", async () => {
  const { dir, app } = await fixture();
  const path = join(dir, "shared");
  mkdirSync(join(path, ".pi"), { recursive: true });
  const settings = '{"custom":"untouched","defaultThinkingLevel":"low"}';
  writeFileSync(join(path, ".pi", "settings.json"), settings);
  writeFileSync(join(path, "fixture.txt"), "shared fixture");
  const project = app.service.saveProject(null, {
    name: "Shared",
    defaultCwd: path,
  });
  const a = app.service.createAgent({ ...profile, projectId: project.id }),
    b = app.service.createAgent({ ...profile, projectId: project.id });
  const h = app.service.harness;
  const sessions = await Promise.all(
    [a, b].map((agent) =>
      h.create(agent, [], h.config("api"), app.store.instance()),
    ),
  );
  try {
    for (const s of sessions) {
      const bash = s.agent.state.tools.find((t) => t.name === "bash")!;
      const result = JSON.stringify(
        await bash.execute(
          crypto.randomUUID(),
          { command: "pwd; cat fixture.txt" },
          new AbortController().signal,
        ),
      );
      expect(result).toContain(path);
      expect(result).toContain("shared fixture");
    }
    expect(sessions[0]!.sessionManager.getSessionId()).not.toBe(
      sessions[1]!.sessionManager.getSessionId(),
    );
    expect(readFileSync(join(path, ".pi", "settings.json"), "utf8")).toBe(
      settings,
    );
    expect(existsSync(join(path, ".pi", "settings.json.jelly-tmp"))).toBe(
      false,
    );
  } finally {
    await Promise.all(sessions.map((s) => h.dispose(s)));
  }
});
