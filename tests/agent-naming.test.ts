import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./fixtures/app";
import { Store } from "../src/server/store";
import { generatedAgentName } from "../src/shared/agent-names";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-naming-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
  });
  cleanup.push(() => app.close());
  const agent = app.service.createAgent({
    name: "New Agent",
    instructions: "Help with this workspace",
    color: "#b5bafc",
  });
  return { app, agent, dir };
}

test("first message names a placeholder once, updates its prompt, and preserves chat and later names", async () => {
  const { app, agent } = await fixture();
  const name = spyOn(
    app.service.harness,
    "generateAgentName",
  ).mockResolvedValue("Coral Coder");
  cleanup.push(() => name.mockRestore());
  const create = spyOn(app.service.harness, "create");
  cleanup.push(() => create.mockRestore());
  const first = app.service.start(
    agent.id,
    "first-name-request",
    "Help me build a web application",
  );
  expect(
    app.service.start(
      agent.id,
      "first-name-request",
      "Help me build a web application",
    ).reused,
  ).toBe(true);
  app.service.start(agent.id, "second-name-request", "Then write tests");
  await app.service.settled();
  expect(name).toHaveBeenCalledTimes(1);
  expect(name.mock.calls[0]![0]).toBe("Help me build a web application");
  expect(app.store.agent(agent.id)!.name).toBe("Coral Coder");
  expect(create.mock.calls[0]![0].name).toBe("Coral Coder");
  expect(app.store.run(first.run!.id)!.status).toBe("completed");
  expect(
    app.store
      .history(agent.id)
      .filter((m) => m.role === "user")
      .map((m) => m.content),
  ).toEqual(["Help me build a web application", "Then write tests"]);
  expect(
    app.service
      .snapshot(agent.id)
      .events.some(
        (e) =>
          e.type === "agent_updated" &&
          (e.data.agent as any).name === "Coral Coder",
      ),
  ).toBe(true);
});

test("manual choices, including editing back to New Agent, suppress automatic naming", async () => {
  const { app, agent } = await fixture();
  const name = spyOn(
    app.service.harness,
    "generateAgentName",
  ).mockResolvedValue("Should Never Appear");
  cleanup.push(() => name.mockRestore());
  app.service.updateAgent(agent.id, {
    ...agent,
    name: "My chosen name",
    nameEdited: true,
  });
  app.service.start(agent.id, "chosen-first", "Write code");
  await app.service.settled();
  expect(app.store.agent(agent.id)!.name).toBe("My chosen name");
  const second = app.service.createAgent({
    name: "New Agent",
    nameEdited: true,
    instructions: "",
    color: "#fff",
  });
  app.service.start(second.id, "explicit-placeholder", "Write code");
  await app.service.settled();
  expect(app.store.agent(second.id)!.name).toBe("New Agent");
  const third = app.service.createAgent({
    name: "New Agent",
    instructions: "",
    color: "#fff",
  });
  app.service.updateAgent(third.id, { ...third, nameEdited: true });
  app.service.start(third.id, "edited-back", "Write code");
  await app.service.settled();
  expect(name).not.toHaveBeenCalled();
});

test("editing only instructions leaves the default name eligible; a late rename wins over AI", async () => {
  const { app, agent } = await fixture();
  app.service.updateAgent(agent.id, {
    ...agent,
    instructions: "Different instructions",
    nameEdited: false,
  });
  let resolve!: (value: string) => void;
  const name = spyOn(
    app.service.harness,
    "generateAgentName",
  ).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  cleanup.push(() => name.mockRestore());
  app.service.start(agent.id, "race", "Organize files");
  expect(name).toHaveBeenCalledTimes(1);
  app.store.updateAgent(agent.id, {
    ...agent,
    name: "User wins",
    nameEdited: true,
  });
  resolve("Octopus Organizer");
  await app.service.settled();
  expect(app.store.agent(agent.id)!.name).toBe("User wins");
});

