import { afterEach, expect, spyOn, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  getCurrentSystemMessage,
  getCurrentTools,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import {
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./fixtures/app";
import { Store } from "../src/server/store";
import { Goals } from "../src/server/goals";
import type { GoalAction } from "../src/shared/goals";
const cleanup: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(
  reply?: (
    turn: number,
    context: Context,
  ) => Partial<AssistantMessage> | Promise<Partial<AssistantMessage>>,
  configure?: (session: AgentSession) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "jelly-goal-runtime-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startApp({
    dataDir: dir,
    authPath: join(dir, "auth.json"),
    configDir: join(dir, "config"),
    port: 0,
  });
  cleanup.push(() => app.close());
  const agent = app.service.createAgent({
    name: "Goal fixture",
    instructions: "Local deterministic fixture only",
    color: "#123456",
  });
  const original = app.service.harness.create.bind(app.service.harness);
  let turns = 0;
  const sessions: AgentSession[] = [];
  app.service.harness.create = async (...args) => {
    expect(app.store.db.inTransaction).toBe(false);
    const session = await original(...args);
    sessions.push(session);
    session.agent.streamFunction = (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      const n = ++turns;
      void (async () => {
        const data = await reply?.(n, context);
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [{ type: "text", text: "Fixture progress" }],
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 10,
            output: 5,
            cacheRead: 100,
            cacheWrite: 3,
            totalTokens: 118,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          ...data,
        };
        if (options?.signal?.aborted) {
          message.stopReason = "aborted";
          message.errorMessage = "Fixture aborted";
        }
        if (message.stopReason === "error" || message.stopReason === "aborted")
          stream.push({
            type: "error",
            reason: message.stopReason,
            error: message,
          });
        else
          stream.push({
            type: "done",
            reason: message.stopReason as "stop" | "toolUse",
            message,
          });
        stream.end(message);
      })();
      return stream;
    };
    configure?.(session);
    return session;
  };
  const create = () =>
    app.service.changeGoal(agent.id, "create", {
      requestId: "create",
      objective: "Verify the local fixture only",
    }).goal!;
  const action = (action: GoalAction, extra = {}) => {
    const goal = app.service.goals.get(agent.id)!;
    return app.service.changeGoal(agent.id, action, {
      goalId: goal.id,
      expectedRevision: goal.revision,
      requestId: crypto.randomUUID(),
      ...extra,
    });
  };
  return { ...app, dir, agent, create, action, turns: () => turns, sessions };
}
function complete(): Partial<AssistantMessage> {
  return {
    stopReason: "toolUse",
    content: [
      {
        type: "toolCall",
        id: crypto.randomUUID(),
        name: "jelly_goal",
        arguments: {
          action: "complete",
          summary: "Verified every fixture requirement with local evidence.",
        },
      },
    ],
  };
}
async function until(fn: () => boolean) {
  for (let i = 0; i < 1000 && !fn(); i++) await Bun.sleep(5);
  expect(fn()).toBe(true);
}

