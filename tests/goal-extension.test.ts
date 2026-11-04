import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getCurrentSystemMessage,
  getCurrentTools,
  Type,
  type Context,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { Goals, goalPrompt } from "../src/server/goals";
import { goalExtension } from "../src/server/goal-extension";
import { guardRunRequests } from "../src/server/run-request-guard";
import { Store } from "../src/server/store";
import { SessionWork } from "../src/server/session-work";
import { fixtureModel } from "./fixtures/model";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 400 && !predicate(); i++) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test.each([
  { otherChild: false, queued: false },
  { otherChild: true, queued: false },
  { otherChild: false, queued: true },
])(
  "real Pi goal continues only after lost completion is consumed, retaining live-child guards (%j)",
  async ({ otherChild, queued }) => {
    const dir = mkdtempSync(join(tmpdir(), "jelly-goal-reconciliation-"));
    const store = new Store(join(dir, "test.sqlite"));
    const agent = store.addAgent({
      name: "Reconciliation fixture",
      instructions: "",
      color: "#123456",
    });
    const goals = new Goals(store);
    let goal = goals.mutate(agent.id, "create", {
      objective: "Verify local fixture",
      requestId: "create",
    }).goal;
    goal = goals.mutate(agent.id, "resume", {
      goalId: goal.id,
      expectedRevision: goal.revision,
      requestId: "resume",
    }).goal;
    const run = store.createRun(
      agent.id,
      "goal-run",
      goal.objective,
      "api",
      fixtureModel.id,
    );
    const binding = goals.admit(goal, run.id);
    let now = 0,
      failStatus = false;
    const work = new SessionWork(() => {}, {
      sessionRoot: dir,
      pollMs: 600000,
      reconciliationMs: 1000,
      now: () => now,
    });
    // Only the child's RPC/file transport is scripted. Pi boundaries, SessionWork
    // reconciliation/settlement, goal tools and durable goals are the real owners.
    work.bus.on("subagents:rpc:v1:request", (value) => {
      const request = value as { requestId: string; method: string };
      work.bus.emit(
        `subagents:rpc:v1:reply:${request.requestId}`,
        failStatus && request.method === "status"
          ? {
              success: false,
              error: {
                code: "execution_failed",
                message: "Fixture observation unavailable",
              },
            }
          : {
              success: true,
              data: request.method === "ping" ? { methods: ["status"] } : {},
            },
      );
    });
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });
    await runtime.setRuntimeApiKey("openai", "test-not-a-real-key");
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        goalExtension(
          goals,
          binding,
          () => !work.hasOutstandingWork(),
          () => false,
        ),
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      model: fixtureModel,
      modelRuntime: runtime,
      resourceLoader: loader,
      tools: ["jelly_goal"],
      sessionManager: SessionManager.inMemory(dir),
      settingsManager,
    });
    await session.bindExtensions({});
    session.setActiveToolsByName(["jelly_goal"]);
    const requests: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    session.agent.streamFunction = (model, context) => {
      requests.push(JSON.stringify(context.messages));
      const n = requests.length,
        completing = n === (otherChild ? 4 : 3);
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        model: model.id,
        provider: model.provider,
        timestamp: Date.now(),
        content: completing
          ? [
              {
                type: "toolCall",
                id: "complete-fixture",
                name: "jelly_goal",
                arguments: {
                  action: "complete",
                  summary: "Verified child results and the full local fixture.",
                },
              },
            ]
          : [
              {
                type: "text",
                text: "Progress observed; objective not yet complete.",
              },
            ],
        stopReason: completing ? "toolUse" : "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      void (async () => {
        if (n === (queued ? 1 : 2)) await held;
        stream.push({
          type: "done",
          reason: completing ? "toolUse" : "stop",
          message,
        });
        stream.end(message);
      })();
      return stream;
    };
    const status = (state: string) =>
      writeFileSync(
        join(dir, "status.json"),
        JSON.stringify({
          runId: "lost-child",
          sessionId: session.sessionManager.getSessionId(),
          state,
          steps: [{ agent: "worker", status: state }],
        }),
      );
    try {
      await work.attach(session);
      status("running");
      work.bus.emit("subagent:async-started", {
        id: "lost-child",
        asyncDir: dir,
      });
      const initialPrompt = session.prompt(goalPrompt(goal));
      if (queued) await until(() => requests.length === 1);
      else await initialPrompt;
      expect(requests).toHaveLength(1);
      expect(goals.get(agent.id)!.continuations).toBe(0);
      // A failed observation must still block. A later successful reconciliation
      // must clear that old uncertainty before its parent response settles.
      failStatus = true;
      await work.refresh();
      expect(work.hasOutstandingWork()).toBe(true);
      failStatus = false;
      if (otherChild)
        work.bus.emit("subagent:async-started", { id: "still-live" });
      status("complete");
      await work.refresh();
      now = 1001;
      await work.refresh();
      if (queued) {
        // sendCustomMessage has accepted the queued notice, but Pi has not yet
        // consumed it. Repeated refresh must neither acknowledge nor duplicate it.
        expect(work.hasOutstandingWork()).toBe(true);
        await work.refresh();
        await work.refresh();
        expect(requests).toHaveLength(1);
        release();
        await initialPrompt;
        await work.settle(session);
        expect(goals.get(agent.id)).toMatchObject({
          state: "completed",
          continuations: 1,
        });
        expect(requests).toHaveLength(4);
        expect(
          session.messages.filter(
            (message) =>
              message.role === "custom" &&
              message.customType === "jelly-subagent-status",
          ),
        ).toHaveLength(1);
        expect(work.hasOutstandingWork()).toBe(false);
        return;
      }
      await until(() => requests.length === 2);
      expect(requests[1]).toContain("completion reconciliation");
      // The terminal wake has been consumed, but its response remains in flight.
      expect(work.hasOutstandingWork()).toBe(otherChild);
      await work.refresh();
      await work.refresh();
      expect(requests).toHaveLength(2); // no duplicate reconciliation while responding
      let settled = false;
      const done = work.settle(session).then(() => {
        settled = true;
      });
      await Bun.sleep(10);
      expect(settled).toBe(false); // consuming a wake must not dispose its active response
      release();
      if (otherChild) {
        await session.waitForIdle();
        expect(requests).toHaveLength(2);
        expect(goals.get(agent.id)!.continuations).toBe(0);
        expect(settled).toBe(false);
        work.bus.emit("subagent:async-complete", {
          id: "still-live",
          state: "complete",
        });
        await session.sendCustomMessage(
          {
            customType: "fixture-native-completion",
            content: "The remaining fixture child completed. Inspect results.",
            display: false,
          },
          { triggerTurn: true },
        );
      }
      await done;
      expect(goals.get(agent.id)).toMatchObject({
        state: "completed",
        continuations: 1,
      });
      expect(requests).toHaveLength(otherChild ? 5 : 4);
      expect(
        session.sessionManager
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "custom_message" &&
              entry.customType === "jelly-subagent-status",
          ),
      ).toHaveLength(1);
      expect(work.hasOutstandingWork()).toBe(false);
    } finally {
      release();
      await work.dispose(session);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
async function promptFixture(options: {
  earlier?: ExtensionFactory;
  canContinue?: () => boolean;
  reply: (
    context: Context,
    n: number,
  ) => Partial<AssistantMessage> | Promise<Partial<AssistantMessage>>;
}) {
  const dir = mkdtempSync(join(tmpdir(), "jelly-goal-prompts-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "fixture.sqlite"));
  cleanup.push(() => store.close());
  const agent = store.addAgent({
    name: "Prompt fixture",
    instructions: "",
    color: "#123456",
  });
  const goals = new Goals(store);
  let goal = goals.mutate(agent.id, "create", {
    objective: "FULL OBJECTIVE sentinel",
    requestId: "create",
  }).goal;
  goal = goals.mutate(agent.id, "resume", {
    goalId: goal.id,
    expectedRevision: goal.revision,
    requestId: "resume",
  }).goal;
  const run = store.createRun(
    agent.id,
    "fixture",
    "Fixture",
    "api",
    fixtureModel.id,
  );
  const binding = goals.admit(goal, run.id);
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    allowModelNetwork: false,
  });
  await runtime.setRuntimeApiKey("openai", "test-not-a-real-key");
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 0 },
    retry: { enabled: false },
  });
  let safetyStopped = false;
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      (pi) => {
        pi.registerTool({
          name: "fixture_ping",
          label: "Ping",
          description: "Local fixture tool",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: "text", text: "pong" }],
            details: {},
          }),
        });
        pi.on("before_agent_start", (event) => {
          event.systemPromptOptions.sections.fixture =
            "Unrelated prompt must survive";
        });
      },
      ...(options.earlier ? [options.earlier] : []),
      goalExtension(
        goals,
        binding,
        options.canContinue ?? (() => true),
        (entryId) => {
          store.db.transaction(() => {
            store.saveContext(agent.id, run.id, [
              session.sessionManager.getHeader()!,
              ...session.sessionManager.getBranch(),
            ]);
            goals.compacted(binding, entryId);
          })();
          safetyStopped = goals.byId(goal.id)!.compactions >= 100;
          return safetyStopped;
        },
      ),
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model: fixtureModel,
    modelRuntime: runtime,
    resourceLoader: loader,
    tools: ["fixture_ping", "jelly_goal"],
    sessionManager: SessionManager.inMemory(dir),
    settingsManager,
  });
  cleanup.push(() => session.dispose());
  await session.bindExtensions({});
  const requests: Context[] = [];
  guardRunRequests(session, () => safetyStopped);
  session.agent.streamFunction = (model, context) => {
    requests.push(structuredClone(context));
    const n = requests.length;
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const data = await options.reply(context, n);
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        model: model.id,
        provider: model.provider,
        timestamp: Date.now(),
        content: [{ type: "text", text: "Fixture response" }],
        stopReason: "stop",
        usage: {
          input: 1,
          cacheWrite: 0,
          cacheRead: 0,
          output: 1,
          totalTokens: 2,
          cost: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 },
        },
        ...data,
      };
      stream.push({
        type: "done",
        reason: message.stopReason as "stop" | "toolUse",
        message,
      });
      stream.end(message);
    })();
    return stream;
  };
  return {
    session,
    settingsManager,
    goals,
    goal,
    binding,
    requests,
    agent,
    store,
    run,
    runtime,
    dir,
  };
}
const ping = (): Partial<AssistantMessage> => ({
  stopReason: "toolUse",
  content: [
    {
      type: "toolCall",
      id: crypto.randomUUID(),
      name: "fixture_ping",
      arguments: {},
    },
  ],
});

