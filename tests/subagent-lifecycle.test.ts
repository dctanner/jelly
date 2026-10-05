import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { fixtureModel } from "./fixtures/model";
import { SessionWork } from "../src/server/session-work";
import { SubagentProjection } from "../src/server/subagent-projection";
import { prepareSubagentLiveness } from "../src/server/subagent-liveness";
import { extensionUI } from "../src/server/extension-ui";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await tick();
  expect(predicate()).toBe(true);
}
async function parent(dir: string) {
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    allowModelNetwork: false,
  });
  await runtime.setRuntimeApiKey("openai", "sk-fixture-not-real");
  const loader: ResourceLoader = {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Test parent",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model: fixtureModel,
    modelRuntime: runtime,
    resourceLoader: loader,
    tools: [],
    sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  });
  const requests: string[] = [];
  session.agent.streamFunction = (model, context) => {
    requests.push(JSON.stringify(context.messages));
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Progress noted; yielding." }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
  return { session, requests };
}
function fixtureRpc(work: SessionWork, failStatus = () => false) {
  work.bus.on("subagents:rpc:v1:request", (value) => {
    const request = value as any;
    work.bus.emit(
      `subagents:rpc:v1:reply:${request.requestId}`,
      failStatus() && request.method === "status"
        ? {
            success: false,
            error: {
              code: "execution_failed",
              message: "private /secret/path",
            },
          }
        : {
            success: true,
            data: request.method === "ping" ? { methods: ["status"] } : {},
          },
    );
  });
}

test("five-minute checkpoint reaches a real Pi model request while children remain running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-subagent-heartbeat-"));
  const { session, requests } = await parent(dir);
  let now = 0;
  const reports: any[] = [];
  const work = new SessionWork((type, data) => reports.push({ type, data }), {
    sessionRoot: dir,
    pollMs: 600000,
    now: () => now,
  });
  fixtureRpc(work);
  try {
    await work.attach(session);
    await session.prompt("Start delegated work");
    const file = join(dir, "status.json");
    writeFileSync(
      file,
      JSON.stringify({
        runId: "workflow",
        sessionId: session.sessionManager.getSessionId(),
        mode: "workflow",
        state: "running",
        steps: [
          {
            workflowKey: "backend",
            agent: "worker",
            status: "completed",
            startedAt: 0,
          },
          {
            workflowKey: "mobile",
            agent: "worker",
            status: "running",
            currentTool: "bash",
            lastActivityAt: 299900,
            currentToolStartedAt: 280000,
            startedAt: 0,
          },
        ],
      }),
    );
    work.bus.emit("subagent:async-started", {
      id: "workflow",
      asyncDir: dir,
      mode: "workflow",
    });
    await work.refresh();
    expect(requests).toHaveLength(1);
    now = 299999;
    await work.refresh();
    expect(requests).toHaveLength(1);
    now = 300000;
    await work.refresh();
    await until(() => requests.length === 2);
    await session.waitForIdle();
    expect(requests[1]).toContain("Subagent status checkpoint");
    expect(requests[1]).toContain("mobile");
    expect(requests[1]).toContain("tool bash (20s)");
    expect(requests[1]).toContain("last activity 0s ago");
    expect(
      session.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    let settled = false;
    const done = work.settle(session).then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    work.bus.emit("subagent:async-complete", {
      id: "workflow",
      state: "complete",
    });
    await done;
    expect(settled).toBe(true);
    expect(reports.some((report) => report.type === "subagents_updated")).toBe(
      true,
    );
  } finally {
    await work.dispose(session);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("heartbeat coalesces behind an open tool and cancellation disarms future wakes", async () => {
  let now = 0,
    sends = 0;
  const session = {
    sessionManager: { getSessionId: () => "session" },
    subscribe: () => () => {},
    sendCustomMessage: async () => {
      sends++;
    },
    waitForIdle: async () => {},
  } as unknown as AgentSession;
  const work = new SessionWork(() => {}, { pollMs: 600000, now: () => now });
  fixtureRpc(work);
  await work.attach(session);
  work.bus.emit("subagent:async-started", { id: "child" });
  try {
    now = 300000;
    await work.refresh();
    expect(sends).toBe(1);
    now = 600000;
    await work.refresh();
    expect(sends).toBe(1);
    now = 900000;
    await work.refresh();
    expect(sends).toBe(1);
    await work.stop();
    now = 1200000;
    await work.refresh();
    expect(sends).toBe(1);
  } finally {
    await work.stop();
  }
});

test("terminal canonical status repairs a lost completion with a model wake, not silent success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-subagent-reconcile-"));
  const { session, requests } = await parent(dir);
  let now = 0;
  const work = new SessionWork(() => {}, {
    sessionRoot: dir,
    pollMs: 600000,
    now: () => now,
    reconciliationMs: 1000,
  });
  fixtureRpc(work);
  try {
    await work.attach(session);
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({
        runId: "child",
        sessionId: session.sessionManager.getSessionId(),
        state: "complete",
        steps: [{ agent: "worker", status: "complete" }],
      }),
    );
    work.bus.emit("subagent:async-started", { id: "child", asyncDir: dir });
    await work.refresh();
    expect(requests).toHaveLength(0);
    now = 1001;
    await work.refresh();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("completion reconciliation");
    await work.settle(session);
    expect(work.projection.snapshot().children[0]?.state).toBe("completed");
  } finally {
    await work.dispose(session);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending package notification delivery prevents disposal even after all job events complete", async () => {
  prepareSubagentLiveness();
  const registry = (globalThis as any)[
    Symbol.for("@agegr/pi-web/session-liveness/v1")
  ];
  let pending = true,
    settled = false;
  const release = registry.register({
    name: "test",
    sessionId: "batch-test",
    isActive: () => pending,
  });
  const session = {
    sessionManager: { getSessionId: () => "batch-test" },
    subscribe: () => () => {},
    waitForIdle: async () => {},
  } as unknown as AgentSession;
  const work = new SessionWork(() => {}, { pollMs: 600000 });
  fixtureRpc(work);
  await work.attach(session);
  const done = work.settle(session).then(() => {
    settled = true;
  });
  try {
    work.bus.emit("subagent:async-started", { id: "child" });
    work.bus.emit("subagent:async-complete", { id: "child" });
    await tick();
    expect(settled).toBe(false);
    pending = false;
    await done;
    expect(settled).toBe(true);
  } finally {
    pending = false;
    release();
    await work.stop();
    await done;
  }
});

