import { useTestModel } from "./fixtures/app";
import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Mcps } from "../src/server/mcps";
import { Harness } from "../src/server/harness";
import { startApp } from "../src/server/app";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "jelly-mcp's "));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

test("the agent can configure, discover, call and remove user-wide MCPs through its prompt and existing bash tool", async () => {
  const root = directory(),
    configDir = join(root, "config");
  const harness = await Harness.create(
    join(root, "instance"),
    undefined,
    configDir,
  );
  useTestModel(harness);
  const session = await harness.create(
    {
      id: "mcp-agent",
      model: "gpt-6-astra",
      effort: "medium",
      name: "Jelly",
      instructions: "",
      cwd: join(root, "workspace"),
      managedCwd: 1,
      projectId: null,
      avatarId: "jellyfish",
      color: "#ffffff",
      status: "idle",
      createdAt: "",
      archivedAt: null,
    },
    [],
    harness.config("api"),
    { id: "test", name: "Test" },
  );
  cleanups.push(() => harness.dispose(session));
  const prompt = session.systemPrompt;
  const prefix = prompt.match(
    /exact command prefix \(works from any working directory\): (.+)/,
  )![1]!;
  expect(prompt).toContain("${TOKEN}");
  const bash = session.agent.state.tools.find((tool) => tool.name === "bash")!;
  const run = async (command: string) =>
    JSON.stringify(
      await bash.execute(
        crypto.randomUUID(),
        { command: `${prefix} ${command}` },
        new AbortController().signal,
      ),
    );
  await run(
    `config add fixture --command ${quote(process.execPath)} --arg ${quote(resolve("tests/fixtures/mcp-server.ts"))}`,
  );
  const config = JSON.parse(readFileSync(harness.mcps.configPath, "utf8"));
  expect(config.imports).toEqual([]);
  expect(config.mcpServers.fixture).toBeDefined();
  expect(statSync(harness.mcps.configPath).mode & 0o777).toBe(0o600);
  expect(await run("list fixture --schema")).toContain("echo");
  expect(
    await run(`call fixture.echo --args '{"text":"hello from Jelly"}'`),
  ).toContain("hello from Jelly");
  const other = await Harness.create(
    join(root, "another-instance"),
    undefined,
    configDir,
  );
  expect(await other.mcps.status()).toEqual({
    servers: [{ name: "fixture", status: "connected", toolCount: 1 }],
  });
  expect(JSON.stringify(await other.mcps.status())).not.toContain(
    "private-tool-description",
  );
  await run("config remove fixture");
  expect(await other.mcps.status()).toEqual({ servers: [] });
}, 15000);

test("settings reports sign-in and unavailable servers without leaking secrets; invalid config recovers", async () => {
  const mcps = new Mcps(directory());
  mcps.instructions();
  const http = Bun.serve({
    port: 0,
    fetch: () => new Response("private-token-error", { status: 401 }),
  });
  cleanups.push(() => {
    http.stop(true);
  });
  writeFileSync(
    mcps.configPath,
    JSON.stringify({
      imports: [],
      mcpServers: {
        signin: {
          baseUrl: `${http.url}mcp?secret=private-url-token`,
          headers: { Authorization: "Bearer private-header" },
        },
        offline: { command: "/nonexistent/jelly-mcp-command" },
      },
    }),
  );
  expect(await mcps.status()).toEqual({
    servers: [
      { name: "signin", status: "needs_auth", toolCount: null },
      { name: "offline", status: "unavailable", toolCount: null },
    ],
  });
  writeFileSync(mcps.configPath, '{"secret":"private-config-token",invalid');
  const bad = await mcps.status();
  expect(bad.error).toBeDefined();
  expect(JSON.stringify(bad)).not.toContain("private-");
  writeFileSync(mcps.configPath, '{"mcpServers":{},"imports":[]}');
  expect(await mcps.status()).toEqual({ servers: [] });
}, 20000);

test("MCP status requires the private control session and exposes no editing endpoint", async () => {
  const root = directory();
  const app = await startApp({
    dataDir: join(root, "data"),
    configDir: join(root, "config"),
    port: 0,
  });
  cleanups.push(() => app.close());
  const url = new URL("/api/mcps/status", app.server.url);
  expect((await fetch(url, { method: "POST" })).status).toBe(401);
  const session = await fetch(new URL("/api/control-session", app.server.url));
  const headers = {
    cookie: session.headers.get("set-cookie")!.split(";")[0]!,
    "x-jelly-csrf": (await session.json()).csrf,
  };
  expect(
    (await fetch(url, { method: "POST", headers: { cookie: headers.cookie } }))
      .status,
  ).toBe(403);
  expect(await (await fetch(url, { method: "POST", headers })).json()).toEqual({
    servers: [],
  });
  expect(
    (
      await fetch(new URL("/api/mcps/add", app.server.url), {
        method: "POST",
        headers,
      })
    ).status,
  ).toBe(404);
});