test.each(["continuation"] as const)(
  "real Pi %s composes earlier extension drafts, retaining history but one current request envelope",
  async (boundary) => {
    const f = await promptFixture({
      earlier: (pi) => {
        pi.on("turn_end", (event) => ({
          entries: [
            ...event.entries,
            {
              type: "custom_message",
              customType: "earlier-turn_end",
              display: false,
              content: "sentinel-turn_end",
            },
          ],
        }));
        pi.on("agent_before_settle", (event) => ({
          entries: [
            ...event.entries,
            {
              type: "custom_message",
              customType: "earlier-agent_before_settle",
              display: false,
              content: "sentinel-agent_before_settle",
            },
          ],
        }));
      },
      reply: (_context, n) => {
        if (n === 4) f.goals.stop(f.agent.id, "Fixture finished");
        return {};
      },
    });
    await f.session.prompt("Start fixture");
    expect(f.requests).toHaveLength(4);
    const branch = f.session.sessionManager.getBranch();
    const kinds = branch
      .filter((e) => e.type === "custom_message")
      .map((e) => e.customType);
    expect(kinds).toContain("earlier-turn_end");
    expect(kinds).toContain("earlier-agent_before_settle");
    expect(kinds.filter((k) => k === "jelly_goal_continuation")).toHaveLength(
      3,
    );
    const last = f.requests.at(-1)!;
    expect(last.messages[0]?.role).toBe("system");
    expect(last.messages[0]).toEqual(f.requests[0]!.messages[0]);
    expect(
      getCurrentTools(last.messages)
        .map((t) => t.name)
        .sort(),
    ).toEqual(["fixture_ping", "jelly_goal"]);
    expect(getCurrentSystemMessage(last.messages)?.sections?.fixture).toContain(
      "Unrelated prompt must survive",
    );
    expect(JSON.stringify(last.messages)).toContain("sentinel-turn_end");
    if (boundary === "continuation")
      expect(JSON.stringify(last.messages)).toContain(
        "sentinel-agent_before_settle",
      );
    expect(
      JSON.stringify(last.messages).split("FULL OBJECTIVE sentinel"),
    ).toHaveLength(2);
    expect(f.goals.byId(f.goal.id)!.continuations).toBe(3);
  },
);