test("projection correlates workflow updates and ignores delayed start hints after completion", () => {
  const projection = new SubagentProjection("/trusted/agent");
  projection.status("workflow", {
    mode: "workflow",
    steps: [
      {
        workflowKey: "writer",
        agent: "worker",
        status: "running",
        sessionFile: "/trusted/agent/a/session.jsonl",
        currentTool: "read",
        lastActivityAt: 30,
      },
    ],
  });
  const first = projection.snapshot().children[0]!;
  expect(first.inspectable).toBe(true);
  expect(JSON.stringify(projection.snapshot())).not.toContain("session.jsonl");
  projection.status("workflow", {
    mode: "workflow",
    steps: [
      {
        workflowKey: "writer",
        agent: "worker",
        status: "complete",
        endedAt: 40,
      },
    ],
  });
  projection.upsert(
    "workflow",
    "writer",
    { agent: "worker", status: "started" },
    "workflow",
    false,
  );
  expect(projection.snapshot().children).toHaveLength(1);
  expect(projection.snapshot().children[0]).toMatchObject({
    id: first.id,
    state: "completed",
    currentTool: undefined,
  });
  projection.status("other", {
    steps: [
      {
        agent: "worker",
        status: "running",
        sessionFile: "/trusted/agent-foreign/session.jsonl",
      },
    ],
  });
  expect(projection.snapshot().children[1]?.inspectable).toBe(false);
});

test("foreground progress beats provisional exit codes and metadata errors stay path-free", () => {
  const projection = new SubagentProjection("/trusted/agent");
  const update = (row: object) =>
    projection.tool({
      details: {
        runId: "foreground",
        results: [{ index: 0, agent: "worker", exitCode: 0, ...row }],
      },
    });
  update({ progress: { status: "running", currentTool: "bash" } });
  expect(projection.snapshot().children[0]).toMatchObject({
    state: "running",
    currentTool: "bash",
  });
  update({ detached: true, progress: { status: "completed" } });
  expect(projection.snapshot().children[0]?.state).toBe("paused");
  update({ interrupted: true });
  expect(projection.snapshot().children[0]?.state).toBe("paused");
  update({
    success: false,
    error: "Missing /private/artifacts/result.json",
    progress: { status: "completed" },
  });
  expect(projection.snapshot().children[0]?.state).toBe("failed");
  expect(projection.snapshot().children[0]?.error).toContain(
    "reported an error",
  );
  expect(JSON.stringify(projection.snapshot())).not.toContain("/private");
});

