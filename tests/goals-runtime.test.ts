import { afterEach, expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  getCurrentSystemMessage,
  getCurrentTools,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
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
    return session;
  };
  const create = (tokenBudget = 100000) =>
    app.service.changeGoal(agent.id, "create", {
      requestId: "create",
      objective: "Verify the local fixture only",
      tokenBudget,
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

test("real installed Pi boundary creates exactly one legal continuation then explicit tool completion, parent-only metering", async () => {
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
  expect(current.tokensUsed).toBe(54);
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
test("budget exhaustion stops continuation and keeps in-flight overshoot, never completion", async () => {
  const f = await fixture();
  f.create(10);
  f.action("resume");
  await f.service.settled();
  expect(f.turns()).toBe(1);
  expect(f.service.goals.get(f.agent.id)).toMatchObject({
    state: "budget_exhausted",
    tokensUsed: 18,
  });
  expect(() => f.action("resume")).toThrow("Budget exhausted");
});
test("32 automatic continuation breaker is durable and not success", async () => {
  const f = await fixture();
  f.create();
  f.action("resume");
  await f.service.settled();
  expect(f.turns()).toBe(33);
  expect(f.service.goals.get(f.agent.id)).toMatchObject({
    state: "blocked",
    continuations: 32,
    tokensUsed: 594,
  });
  expect(f.service.goals.get(f.agent.id)!.reason).toContain("32 automatic");
});
test.each(["pause", "clear", "complete"] as const)(
  "%s during an admitted request fences the old goal and still accounts its usage",
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
    expect(f.service.goals.byId(original.id)!.tokensUsed).toBe(18);
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
test("explicit resume preserves identity and usage across execution epochs", async () => {
  const f = await fixture((n) => (n === 2 ? complete() : {}));
  const goal = f.create(10);
  f.action("resume");
  await f.service.settled();
  f.action("edit", { objective: goal.objective, tokenBudget: 1000 });
  f.action("resume");
  await f.service.settled();
  expect(f.service.goals.get(f.agent.id)).toMatchObject({
    id: goal.id,
    state: "completed",
    tokensUsed: 54,
  });
  expect(f.store.runs(f.agent.id)).toHaveLength(2);
});

test("Fresh Session and archive/restore preserve stopped goal identity and cumulative usage", async () => {
  const f = await fixture();
  const goal = f.create(10);
  f.action("resume");
  await f.service.settled();
  f.service.freshSession(f.agent.id, "fresh");
  await f.service.settled();
  expect(f.service.goals.get(f.agent.id)).toMatchObject({
    id: goal.id,
    state: "budget_exhausted",
    tokensUsed: 18,
  });
  f.service.archiveAgent(f.agent.id, true);
  expect(() =>
    f.action("edit", { objective: goal.objective, tokenBudget: 200 }),
  ).toThrow("Restore");
  f.service.archiveAgent(f.agent.id, false);
  expect(f.service.goals.get(f.agent.id)).toMatchObject({
    id: goal.id,
    state: "budget_exhausted",
    tokensUsed: 18,
  });
});
test("shutdown pauses before cancelling admitted work and preserves late reported usage", async () => {
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
    tokenBudget: 100,
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
    tokensUsed: 36,
  });
  expect(f.service.goals.get(other.id)).toMatchObject({
    state: "completed",
    tokensUsed: 36,
  });
});
test("exhaustion during an admitted tool loop supplies one wrap-up draft without an extra goal turn", async () => {
  const f = await fixture((n, context) => {
    if (n === 1)
      return {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "fixture-read",
            name: "instance_info",
            arguments: {},
          },
        ],
      };
    expect(JSON.stringify(context)).toContain(
      "Do not start new substantive goal work",
    );
    return {};
  });
  f.create(10);
  f.action("resume");
  await f.service.settled();
  expect(f.turns()).toBe(2);
  expect(f.service.goals.get(f.agent.id)).toMatchObject({
    state: "budget_exhausted",
    tokensUsed: 36,
    continuations: 0,
  });
  expect(
    f.store
      .context(f.agent.id)!
      .filter(
        (e) =>
          e.type === "custom_message" &&
          e.customType === "jelly_goal_budget_limit",
      ),
  ).toHaveLength(1);
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
    tokensUsed: 72,
  });
});

test("Stop during a parent request fences late completion tools and accounts the aborted request", async () => {
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
    tokensUsed: 18,
  });
  expect(f.turns()).toBe(1);
});

test("schedule/goal admission shares exclusivity and never displaces admitted work", async () => {
  const f = await fixture();
  const goal = f.create(10);
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
    tokensUsed: 0,
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

test.each(["queue", "steer", "stop", "shutdown"] as const)(
  "%s fences exhausted-goal late completion without resetting budget or usage",
  async (takeover) => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const f = await fixture(async (n, context) => {
      if (n === 1)
        return {
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "inspect",
              name: "jelly_goal",
              arguments: { action: "get" },
            },
          ],
        };
      if (n === 2) {
        expect(
          getCurrentSystemMessage(context.messages)?.sections?.jelly_goal,
        ).toContain("Do not start new substantive goal work");
        await held;
        return complete();
      }
      if (
        getCurrentTools(context.messages).some((t) => t.name === "jelly_goal")
      )
        expect(
          getCurrentSystemMessage(context.messages)?.sections?.jelly_goal,
        ).toContain("no longer active");
      return {};
    });
    f.create(10);
    f.action("resume");
    await until(() => f.turns() === 2);
    const before = f.service.goals.get(f.agent.id)!;
    expect(before.state).toBe("budget_exhausted");
    let stopping: Promise<unknown> | undefined;
    if (takeover === "stop") stopping = f.service.stop(f.agent.id);
    else if (takeover === "shutdown") stopping = f.close();
    else
      f.service.start(
        f.agent.id,
        "human",
        "Pause goal work; change direction",
        takeover,
      );
    const after = f.service.goals.get(f.agent.id)!;
    expect(after).toMatchObject({
      state: "budget_exhausted",
      epoch: before.epoch + 1,
      tokensUsed: 18,
      tokenBudget: 10,
    });
    release();
    if (stopping) await stopping;
    await f.service.settled();
    const reopened =
      takeover === "shutdown" ? new Store(join(f.dir, "jelly.sqlite")) : null;
    const final = (reopened ? new Goals(reopened) : f.service.goals).get(
      f.agent.id,
    )!;
    reopened?.close();
    expect(final.state).toBe("budget_exhausted");
    expect(final.progress).toBe("");
    expect(final.tokensUsed).toBeGreaterThanOrEqual(36);
    expect(final.continuations).toBe(0);
  },
);

test("exhaustion alone still permits the same admitted execution to attest already-verified completion", async () => {
  const f = await fixture((n) => {
    if (n === 1)
      return {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "inspect",
            name: "jelly_goal",
            arguments: { action: "get" },
          },
        ],
      };
    return n === 2 ? complete() : {};
  });
  f.create(10);
  f.action("resume");
  await f.service.settled();
  expect(f.turns()).toBe(3);
  expect(f.service.goals.get(f.agent.id)).toMatchObject({
    state: "completed",
    tokensUsed: 54,
    tokenBudget: 10,
    continuations: 0,
  });
});