test.each([false, true])(
  "native idle wake and ordinary follow-up retain fresh authority after real compaction (pause during summary=%j)",
  async (pause) => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let summaries = 0,
      normal = 0;
    const f = await promptFixture({
      canContinue: () => false, // native work owns wakes; never a second goal wake
      reply: async (context) => {
        if (
          JSON.stringify(context.messages[0]).includes(
            "context summarization assistant",
          )
        ) {
          summaries++;
          await held;
          return {
            content: [
              {
                type: "text",
                text: "Compacted historical work. Old goal is active (deliberately stale).",
              },
            ],
          };
        }
        normal++;
        return normal === 2 ? ping() : {};
      },
    });
    await f.session.prompt("Start fixture");
    f.goals.update(f.binding, "active", "LATEST PROGRESS sentinel");
    const compacting = f.session.compact();
    await until(() => summaries === 1);
    const summaryRequest = f.requests.at(-1)!;
    expect(JSON.stringify(summaryRequest)).toContain(
      "Jelly goal summarization snapshot (not authorization to act)",
    );
    expect(JSON.stringify(summaryRequest)).toContain("FULL OBJECTIVE sentinel");
    expect(JSON.stringify(summaryRequest)).toContain(
      "LATEST PROGRESS sentinel",
    );
    expect(JSON.stringify(summaryRequest)).not.toContain(
      "Continue useful work",
    );
    if (pause) f.goals.stop(f.agent.id, "Human takeover during compaction");
    release();
    await compacting;
    expect(
      f.session.sessionManager.getBranch().some((e) => e.type === "compaction"),
    ).toBe(true);
    await f.session.sendCustomMessage(
      {
        customType: "fixture-child-completion",
        content: "Native child finished",
        display: false,
      },
      { triggerTurn: true },
    );
    expect(normal).toBe(3);
    expect(summaries).toBe(1);
    expect(f.goals.byId(f.goal.id)!.continuations).toBe(0);
    for (const context of f.requests.slice(-2)) {
      const current = getCurrentSystemMessage(context.messages)!;
      expect(context.messages[0]?.role).toBe("system");
      expect(
        getCurrentTools(context.messages)
          .map((t) => t.name)
          .sort(),
      ).toEqual(["fixture_ping", "jelly_goal"]);
      expect(current.sections?.jelly_goal).toContain(
        pause ? "no longer active" : "FULL OBJECTIVE sentinel",
      );
      if (!pause)
        expect(current.sections?.jelly_goal).toContain(
          "LATEST PROGRESS sentinel",
        );
      expect(JSON.stringify(context.messages)).toContain(
        "Native child finished",
      );
    }
    expect(
      f.requests
        .at(-1)!
        .messages.some(
          (m) => m.role === "toolResult" && m.toolName === "fixture_ping",
        ),
    ).toBe(true);
  },
);