test("a new workflow attempt reopens the same card and rejects retired-attempt updates", () => {
  const projection = new SubagentProjection("/trusted/agent");
  const update = (runId: string, status: string) =>
    projection.status("workflow", {
      mode: "workflow",
      steps: [
        {
          workflowKey: "writer",
          runId,
          status,
          agent: "worker",
          sessionFile: `/trusted/agent/${runId}/session.jsonl`,
          ...(status === "failed" ? { endedAt: 100, error: "failed" } : {}),
        },
      ],
    });
  update("attempt-one", "failed");
  const id = projection.snapshot().children[0]!.id;
  update("attempt-two", "running");
  expect(projection.snapshot().children).toHaveLength(1);
  expect(projection.snapshot().children[0]).toMatchObject({
    id,
    state: "running",
  });
  expect(projection.snapshot().children[0]?.endedAt).toBeUndefined();
  expect(projection.snapshot().children[0]?.error).toBeUndefined();
  expect(projection.sources[id]?.sessionFile).toContain("attempt-two");
  update("attempt-one", "failed");
  expect(projection.snapshot().children[0]?.state).toBe("running");
  expect(projection.sources[id]?.sessionFile).toContain("attempt-two");
});

test("snapshot activity overlays stale workflow files while unreadable roots cannot suppress checkpoints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-subagent-overlay-"));
  const good = join(dir, "good"),
    bad = join(dir, "bad");
  mkdirSync(good);
  mkdirSync(bad);
  const { session, requests } = await parent(dir);
  let now = 0;
  const work = new SessionWork(() => {}, {
    sessionRoot: dir,
    pollMs: 600000,
    now: () => now,
  });
  work.bus.on("subagents:rpc:v1:request", (value) => {
    const request = value as any;
    work.bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      success: true,
      data:
        request.method === "ping"
          ? { methods: ["status"] }
          : {
              asyncSnapshot: {
                version: 1,
                runs: [
                  {
                    id: "good",
                    kind: "workflow",
                    state: "running",
                    children: [
                      {
                        id: "writer",
                        kind: "step",
                        state: "running",
                        activity: {
                          currentTool: "bash",
                          lastActivityAt: 299000,
                        },
                      },
                    ],
                  },
                ],
              },
            },
    });
  });
  const status = {
    runId: "good",
    sessionId: session.sessionManager.getSessionId(),
    mode: "workflow",
    state: "running",
    steps: [
      {
        workflowKey: "writer",
        runId: "attempt",
        agent: "worker",
        status: "running",
        currentTool: "read",
        lastActivityAt: 10,
      },
    ],
  };
  writeFileSync(join(good, "status.json"), JSON.stringify(status));
  // Even a registered root cannot redirect status reads through a symlink.
  writeFileSync(
    join(dir, "private-status.json"),
    JSON.stringify({ ...status, runId: "bad" }),
  );
  symlinkSync(join(dir, "private-status.json"), join(bad, "status.json"));
  try {
    await work.attach(session);
    work.bus.emit("subagent:async-started", { id: "bad", asyncDir: bad });
    work.bus.emit("subagent:async-started", { id: "good", asyncDir: good });
    await work.refresh(); // establish the concrete attempt before overlaying a later snapshot
    now = 300000;
    await work.refresh();
    await until(() => requests.length === 1);
    expect(work.projection.snapshot().children).toHaveLength(1);
    expect(work.projection.snapshot().children[0]).toMatchObject({
      currentTool: "bash",
      lastActivityAt: 299000,
    });
    expect(work.projection.snapshot().error).toContain(
      "could not be refreshed",
    );
    expect(requests[0]).toContain("tool bash");
    expect(requests[0]).toContain("could not be refreshed");
    expect(requests[0]).not.toContain(dir);
  } finally {
    await work.dispose(session);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an identity-less stale snapshot cannot terminalize a new attempt, and activity attention survives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-subagent-attempt-race-"));
  const { session } = await parent(dir);
  const work = new SessionWork(() => {}, { sessionRoot: dir, pollMs: 600000 });
  let snapshotState = "failed";
  work.bus.on("subagents:rpc:v1:request", (value) => {
    const request = value as any;
    work.bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      success: true,
      data:
        request.method === "ping"
          ? { methods: ["status"] }
          : {
              asyncSnapshot: {
                version: 1,
                runs: [
                  {
                    id: "workflow",
                    kind: "workflow",
                    state: "running",
                    children: [
                      {
                        id: "writer",
                        kind: "step",
                        state: snapshotState,
                        activity: {
                          state: "needs_attention",
                          currentTool: "bash",
                        },
                      },
                    ],
                  },
                ],
              },
            },
    });
  });
  work.projection.status("workflow", {
    mode: "workflow",
    steps: [{ workflowKey: "writer", runId: "attempt-a", status: "failed" }],
  });
  writeFileSync(
    join(dir, "status.json"),
    JSON.stringify({
      runId: "workflow",
      sessionId: session.sessionManager.getSessionId(),
      mode: "workflow",
      state: "running",
      steps: [{ workflowKey: "writer", runId: "attempt-b", status: "running" }],
    }),
  );
  try {
    await work.attach(session);
    work.bus.emit("subagent:async-started", { id: "workflow", asyncDir: dir });
    await work.refresh();
    expect(work.projection.snapshot().children[0]?.state).toBe("running");
    await work.refresh(); // even a repeated stale snapshot cannot poison B
    expect(work.projection.snapshot().children[0]?.state).toBe("running");
    snapshotState = "running";
    await work.refresh();
    expect(work.projection.snapshot().children[0]?.attention).toContain(
      "supervisor",
    );
    expect(work.projection.snapshot().children[0]?.currentTool).toBe("bash");
  } finally {
    await work.dispose(session);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stop retains cancellation ownership of live children after workflow dispatch completes", async () => {
  const work = new SessionWork(() => {});
  const stopped: string[] = [];
  work.bus.on("subagents:rpc:v1:request", (value) => {
    const request = value as any;
    if (request.method === "stop") stopped.push(request.params.id);
    work.bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      success: true,
      data: {},
    });
  });
  work.bus.emit("subagent:async-started", { id: "workflow" });
  work.bus.emit("subagent:async-started", {
    id: "detached-child",
    parentWorkflowRunId: "workflow",
  });
  work.bus.emit("subagent:async-complete", { id: "workflow" });
  await work.stop();
  expect(stopped).toEqual(["detached-child"]);
});