test("name generation failures do not fail the task or retry on subsequent messages", async () => {
  const { app, agent } = await fixture();
  const name = spyOn(
    app.service.harness,
    "generateAgentName",
  ).mockRejectedValue(new Error("fixture naming failure"));
  cleanup.push(() => name.mockRestore());
  app.service.start(agent.id, "fail-first", "First task");
  await app.service.settled();
  app.service.start(agent.id, "fail-second", "Second task");
  await app.service.settled();
  expect(name).toHaveBeenCalledTimes(1);
  expect(app.store.agent(agent.id)!.name).toBe("New Agent");
  expect(
    app.store.runs(agent.id).every((run) => run.status === "completed"),
  ).toBe(true);
  expect(JSON.stringify(app.store.history(agent.id))).not.toContain(
    "fixture naming failure",
  );
});

test("stopping during naming aborts the extra request without starting an agent session", async () => {
  const { app, agent } = await fixture();
  let signal: AbortSignal | undefined;
  const name = spyOn(
    app.service.harness,
    "generateAgentName",
  ).mockImplementation((_prompt, _config, abort) => {
    signal = abort;
    return new Promise((_resolve, reject) =>
      abort.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      }),
    );
  });
  const create = spyOn(app.service.harness, "create");
  cleanup.push(() => name.mockRestore());
  cleanup.push(() => create.mockRestore());
  const result = app.service.start(agent.id, "stop-naming", "First task");
  await app.service.stop(agent.id);
  expect(signal!.aborted).toBe(true);
  expect(create).not.toHaveBeenCalled();
  expect(app.store.agent(agent.id)!.name).toBe("New Agent");
  expect(app.store.run(result.run!.id)!.status).toBe("cancelled");
});

test("naming eligibility persists across reopen; migrations never opt old agents into renaming", () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-name-migration-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "db.sqlite");
  let store = new Store(path);
  const old = store.addAgent({
    name: "New Agent",
    instructions: "",
    color: "#fff",
  });
  store.db.exec("DROP TABLE agent_naming; ALTER TABLE agents DROP COLUMN model; ALTER TABLE agents DROP COLUMN effort; PRAGMA user_version=8;");
  store.close();
  store = new Store(path);
  expect(store.agent(old.id)!.name).toBe("New Agent");
  expect(store.claimAgentName(old.id)).toBe(false);
  const pending = store.addAgent({
    name: "New Agent",
    instructions: "",
    color: "#fff",
  });
  const manual = store.addAgent({
    name: "New Agent",
    nameEdited: true,
    instructions: "",
    color: "#fff",
  });
  store.close();
  store = new Store(path);
  try {
    expect(store.claimAgentName(pending.id)).toBe(true);
    expect(store.claimAgentName(pending.id)).toBe(false);
    expect(store.claimAgentName(manual.id)).toBe(false);
    expect(store.db.query("PRAGMA user_version").get()).toEqual({
      user_version: 10,
    });
  } finally {
    store.close();
  }
});

test("name output validation rejects prose and unsafe display values", () => {
  expect(generatedAgentName('"Coral Coder"')).toBe("Coral Coder");
  for (const bad of [
    "",
    "New Agent",
    "<script>alert(1)</script>",
    "Name:\nCoral Coder",
    "Here is a name for your agent",
    "a".repeat(61),
    "https://example.com",
  ])
    expect(generatedAgentName(bad)).toBeNull();
});