test("a preceding forced-prompt extension blocks goal continuation without rewriting its prompt or dropping tools", async () => {
  const f = await promptFixture({
    earlier: (pi) => {
      pi.on("before_agent_start", () => ({
        systemPrompt: "EXACT forced prompt",
      }));
    },
    reply: () => ({}),
  });
  await f.session.prompt("Fixture only");
  expect(f.requests).toHaveLength(1);
  expect(getCurrentSystemMessage(f.requests[0]!.messages)?.content).toBe(
    "EXACT forced prompt",
  );
  // Exact installed 0.87.1 behavior: outer forced projection discards sections.
  expect(
    getCurrentSystemMessage(f.requests[0]!.messages)?.sections?.jelly_goal,
  ).toBeUndefined();
  expect(getCurrentTools(f.requests[0]!.messages)).toHaveLength(2);
  expect(f.goals.byId(f.goal.id)).toMatchObject({
    state: "blocked",
    continuations: 0,
  });
  expect(f.goals.byId(f.goal.id)!.reason).toContain("forced system prompt");
});

test("request hygiene removes only owned historical goal instructions and never durable history", async () => {
  const f = await promptFixture({
    canContinue: () => false,
    reply: () => ({}),
  });
  for (const [customType, content] of [
    ["jelly_goal_continuation", "OLD full objective snapshot"],
    ["jelly_goal_budget_limit", "OLD budget instruction"],
    ["another-extension", "Jelly goal text is not an ownership marker"],
  ])
    await f.session.sendCustomMessage({
      customType: customType!,
      content: content!,
      display: false,
    });
  await f.session.prompt(
    "Human text mentioning jelly_goal_continuation must survive",
  );
  const text = JSON.stringify(f.requests[0]!.messages);
  expect(text).not.toContain("OLD full objective snapshot");
  expect(text).not.toContain("OLD budget instruction");
  expect(text).toContain("Jelly goal text is not an ownership marker");
  expect(text).toContain(
    "Human text mentioning jelly_goal_continuation must survive",
  );
  expect(text.split("FULL OBJECTIVE sentinel")).toHaveLength(2);
  expect(JSON.stringify(f.session.sessionManager.getBranch())).toContain(
    "OLD full objective snapshot",
  );
  expect(JSON.stringify(f.session.sessionManager.getBranch())).toContain(
    "OLD budget instruction",
  );
});