test("failed status stays observable, does not drop jobs, and does not expose private errors", async () => {
  const reports: any[] = [];
  const session = {
    sessionManager: { getSessionId: () => "failure-test" },
    subscribe: () => () => {},
    waitForIdle: async () => {},
  } as unknown as AgentSession;
  const work = new SessionWork((type, data) => reports.push({ type, data }), {
    pollMs: 600000,
  });
  fixtureRpc(work, () => true);
  await work.attach(session);
  work.bus.emit("subagent:async-started", { id: "child" });
  await work.refresh();
  expect(work.projection.snapshot().error).toContain("could not be refreshed");
  expect(JSON.stringify(reports)).not.toContain("/secret/path");
  let settled = false;
  const done = work.settle(session).then(() => {
    settled = true;
  });
  await tick();
  expect(settled).toBe(false);
  await work.stop();
  await done;
});

test("web extension UI forwards widgets/notices and explicitly cancels unsupported dialogs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-extension-ui-"));
  const { session } = await parent(dir);
  const events: any[] = [],
    widgets: any[] = [];
  try {
    const ui = extensionUI(
      session.extensionRunner.getUIContext(),
      (type, data) => events.push({ type, data }),
      (key, lines) => widgets.push({ key, lines }),
    );
    ui.notify("Child needs attention", "warning");
    ui.setWidget("status", ["Running"]);
    expect(await ui.confirm("Delete something", "Confirm")).toBe(false);
    expect(await ui.input("Enter text")).toBeUndefined();
    expect(widgets).toEqual([{ key: "status", lines: ["Running"] }]);
    expect(
      events.filter((event) => event.type === "extension_notice"),
    ).toHaveLength(3);
  } finally {
    session.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