test("real installed Pi boundary creates exactly one legal continuation then explicit tool completion, no numerical policy payload", async () => {
  const f = await fixture((turn, context) => {
    if (turn === 2) {
      expect(JSON.stringify(context)).toContain("Jelly goal");
      return complete();
    }
    if (turn === 3)
      expect(
        getCurrentSystemMessage(context.messages)?.sections?.jelly_goal,
      ).toContain("no longer active (completed)");
    return {};
  });
  const goal = f.create();
  f.action("resume");
  await f.service.settled();
  const current = f.service.goals.get(f.agent.id)!;
  expect(current.state).toBe("completed");
  expect(current.continuations).toBe(1);
  expect(f.turns()).toBe(3); // final answer after completion tool is admitted tool follow-up
  expect(f.store.runs(f.agent.id)).toHaveLength(1);
  expect(
    f.store.db.query("SELECT * FROM goal_runs WHERE goalId=?").all(goal.id),
  ).toHaveLength(1);
  expect(
    f.store
      .context(f.agent.id)!
      .filter(
        (e) =>
          e.type === "custom_message" &&
          e.customType === "jelly_goal_continuation",
      ),
  ).toHaveLength(1);
  expect(f.sessions[0]!.systemPrompt).toContain("<tools>");
  expect(f.sessions[0]!.systemPrompt).toContain("jelly_goal");
  expect(f.store.pendingMessages(f.agent.id)).toHaveLength(0);
});
test("more than 32 automatic continuations remain active and complete only by explicit tool", async () => {
  const f = await fixture((n) => (n === 40 ? complete() : {}));
  f.create();
  f.action("resume");
  await f.service.settled();
  expect(f.turns()).toBe(41);
  expect(f.service.goals.get(f.agent.id)).toMatchObject({
    state: "completed",
    continuations: 39,
    compactions: 0,
  });
});
test.each(["pause", "clear", "complete"] as const)(
  "%s during an admitted request fences the old goal without changing its compaction counter",
  async (action) => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const f = await fixture(async () => {
      await held;
      return {};
    });
    const original = f.create();
    f.action("resume");
    await until(() => f.turns() === 1);
    f.action(
      action,
      action === "complete" ? { summary: "Operator completion evidence" } : {},
    );
    release();
    await f.service.settled();
    expect(f.turns()).toBe(1);
    expect(f.service.goals.byId(original.id)!.compactions).toBe(0);
    expect(f.service.goals.byId(original.id)!.state).toBe(
      action === "pause"
        ? "paused"
        : action === "clear"
          ? "cleared"
          : "completed",
    );
  },
);
test("Stop before startup and while streaming cannot resurrect goals; human input wins", async () => {
  const f = await fixture();
  f.create();
  f.action("resume");
  await f.service.stop(f.agent.id);
  expect(f.service.goals.get(f.agent.id)!.state).toBe("paused");
  expect(f.turns()).toBe(0);
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const g = await fixture(async (n) => {
    if (n === 1) await held;
    return {};
  });
  g.create();
  g.action("resume");
  await until(() => g.turns() === 1);
  g.service.start(g.agent.id, "human", "Fixture human priority", "queue");
  expect(g.service.goals.get(g.agent.id)!.state).toBe("paused");
  release();
  await g.service.settled();
  expect(g.turns()).toBe(2);
  expect(g.store.runs(g.agent.id)).toHaveLength(2);
  expect(
    g.sessions[1]!.getAllTools().some((t) => t.name === "jelly_goal"),
  ).toBe(false);
});
test("errors and child-busy/unknown work do not loop or complete", async () => {
  const f = await fixture(() => ({
    stopReason: "error",
    errorMessage: "Local fixture error",
  }));
  f.create();
  f.action("resume");
  await f.service.settled();
  expect(f.turns()).toBe(1);
  expect(f.service.goals.get(f.agent.id)!.state).toBe("blocked");
  const g = await fixture();
  g.service.harness.hasChildWork = () => true;
  g.create();
  g.action("resume");
  await g.service.settled();
  expect(g.turns()).toBe(1);
  expect(g.service.goals.get(g.agent.id)!.state).toBe("blocked");
});
test("explicit resume preserves identity; Fresh Session and archive never resume stopped goals", async () => {
  const f = await fixture((n, context) => {
    if (n === 1) f.service.goals.stop(f.agent.id, "Fixture pause");
    if (
      JSON.stringify(context.messages[0]).includes(
        "context summarization assistant",
      )
    )
      return {};
    return f.service.goals.get(f.agent.id)?.state === "active"
      ? complete()
      : {};
  });
  const goal = f.create();
  f.action("resume");
  await f.service.settled();
  f.service.freshSession(f.agent.id, "fresh");
  await f.service.settled();
  expect(f.service.goals.get(f.agent.id)).toMatchObject({
    id: goal.id,
    state: "paused",
    compactions: 0,
  });
  f.service.archiveAgent(f.agent.id, true);
  expect(() => f.action("edit", { objective: goal.objective })).toThrow(
    "Restore",
  );
  f.service.archiveAgent(f.agent.id, false);
  expect(f.service.goals.get(f.agent.id)!.state).toBe("paused");
  f.action("resume");
  await f.service.settled();
  expect(f.service.goals.get(f.agent.id)).toMatchObject({
    id: goal.id,
    state: "completed",
  });
});
test("shutdown pauses before cancelling admitted work and fences late callbacks", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const f = await fixture(async () => {
    await held;
    return {};
  });
  f.create();
  f.action("resume");
  await until(() => f.turns() === 1);
  const closing = f.close();
  expect(f.service.goals.get(f.agent.id)!.state).toBe("paused");
  release();
  await closing;
});
test("simultaneous goal agents have one independent owner each and replayed resume does not duplicate admission", async () => {
  const f = await fixture((_n, context) =>
    context.messages.filter((message) => message.role !== "system").at(-1)
      ?.role === "toolResult"
      ? {}
      : complete(),
  );
  const goal = f.create();
  const input = {
    goalId: goal.id,
    expectedRevision: goal.revision,
    requestId: "stable-resume",
  };
  f.service.changeGoal(f.agent.id, "resume", input);
  f.service.changeGoal(f.agent.id, "resume", input);
  const other = f.service.createAgent({
    name: "Other fixture",
    instructions: "",
    color: "#123456",
  });
  const g = f.service.changeGoal(other.id, "create", {
    objective: "Independent fixture",
    requestId: "create",
  }).goal!;
  f.service.changeGoal(other.id, "resume", {
    goalId: g.id,
    expectedRevision: g.revision,
    requestId: "resume",
  });
  await f.service.settled();
  expect(f.store.runs(f.agent.id)).toHaveLength(1);
  expect(f.store.runs(other.id)).toHaveLength(1);
  expect(f.service.goals.get(f.agent.id)).toMatchObject({
    state: "completed",
  });
  expect(f.service.goals.get(other.id)).toMatchObject({
    state: "completed",
  });
});
test("bound model tools inspect, persist progress and report a blocker without completing", async () => {
  const actions = ["get", "progress", "block"];
  const f = await fixture((n) =>
    n <= actions.length
      ? {
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: `fixture-${n}`,
              name: "jelly_goal",
              arguments: {
                action: actions[n - 1],
                summary:
                  n === 3
                    ? "Fixture dependency unavailable"
                    : "Verified fixture step",
              },
            },
          ],
        }
      : {},
  );
  f.create();
  f.action("resume");
  await f.service.settled();
  expect(f.turns()).toBe(4);
  expect(f.service.goals.get(f.agent.id)).toMatchObject({
    state: "blocked",
    progress: "Fixture dependency unavailable",
    continuations: 0,
  });
});