test("automatic compaction between a native idle wake's ordinary tool and follow-up preserves current scope", async () => {
  const sequence: string[] = [];
  let normal = 0;
  const f = await promptFixture({
    canContinue: () => false,
    earlier: (pi) => {
      pi.on("session_before_compact", (event) => {
        for (const messages of [
          event.preparation.messagesToSummarize,
          event.preparation.turnPrefixMessages,
        ])
          if (messages.length)
            messages.push({
              role: "user",
              content: "Earlier compaction hook sentinel",
              timestamp: 0,
            });
      });
    },
    reply: (context) => {
      if (
        JSON.stringify(context.messages[0]).includes(
          "context summarization assistant",
        )
      ) {
        sequence.push("summary");
        expect(JSON.stringify(context)).toContain(
          "Earlier compaction hook sentinel",
        );
        expect(JSON.stringify(context)).toContain(
          "Jelly goal summarization snapshot",
        );
        expect(JSON.stringify(context)).toContain("FULL OBJECTIVE sentinel");
        return {
          content: [
            { type: "text", text: "Historical fixture tool work summarized" },
          ],
        };
      }
      sequence.push("normal");
      normal++;
      if (normal === 2)
        return {
          ...ping(),
          usage: {
            input: 120000,
            output: 1,
            cacheWrite: 0,
            cacheRead: 0,
            totalTokens: 120001,
            cost: {
              input: 0,
              output: 0,
              cacheWrite: 0,
              cacheRead: 0,
              total: 0,
            },
          },
        };
      return {};
    },
  });
  await f.session.prompt("Start fixture");
  f.goals.update(f.binding, "active", "Progress survives the summary");
  f.settingsManager.setCompactionEnabled(true);
  await f.session.sendCustomMessage(
    {
      customType: "fixture-child-completion",
      content: "Native child completion",
      display: false,
    },
    { triggerTurn: true },
  );
  expect(sequence).toEqual([
    "normal",
    "normal",
    "summary",
    "summary",
    "normal",
  ]);
  const last = f.requests.at(-1)!;
  expect(
    getCurrentSystemMessage(last.messages)?.sections?.jelly_goal,
  ).toContain("FULL OBJECTIVE sentinel");
  expect(
    getCurrentSystemMessage(last.messages)?.sections?.jelly_goal,
  ).toContain("Progress survives the summary");
  expect(getCurrentTools(last.messages)).toHaveLength(2);
  expect(f.goals.byId(f.goal.id)!.continuations).toBe(0);
});

