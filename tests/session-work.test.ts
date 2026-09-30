import { expect, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionWork } from "../src/server/session-work";

const idleSession = { waitForIdle: async () => {} } as AgentSession;

async function settlesWithin(promise: Promise<void>, milliseconds = 250) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

test("workflow-owned resumed child needs no separate completion notification", async () => {
  const reports: { type: string; data: Record<string, unknown> }[] = [];
  const work = new SessionWork((type, data) => reports.push({ type, data }));
  work.bus.emit("subagent:async-started", { id: "workflow", agent: "workflow" });
  // pi-subagents emits this start, but routes the resumed child's result to
  // workflow-result.json rather than to the parent's completion notifier.
  work.bus.emit("subagent:async-started", {
    id: "resumed-worker", agent: "worker", parentWorkflowRunId: "workflow", workflowKey: "resume-integration",
  });
  work.bus.emit("subagent:async-complete", { id: "workflow", runId: "workflow", state: "complete" });
  const settling = work.settle(idleSession);
  let settled = false;
  try {
    settled = await settlesWithin(settling);
  } finally {
    // Also clean up the old buggy implementation when demonstrating the failure.
    work.bus.emit("subagent:async-complete", { id: "resumed-worker" });
    await settling;
  }
  expect(settled).toBe(true);
  expect(reports.filter(report => report.type === "subagent_started")).toHaveLength(2);
});

test("independent jobs and workflow roots still block settlement until complete", async () => {
  const work = new SessionWork(() => {});
  work.bus.emit("subagent:async-started", { id: "workflow" });
  work.bus.emit("subagent:async-started", { id: "independent" });
  work.bus.emit("subagent:async-started", { id: "child", parentWorkflowRunId: "workflow" });
  work.bus.emit("subagent:async-complete", { id: "child" });
  const settling = work.settle(idleSession);
  try {
    expect(await settlesWithin(settling, 75)).toBe(false);
    work.bus.emit("subagent:async-complete", { id: "workflow", state: "failed" });
    expect(await settlesWithin(settling, 75)).toBe(false);
    work.bus.emit("subagent:async-complete", { runId: "independent" });
    expect(await settlesWithin(settling)).toBe(true);
  } finally {
    for (const id of ["workflow", "independent", "child"])
      work.bus.emit("subagent:async-complete", { id });
    await settling;
  }
});

test("Stop targets owning workflows and independent jobs, not their resumed children", async () => {
  const work = new SessionWork(() => {});
  const stopped: string[] = [];
  work.bus.on("subagents:rpc:v1:request", value => {
    const request = value as { requestId: string; method: string; params: { id: string } };
    expect(request.method).toBe("stop");
    stopped.push(request.params.id);
    work.bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, { success: true });
  });
  work.bus.emit("subagent:async-started", { id: "workflow" });
  work.bus.emit("subagent:async-started", { id: "independent" });
  work.bus.emit("subagent:async-started", { id: "child", parentWorkflowRunId: "workflow" });
  await work.stop();
  await work.settle(idleSession);
  expect(stopped.sort()).toEqual(["independent", "workflow"]);
});

test("settlement still drains Pi follow-ups and work launched while becoming idle", async () => {
  const work = new SessionWork(() => {});
  let idleCalls = 0;
  const session = {
    waitForIdle: async () => {
      if (++idleCalls === 1) work.bus.emit("subagent:async-started", { id: "follow-up" });
    },
  } as AgentSession;
  const settling = work.settle(session);
  try {
    expect(await settlesWithin(settling, 75)).toBe(false);
    work.bus.emit("subagent:async-complete", { id: "follow-up" });
    expect(await settlesWithin(settling)).toBe(true);
    expect(idleCalls).toBe(2);
  } finally {
    work.bus.emit("subagent:async-complete", { id: "follow-up" });
    await settling;
  }
});