test("Stop during a parent request fences late completion tools and cancels the aborted request", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const f = await fixture(async () => {
    await held;
    return complete();
  });
  f.create();
  f.action("resume");
  await until(() => f.turns() === 1);
  const stopping = f.service.stop(f.agent.id);
  expect(f.service.goals.get(f.agent.id)!.state).toBe("paused");
  release();
  await stopping;
  expect(f.service.goals.get(f.agent.id)).toMatchObject({
    state: "paused",
  });
  expect(f.turns()).toBe(1);
});

test("schedule/goal admission shares exclusivity and never displaces admitted work", async () => {
  const f = await fixture((n) => (n === 2 ? complete() : {}));
  const goal = f.create();
  const scheduled = f.service.schedules.create(f.agent.id, {
    title: "Fixture schedule",
    prompt: "Local fixture",
    kind: "once",
    runAt: new Date(Date.now() + 60000).toISOString(),
    timezone: "UTC",
    requestId: "schedule",
  });
  // Admit deterministic scheduled work through the same host seam with a due clock.
  const schedule = f.service.schedules.get(f.agent.id, scheduled.schedule.id);
  f.store.db
    .query("UPDATE agent_schedules SET nextRunAt=? WHERE id=?")
    .run(new Date(Date.now() - 1).toISOString(), schedule.id);
  f.service.scheduler.tick();
  expect(() => f.action("resume")).toThrow("current work");
  await f.service.settled();
  expect(f.service.goals.get(f.agent.id)).toMatchObject({
    id: goal.id,
    state: "paused",
  });
  f.action("resume");
  await f.service.settled();
  expect(f.store.runs(f.agent.id)).toHaveLength(2);
});