test("manual identical-summary compactions use new entry identities; failed/cancelled attempts and duplicate callbacks do not count", async () => {
  let cancel = true;
  const f = await promptFixture({
    canContinue: () => false,
    earlier: (pi) => {
      pi.on("session_before_compact", () =>
        cancel ? { cancel: true } : undefined,
      );
    },
    reply: () => ({ content: [{ type: "text", text: "Identical summary" }] }),
  });
  await f.session.prompt("Start");
  await expect(f.session.compact()).rejects.toThrow();
  expect(f.goals.get(f.agent.id)!.compactions).toBe(0);
  cancel = false;
  for (let n = 1; n <= 3; n++) {
    if (n > 1) await f.session.prompt(`More evidence ${n}`);
    await f.session.compact();
    expect(f.goals.get(f.agent.id)!.compactions).toBe(n);
    const entry = f.session.sessionManager
      .getBranch()
      .findLast((e) => e.type === "compaction")!;
    if (entry.type !== "compaction") throw new Error("missing compaction");
    await f.session.extensionRunner.emit({
      type: "session_compact",
      compactionEntry: entry,
      fromExtension: false,
      reason: "manual",
      willRetry: false,
    });
    expect(f.goals.get(f.agent.id)!.compactions).toBe(n);
  }
});