for (const mode of ["api", "chatgpt"] as const)
  test(`naming uses the configured ${mode} OpenAI connection without tools or conversation history`, async () => {
    const { startApp: productionApp } = await import("../src/server/app");
    const { zstdDecompressSync } = await import("node:zlib");
    let request: any;
    const fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        request =
          req.headers.get("content-encoding") === "zstd"
            ? JSON.parse(
                zstdDecompressSync(
                  Buffer.from(await req.arrayBuffer()),
                ).toString(),
              )
            : await req.json();
        const item = {
          type: "message",
          id: "msg_name",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "Coral Coder", annotations: [] },
          ],
        };
        const events = [
          { type: "response.created", response: { id: "resp_name" } },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, content: [] },
          },
          {
            type: "response.content_part.added",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            delta: "Coral Coder",
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "resp_name",
              status: "completed",
              output: [item],
              usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
            },
          },
        ];
        return new Response(
          events
            .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    cleanup.push(() => {
      void fake.stop(true);
    });
    const dir = mkdtempSync(join(tmpdir(), "jelly-name-provider-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const app = await productionApp({
      dataDir: dir,
      configDir: join(dir, "config"),
      port: 0,
    });
    cleanup.push(() => app.close());
    const provider = mode === "api" ? "openai" : "openai-codex";
    if (mode === "api")
      await app.service.harness.auth.setRuntimeApiKey(
        provider,
        "test-only-key",
      );
    else {
      const access = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
      app.service.harness.auth.installLoginDriver(async () => ({
        access,
        refresh: "test-refresh",
        expires: Date.now() + 3600000,
        accountId: "test-account",
      }));
      await app.service.harness.runtime.login(provider, "oauth", {
        prompt: async () => "",
        notify: () => {},
      });
    }
    app.service.harness.registry.registerProvider(provider, {
      baseUrl: `http://127.0.0.1:${fake.port}/v1`,
    });
    app.service.setMode(mode);
    const instance = app.store.instance();
    const config = app.service.harness.config(instance.mode, instance);
    const name = await app.service.harness.generateAgentName(
      "Help me build a website",
      config,
      new AbortController().signal,
    );
    expect(name).toBe("Coral Coder");
    expect(request.model).toBe(config.model);
    expect(JSON.stringify(request)).toContain("sea-themed name");
    expect(JSON.stringify(request.input)).toContain("Help me build a website");
    expect(request.tools ?? []).toHaveLength(0);
    expect(app.store.history(app.store.agents()[0]!.id)).toHaveLength(0);
  });

test("agent creation API defaults the name and validates explicit name edits", async () => {
  const { app } = await fixture();
  const create = (input: unknown) =>
    fetch(new URL("/api/agents", app.server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  const response = await create({ instructions: "", color: "#abcdef" });
  expect(response.status).toBe(201);
  const agent = await response.json();
  expect(agent.name).toBe("New Agent");
  expect(app.store.claimAgentName(agent.id)).toBe(true);
  const explicit = await (
    await create({ name: "New Agent", nameEdited: true })
  ).json();
  expect(app.store.claimAgentName(explicit.id)).toBe(false);
  expect((await create({ nameEdited: "true" })).status).toBe(400);
});

test("partial profile edits preserve unrelated fields and avatar-only edits retain naming eligibility", async () => {
  const { app, agent } = await fixture();
  const patch = (id: string, input: unknown) =>
    fetch(new URL(`/api/agents/${id}`, app.server.url), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  expect((await patch(agent.id, { avatarId: "octopus" })).status).toBe(200);
  const changed = app.store.agent(agent.id)!;
  expect(changed.name).toBe("New Agent");
  expect(changed.instructions).toBe(agent.instructions);
  expect(changed.color).toBe(agent.color);
  expect(changed.cwd).toBe(agent.cwd);
  expect(changed.avatarId).toBe("octopus");
  expect(app.store.claimAgentName(agent.id)).toBe(true);
  expect(
    (await patch(agent.id, { name: "My Octopus", nameEdited: true })).status,
  ).toBe(200);
  expect(app.store.agent(agent.id)!.name).toBe("My Octopus");
  expect(app.store.agent(agent.id)!.avatarId).toBe("octopus");
  expect(app.store.agent(agent.id)!.instructions).toBe(agent.instructions);
  expect((await patch(agent.id, { name: "" })).status).toBe(400);
  expect((await patch(agent.id, { avatarId: "invalid" })).status).toBe(400);
  expect((await patch("missing", { name: "Pearl" })).status).toBe(404);
});