test("native queued follow-up drains before goal settlement without a duplicate goal continuation", async () => {
  const f = await fixture((n) => {
    if (n === 1) {
      f.sessions[0]!.agent.followUp({
        role: "user",
        content: "Local native follow-up fixture",
        timestamp: Date.now(),
      });
      return {};
    }
    return n === 2 ? complete() : {};
  });
  f.create();
  f.action("resume");
  await f.service.settled();
  expect(f.turns()).toBe(3);
  expect(f.service.goals.get(f.agent.id)).toMatchObject({
    state: "completed",
    continuations: 0,
  });
});

test.each(["pause", "clear", "steer"] as const)(
  "%s refreshes goal authority on admitted ordinary tool follow-ups without aborting them",
  async (action) => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const contexts: Context[] = [];
    const f = await fixture(async (n, context) => {
      contexts.push(structuredClone(context));
      if (n === 1) {
        await held;
        return {
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "ordinary",
              name: "instance_info",
              arguments: {},
            },
          ],
        };
      }
      return {};
    });
    f.create();
    f.action("resume");
    await until(() => f.turns() === 1);
    if (action === "steer")
      f.service.start(
        f.agent.id,
        "human",
        "Human direction takes priority",
        "steer",
      );
    else f.action(action);
    release();
    await f.service.settled();
    expect(f.turns()).toBe(2);
    const before = getCurrentSystemMessage(contexts[0]!.messages)!;
    const after = getCurrentSystemMessage(contexts[1]!.messages)!;
    expect(before.sections?.jelly_goal).toContain("Continue useful work");
    expect(after.sections?.jelly_goal).toContain("no longer active");
    expect(after.sections?.jelly_goal).not.toContain("Continue useful work");
    expect(contexts[1]!.messages[0]).toEqual(contexts[0]!.messages[0]);
    expect(getCurrentTools(contexts[1]!.messages)).toEqual(
      getCurrentTools(contexts[0]!.messages),
    );
    expect(
      contexts[1]!.messages.some(
        (m) => m.role === "toolResult" && m.toolName === "instance_info",
      ),
    ).toBe(true);
    expect(f.store.runs(f.agent.id)).toHaveLength(1);
  },
);

test("100 real consecutive compactions stop parent and queued/native work, persist checkpoint, and explicit resume resets", async () => {
  let normal = 0,
    summaries = 0,
    stopCalls = 0;
  const contexts: string[] = [];
  const f = await fixture(
    (_n, context) => {
      const text = JSON.stringify(context);
      contexts.push(text);
      if (
        JSON.stringify(context.messages[0]).includes(
          "context summarization assistant",
        )
      ) {
        summaries++;
        return {
          content: [
            { type: "text", text: "Identical compacted fixture summary" },
          ],
        };
      }
      normal++;
      if (f.sessions.length > 1) return normal === 101 ? complete() : {};
      expect(f.service.goals.get(f.agent.id)!.state).toBe("active");
      expect(f.service.goals.get(f.agent.id)!.compactions).toBe(normal - 1);
      if (normal === 100) {
        // Native notifications share this queue; none may force a post-limit request.
        f.sessions[0]!.agent.followUp({
          role: "user",
          content: "Queued child wake",
          timestamp: 0,
        });
      }
      return {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: `ping-${normal}`,
            name: "instance_info",
            arguments: {},
          },
        ],
        usage: {
          input: 2000000,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2000001,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    },
    (session) =>
      session.settingsManager.applyOverrides({
        compaction: { enabled: true, keepRecentTokens: 0, reserveTokens: 1 },
      }),
  );
  const compactionOutcomes: Record<string, unknown>[] = [];
  const unsubscribe = f.service.subscribe((event) => {
    if (event.type === "compaction_completed")
      compactionOutcomes.push(event.data);
  });
  const stop = f.service.harness.stop.bind(f.service.harness);
  f.service.harness.stop = async (session) => {
    stopCalls++;
    return stop(session);
  };
  f.create();
  f.action("resume");
  await f.service.settled();
  const stopped = f.service.goals.get(f.agent.id)!;
  expect(stopped).toMatchObject({ state: "paused", compactions: 100 });
  expect(stopped.reason).toContain("100 successful");
  expect(normal).toBe(100);
  expect(summaries).toBe(100);
  unsubscribe();
  expect(compactionOutcomes).toHaveLength(100);
  for (const outcome of compactionOutcomes)
    expect(outcome).toMatchObject({ success: true, aborted: false });
  expect(stopCalls).toBe(1);
  expect(f.store.runs(f.agent.id)[0]!.status).toBe("cancelled");
  expect(
    f.store.db.query("SELECT count(*) n FROM goal_compactions").get(),
  ).toEqual({ n: 100 });
  expect(
    f.store.context(f.agent.id)!.some((entry) => entry.type === "compaction"),
  ).toBe(true);
  const reopened = new Store(join(f.dir, "jelly.sqlite"));
  expect(new Goals(reopened).get(f.agent.id)).toMatchObject({
    state: "paused",
    compactions: 100,
  });
  reopened.close();
  for (const context of contexts) {
    expect(context).not.toMatch(
      /tokenBudget|tokensUsed|compactions|100 successful|continuation token budget/,
    );
  }
  f.action("resume");
  await f.service.settled();
  expect(f.service.goals.get(f.agent.id)).toMatchObject({
    state: "completed",
    compactions: 0,
  });
  expect(f.store.runs(f.agent.id)).toHaveLength(2);
});