test("pre-prompt 100th compaction cannot issue a provider request even when Pi resets its abort flag", async () => {
  let normal = 0;
  const f = await promptFixture({
    canContinue: () => false,
    reply: (context) => {
      if (
        JSON.stringify(context.messages[0]).includes(
          "context summarization assistant",
        )
      )
        return {};
      normal++;
      return {
        usage: {
          input: 200000,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 200001,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    },
  });
  await f.session.prompt("Initial evidence");
  for (let n = 0; n < 99; n++)
    f.store.db.transaction(() =>
      f.goals.compacted(f.binding, `earlier-${n}`),
    )();
  expect(f.goals.get(f.agent.id)!.state).toBe("active");
  f.settingsManager.setCompactionEnabled(true);
  await f.session.prompt("Native wake after idle");
  expect(f.goals.get(f.agent.id)).toMatchObject({
    state: "paused",
    compactions: 100,
  });
  expect(normal).toBe(1);
  await f.session.sendCustomMessage(
    {
      customType: "child-complete",
      content: "Native child wake",
      display: false,
    },
    { triggerTurn: true },
  );
  expect(normal).toBe(1);
});

test("public goal request guard preserves earlier hooks and checks again after awaited work", async () => {
  const f = await promptFixture({
    canContinue: () => false,
    reply: () => ({}),
  });
  let stopped = false,
    calls = 0;
  const prior = f.session.agent.prepareRequest!;
  f.session.agent.prepareRequest = async (request, signal) => {
    calls++;
    const result = await prior(request, signal);
    if (calls === 2) stopped = true;
    return result ?? undefined;
  };
  guardRunRequests(f.session, () => stopped);
  await f.session.prompt("Allowed");
  expect(f.requests).toHaveLength(1);
  await f.session.prompt("Fenced during hook");
  expect(f.requests).toHaveLength(1);
  await f.session.prompt("Already fenced");
  expect(calls).toBe(2);
});

test("restored generated admissions and full legacy tool records never leak policy, while human evidence survives", async () => {
  const f = await promptFixture({
    canContinue: () => false,
    reply: () => ({}),
  });
  const legacyPrompt =
    "[Jelly goal historical]\nParent-session continuation token budget: 876543/999999";
  f.store.db
    .query("UPDATE runs SET prompt=? WHERE id=?")
    .run(legacyPrompt, f.run.id);
  const legacy = {
    ...f.goal,
    tokenBudget: 999999,
    tokensUsed: 876543,
    compactions: 89,
    reason: "100 successful compactions",
  };
  f.session.sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: legacyPrompt }],
    timestamp: 0,
  });
  f.session.sessionManager.appendMessage({
    role: "toolResult",
    toolName: "jelly_goal",
    toolCallId: "legacy",
    isError: false,
    content: [{ type: "text", text: JSON.stringify(legacy) }],
    details: legacy,
    timestamp: 0,
  });
  await f.session.prompt(
    "Human evidence mentions token budget; do not strip my source text.",
  );
  await f.session.compact();
  for (const context of f.requests) {
    const text = JSON.stringify(context);
    expect(text).not.toMatch(
      /999999|876543|compactions|100 successful|tokenBudget|tokensUsed/,
    );
  }
  expect(JSON.stringify(f.requests[0])).toContain(
    "Human evidence mentions token budget",
  );
  expect(JSON.stringify(f.requests.slice(1))).toContain(
    "Human evidence mentions token budget",
  );
  expect(JSON.stringify(f.session.sessionManager.getBranch())).toContain(
    "876543",
  );
});

test("a failed summarizer produces no successful compaction ledger entry", async () => {
  const f = await promptFixture({
    canContinue: () => false,
    reply: (context) =>
      JSON.stringify(context.messages[0]).includes(
        "context summarization assistant",
      )
        ? {
            content: [],
            stopReason: "error",
            errorMessage: "Local summary failure",
          }
        : {},
  });
  await f.session.prompt("Evidence");
  await expect(f.session.compact()).rejects.toThrow();
  expect(f.goals.get(f.agent.id)!.compactions).toBe(0);
  expect(f.store.db.query("SELECT * FROM goal_compactions").all()).toHaveLength(
    0,
  );
});

test("a separate native child session compacts without inheriting parent goal accounting", async () => {
  const f = await promptFixture({
    canContinue: () => false,
    reply: () => ({}),
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 0 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: f.dir,
    agentDir: f.dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  const { session: child } = await createAgentSession({
    cwd: f.dir,
    agentDir: f.dir,
    model: fixtureModel,
    modelRuntime: f.runtime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(f.dir),
    tools: [],
  });
  cleanup.push(() => child.dispose());
  await child.bindExtensions({});
  child.agent.streamFunction = f.session.agent.streamFunction;
  await child.prompt("Child work");
  await child.compact();
  expect(
    child.sessionManager
      .getBranch()
      .some((entry) => entry.type === "compaction"),
  ).toBe(true);
  expect(child.getAllTools().some((tool) => tool.name === "jelly_goal")).toBe(
    false,
  );
  expect(f.goals.get(f.agent.id)!.compactions).toBe(0);
  expect(f.store.db.query("SELECT * FROM goal_compactions").all()).toHaveLength(
    0,
  );
});
