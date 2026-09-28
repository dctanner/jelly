import { useTestModel } from "./fixtures/app";
import { test, expect, afterAll } from "bun:test";
import { Harness } from "../src/server/harness";
import { ALL_PI_TOOLS } from "../src/server/pi-setup";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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
    h.config("api", { model: "gpt-6-sol", effort: "high" }),
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
    expect(requests[0].model).toBe("gpt-6-sol");
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
      expect(requests.slice(before).every((r) => r.model === "gpt-6-sol")).toBe(
        true,
      );
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
  } finally {
    await h.dispose(s);
    server.stop(true);
  }
}, 15000);