test("compaction checkpoint failure rolls back counting and stops before another provider request", async () => {
  let normal = 0,
    failed = false;
  const f = await fixture(
    (_n, context) => {
      if (
        JSON.stringify(context.messages[0]).includes(
          "context summarization assistant",
        )
      )
        return {};
      normal++;
      return {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            name: "instance_info",
            id: "ping",
            arguments: {},
          },
        ],
        usage: {
          input: 2000000,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2000001,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    },
    (session) =>
      session.settingsManager.applyOverrides({
        compaction: { enabled: true, keepRecentTokens: 0, reserveTokens: 1 },
      }),
  );
  const compacted = f.service.goals.compacted.bind(f.service.goals);
  f.service.goals.compacted = (binding, entryId) => {
    compacted(binding, entryId);
    failed = true;
    throw new Error(
      "Injected transaction failure after checkpoint and ledger writes",
    );
  };
  f.create();
  f.action("resume");
  await f.service.settled();
  expect(failed).toBe(true);
  expect(normal).toBe(1);
  expect(f.service.goals.get(f.agent.id)).toMatchObject({
    state: "blocked",
    compactions: 0,
  });
  expect(f.service.goals.get(f.agent.id)!.reason).toContain(
    "Could not persist goal compaction",
  );
  expect(f.store.db.query("SELECT * FROM goal_compactions").all()).toHaveLength(
    0,
  );
  expect(
    f.store.context(f.agent.id)!.some((entry) => entry.type === "compaction"),
  ).toBe(false);
});

