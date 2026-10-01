import { useTestModel } from "./fixtures/app";
import { test, expect, afterAll } from "bun:test";
import { Harness } from "../src/server/harness";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { ALL_PI_TOOLS } from "../src/server/pi-setup";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "jelly-capabilities-"));
const previousDir = process.env.PI_CODING_AGENT_DIR,
  previousRoot = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = resolve(
  "node_modules/@earendil-works/pi-coding-agent",
);
afterAll(() => {
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  if (previousRoot === undefined)
    delete process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
  else process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = previousRoot;
  rmSync(dir, { recursive: true, force: true });
});
const agent = {
  model: "gpt-6-astra" as const,
  effort: "medium" as const,
  id: "capabilities",
  cwd: join(dir, "workspaces", "capabilities"),
  managedCwd: 1,
  projectId: null,
  avatarId: "jellyfish",
  name: "Capabilities",

  instructions: "",
  color: "#ffffff",
  status: "idle" as const,
  createdAt: "",
  archivedAt: null,
};
const instance = { id: "test", name: "Test" };
test("all Pi tools and the subagent package load; filesystem and shell execute without approval", async () => {
  const h = await Harness.create(dir, undefined, join(dir, "config"));
  useTestModel(h);
  const s = await h.create(agent, [], h.config("api"), instance);
  const call = (name: string, args: unknown) =>
    s.agent.state.tools
      .find((t) => t.name === name)!
      .execute(crypto.randomUUID(), args, new AbortController().signal);
  try {
    for (const name of [
      ...ALL_PI_TOOLS,
      "subagent",
      "bg_wait",
      "subagents_enable",
      "subagent_supervisor",
      "web_search",
      "web_fetch",
    ])
      expect(s.getActiveToolNames()).toContain(name);
    expect(s.systemPrompt).toContain(
      "Use web_search and web_fetch, powered by Firecrawl, instead of the browser",
    );
    await call("write", { path: "test.txt", content: "before\n" });
    await call("read", { path: "test.txt" });
    await call("edit", {
      path: "test.txt",
      edits: [{ oldText: "before", newText: "after" }],
    });
    expect(
      readFileSync(join(dir, "workspaces", agent.id, "test.txt"), "utf8"),
    ).toBe("after\n");
    for (const [name, args] of [
      ["ls", { path: "." }],
      ["find", { pattern: "*.txt", path: "." }],
      ["grep", { pattern: "after", path: "." }],
    ] as const)
      expect(JSON.stringify(await call(name, args))).toContain("test.txt");
    expect(
      JSON.stringify(await call("bash", { command: "pwd; cat test.txt" })),
    ).toContain("after");
    const outside = join(dir, "outside.txt");
    await call("write", { path: outside, content: "outside cwd is allowed" });
    expect(readFileSync(outside, "utf8")).toBe("outside cwd is allowed");
  } finally {
    await h.dispose(s);
  }
});
test("Harness composes Pi guidance with Jelly policy, append instructions, project context and skills across restored compaction", async () => {
  const dataDir = mkdtempSync(join(dir, "prompt-"));
  const cwd = join(dataDir, "workspace");
  const skillDir = join(cwd, ".pi", "skills", "prompt-fixture");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(dataDir, "SYSTEM.md"), "ignored-instance-system-marker");
  writeFileSync(join(cwd, ".pi", "SYSTEM.md"), "ignored-project-system-marker");
  writeFileSync(join(dataDir, "APPEND_SYSTEM.md"), "instance-append-marker");
  writeFileSync(join(dataDir, "AGENTS.md"), "instance-instruction-marker");
  const projectInstructions = join(cwd, "AGENTS.md");
  writeFileSync(projectInstructions, "project-instruction-v1-marker");
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: prompt-fixture\ndescription: Prompt composition fixture skill.\n---\nFixture skill body.\n",
  );
  const profile = {
    ...agent,
    cwd,
    name: "Prompt Fixture",
    instructions: "profile-instruction-marker",
  };
  const h = await Harness.create(dataDir, undefined, join(dataDir, "config"));
  useTestModel(h);
  const config = h.config("api", { model: "gpt-6-astra", effort: "high" });
  const assertPrompt = (prompt: string, append: string, project: string) => {
    for (const guidance of [
      "multiple disjoint edits in one call",
      "Use write only for new files or complete rewrites.",
      "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
      "Each edits[].oldText is matched against the original file",
      "Pi documentation (read only when the user asks about pi itself",
      "You are Prompt Fixture, a persistent agent in Jelly.",
      profile.instructions,
      "All tools and subagent delegation are pre-authorized by the operator.",
      "Use the same provider/model and effort as this parent for delegated work unless asked otherwise.",
      "Use request_sudo for privileged commands",
      "Never ask for passwords in chat.",
      "Use request_browser_login when a website requires sign-in",
      "Use web_search and web_fetch, powered by Firecrawl, instead of the browser",
      "MCP servers are user-wide, shared by all Jelly agents and projects.",
      h.mcps.configPath,
      "instance-instruction-marker",
      project,
      append,
      "Prompt composition fixture skill.",
      join(skillDir, "SKILL.md"),
    ])
      expect(prompt).toContain(guidance);
    expect(prompt).not.toContain("ignored-instance-system-marker");
    expect(prompt).not.toContain("ignored-project-system-marker");
    const ordered = [
      "<tools>",
      "<rules>",
      "<docs>",
      "<addendum>",
      "You are Prompt Fixture",
      profile.instructions,
      append,
      "<project_context>",
      "<skills>",
      "<cwd>",
    ].map((text) => prompt.indexOf(text));
    expect(ordered.every((index) => index >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
  };
  const s = await h.create(profile, [], config, instance);
  let checkpoint: Awaited<ReturnType<Harness["freshCheckpoint"]>>;
  try {
    expect(s.model?.provider).toBe(config.provider);
    expect(s.model?.id).toBe(config.model);
    assertPrompt(
      s.systemPrompt,
      "instance-append-marker",
      "project-instruction-v1-marker",
    );
    await s.prompt("Remember the prompt composition fixture.");
    // Native compaction requires a text-only response, unlike the tool-loop fixture.
    s.agent.streamFunction = (model) => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [
          { type: "text", text: "Remember the prompt composition fixture." },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    };
    const fresh = await h.freshCheckpoint(s);
    expect(fresh.compacted).toBe(true);
    assertPrompt(
      s.systemPrompt,
      "instance-append-marker",
      "project-instruction-v1-marker",
    );
    checkpoint = fresh;
  } finally {
    await h.dispose(s);
  }
  // Jelly creates a session per run; restored compaction must not freeze instructions.
  writeFileSync(projectInstructions, "project-instruction-v2-marker");
  writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "project-append-marker");
  const restored = await h.create(
    profile,
    [],
    config,
    instance,
    [],
    undefined,
    checkpoint.entries,
  );
  try {
    assertPrompt(
      restored.systemPrompt,
      "project-append-marker",
      "project-instruction-v2-marker",
    );
    expect(restored.systemPrompt).not.toContain(
      "project-instruction-v1-marker",
    );
    expect(restored.systemPrompt).not.toContain("instance-append-marker");
    await restored.prompt("Continue with the refreshed instructions.");
    assertPrompt(
      restored.systemPrompt,
      "project-append-marker",
      "project-instruction-v2-marker",
    );
  } finally {
    await h.dispose(restored);
  }
});
test("real pi-subagents workflow uses the parent provider and effort and supports abort", async () => {
  const h = await Harness.create(dir, undefined, join(dir, "config"));
  await h.auth.saveKey("sk-local-test-not-real");
  let slow = false;
  const requests: any[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      requests.push(await req.json());
      if (slow) await new Promise((r) => setTimeout(r, 500));
      const item = {
        type: "message",
        id: "msg_test",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "Child completed", annotations: [] },
        ],
      };
      const events = [
        { type: "response.created", response: { id: "resp_test" } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, content: [] },
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "resp_test",
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
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
  h.registry.registerProvider("openai", {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
  });
  const activities: string[] = [];
  const completions: Record<string, unknown>[] = [];
  const s = await h.create(
    agent,
    [],
    h.config("api", { model: "gpt-6.1-sol", effort: "high" }),
    instance,
    [],
    (type, data) => {
      activities.push(type);
      if (type === "subagent_completed") completions.push(data);
    },
  );
  const tool = s.agent.state.tools.find((t) => t.name === "subagent")!;
  const args = {
    workflowScript:
      'return await runs.run("child",{agent:"delegate",task:"Reply Child completed",acceptance:false})',
    async: false,
  };
  try {
    const result = await tool.execute(
      "child-test",
      args,
      new AbortController().signal,
    );
    expect(JSON.stringify(result)).toContain("Child completed");
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe("gpt-6.1-sol");
    expect(requests[0].reasoning.effort).toBe("high");
    for (const name of ALL_PI_TOOLS)
      expect(requests[0].tools.map((t: any) => t.name)).toContain(name);
    // Different parent defaults must not race through a shared project directory.
    const low = await h.create(
      { ...agent, id: "other-parent", managedCwd: 0 },
      [],
      h.config("api", { model: "gpt-6-sol", effort: "low" }),
      instance,
    );
    try {
      const lowTool = low.agent.state.tools.find((t) => t.name === "subagent")!;
      const before = requests.length;
      await Promise.all([
        tool.execute("shared-high", args, new AbortController().signal),
        lowTool.execute("shared-low", args, new AbortController().signal),
      ]);
      expect(
        requests
          .slice(before)
          .map((r) => r.reasoning.effort)
          .sort(),
      ).toEqual(["high", "low"]);
      expect(requests.slice(before).map(r => `${r.model}:${r.reasoning.effort}`).sort())
        .toEqual(["gpt-6-sol:low", "gpt-6.1-sol:high"].sort());
    } finally {
      await h.dispose(low);
    }
    const beforeCancel = requests.length;
    slow = true;
    const controller = new AbortController();
    const pending = tool
      .execute("cancel-test", args, controller.signal)
      .catch((e) => ({ error: String(e) }));
    const deadline = Date.now() + 5000;
    while (requests.length < beforeCancel + 1 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    expect(requests.length).toBe(beforeCancel + 1);
    controller.abort();
    const cancelled = await pending;
    expect(JSON.stringify(cancelled)).not.toContain('"ok":true');
    slow = false;
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          openai: { baseUrl: `http://127.0.0.1:${server.port}/v1` },
        },
      }),
    );
    await tool.execute(
      "async-test",
      { ...args, async: true },
      new AbortController().signal,
    );
    await h.settle(s);
    expect(activities).toContain("subagent_started");
    expect(activities).toContain("subagent_completed");
    expect(completions.at(-1)?.success).toBe(true);
    // A direct resume must not inherit launch-only model/session defaults.
    // Start a real persisted child against the local fixture, then resume it.
    await tool.execute(
      "resume-child",
      { agent: "delegate", task: "Reply Child completed", async: true, acceptance: false },
      new AbortController().signal,
    );
    await h.settle(s);
    expect(completions.at(-1)?.success).toBe(true);
    const completed = completions.at(-1)!;
    const childId = completed.runId ?? completed.id;
    expect(typeof childId).toBe("string");
    const beforeResume = requests.length;
    const resumed = await tool.execute(
      "direct-resume",
      { action: "resume", id: childId, message: "Continue and reply Child completed" },
      new AbortController().signal,
    );
    expect(JSON.stringify(resumed)).not.toContain("does not accept a model override");
    expect((resumed as { isError?: boolean }).isError).not.toBe(true);
    await h.settle(s);
    expect(requests.length).toBeGreaterThan(beforeResume);
    expect(requests.at(-1).model).toBe("gpt-6.1-sol");
    expect(requests.at(-1).reasoning.effort).toBe("high");
    expect(completions.at(-1)?.success).toBe(true);
    // Do not silently strip overrides that a caller actually supplies.
    await expect(tool.execute(
      "explicit-resume-override",
      { action: "resume", id: childId, message: "Continue", model: "openai/gpt-6-astra" },
      new AbortController().signal,
    )).rejects.toThrow("does not accept a model override");
  } finally {
    await h.dispose(s);
    server.stop(true);
  }
}, 15000);