function seedCheckpoint(
  f: Awaited<ReturnType<typeof fixture>>,
  summary?: string,
  input = 10,
) {
  const manager = SessionManager.inMemory(f.dir);
  manager.appendMessage({
    role: "user",
    content: "Earlier evidence",
    timestamp: 0,
  });
  if (summary) manager.appendCompaction(summary, null, 3000);
  manager.appendMessage({
    role: "user",
    content: "Human project budget: 123 dollars",
    timestamp: 0,
  });
  const assistant: AssistantMessage = {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-6-astra",
    content: [{ type: "text", text: "Retained verified work" }],
    timestamp: 0,
    stopReason: "stop",
    usage: {
      input,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  manager.appendMessage(assistant);
  if (summary) {
    manager.appendMessage({
      role: "user",
      content: "Further evidence to retain",
      timestamp: 0,
    });
    manager.appendMessage(assistant);
  }
  const run = f.store.createRun(
    f.agent.id,
    "checkpoint-seed",
    "Earlier evidence",
    "api",
    "gpt-6-astra",
  );
  f.store.saveContext(f.agent.id, run.id, [
    manager.getHeader()!,
    ...manager.getBranch(),
  ]);
  f.store.finishRun(run.id, "completed", null);
}

test.each(["goal", "ordinary", "fresh"] as const)(
  "restored legacy summaries are request-only sanitized for %s and subsequent summarization",
  async (mode) => {
    const requests: string[] = [];
    const summary =
      "Verified artifact A. Parent-session continuation token budget: 876543/999999; preserve adjacent evidence B.\nThe parent-session continuation token budget is exhausted (876543/999999). Verified artifact C.";
    const f = await fixture(
      (_n, context) => {
        requests.push(JSON.stringify(context));
        if (
          mode === "goal" &&
          !JSON.stringify(context.messages[0]).includes(
            "context summarization assistant",
          )
        )
          f.service.goals.stop(f.agent.id, "Fixture pause");
        return {};
      },
      (session) => {
        session.settingsManager.applyOverrides({
          compaction: { enabled: false, keepRecentTokens: 0 },
        });
        const prompt = session.prompt.bind(session);
        session.prompt = async (...args) => {
          await prompt(...args);
          await session.compact();
        };
      },
    );
    seedCheckpoint(f, summary);
    if (mode === "goal") {
      f.create();
      f.action("resume");
    } else if (mode === "fresh")
      f.service.freshSession(f.agent.id, "fresh-summary");
    else
      f.service.start(
        f.agent.id,
        "ordinary-summary",
        "Continue from the evidence",
      );
    await f.service.settled();
    expect(f.store.runs(f.agent.id).at(-1)!.status).toBe("completed");
    expect(requests.length).toBeGreaterThanOrEqual(mode === "fresh" ? 1 : 2);
    for (const request of requests)
      expect(request).not.toMatch(
        /876543|999999|parent-session continuation token budget/i,
      );
    const summaries = requests.filter((request) =>
      request.includes("context summarization assistant"),
    );
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.join("\n")).toContain("<previous-summary>");
    for (const evidence of [
      "Verified artifact A",
      "preserve adjacent evidence B",
      "Verified artifact C",
      "Human project budget: 123 dollars",
    ])
      expect(summaries.join("\n")).toContain(evidence);
    expect(
      f.sessions[0]!.sessionManager.getEntries().some(
        (entry) => entry.type === "compaction" && entry.summary === summary,
      ),
    ).toBe(true);
  },
);

test.each(["goal", "ordinary"] as const)(
  "24-hour deadline during held pre-prompt summarization fences %s provider work after Pi resets abort",
  async (mode) => {
    let normal = 0,
      summaries = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(
      async (_n, context) => {
        if (
          JSON.stringify(context.messages[0]).includes(
            "context summarization assistant",
          )
        ) {
          summaries++;
          await held;
        } else normal++;
        return {};
      },
      (session) =>
        session.settingsManager.applyOverrides({
          compaction: { enabled: true, keepRecentTokens: 0, reserveTokens: 1 },
        }),
    );
    seedCheckpoint(f, undefined, 2000000);
    let expire!: () => void;
    const realTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delay: number,
    ) => {
      if (delay === 24 * 60 * 60 * 1000) expire = callback;
      return realTimeout(callback, delay);
    }) as typeof setTimeout);
    try {
      if (mode === "goal") {
        f.create();
        f.action("resume");
      } else
        f.service.start(
          f.agent.id,
          "deadline-preflight",
          "Continue prior work",
        );
      await until(() => summaries === 1);
      expect(normal).toBe(0);
      expect(expire).toBeDefined();
      expire();
      release();
      await f.service.settled();
      expect(normal).toBe(0);
      expect(f.store.runs(f.agent.id).at(-1)).toMatchObject({
        status: "failed",
        error:
          "The run reached the 24-hour limit. Send a new message to continue.",
      });
      const outcomes = f.store
        .historyPage(f.agent.id)
        .events.filter((event) => event.type === "compaction_completed");
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]!.data).toMatchObject({
        success: false,
        aborted: true,
      });
      if (mode === "goal")
        expect(f.service.goals.get(f.agent.id)).toMatchObject({
          state: "blocked",
          compactions: 0,
        });
    } finally {
      release();
      timer.mockRestore();
    }
  },
);
