import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildInProcessChildLaunch } from "../node_modules/pi-subagents/src/runs/shared/child-launch.js";
import { prepareWorkflowLaunchParams } from "../node_modules/pi-subagents/src/runs/foreground/subagent-executor.js";
import { createSubagentParamsSchema } from "../node_modules/pi-subagents/src/extension/schemas.js";

const base = {
  sessionEnabled: false,
  inheritProjectContext: false,
  inheritGlobalContext: false,
  inheritSkills: false,
  cwd: process.cwd(),
  childAgentName: "delegate",
  childIndex: 0,
  tools: [],
  waitToolEnabled: false,
};

test("native child speed hooks cover both providers, hosts and supported Jelly models", async () => {
  for (const host of ["parent", "runner"] as const) {
    for (const provider of ["openai", "openai-codex"]) {
      for (const id of ["gpt-6-astra", "gpt-6.1-sol"]) {
        for (const fast of [undefined, false, true, "ultrafast"] as const) {
          const launch = buildInProcessChildLaunch({ ...base, host, fast, model: `${provider}/${id}:high` });
          expect(launch.config.fast).toBe(fast ?? false);
          const hook = launch.session.hooks.find(h => h.name === "pi-subagents:fast-mode");
          expect(Boolean(hook)).toBe(Boolean(fast));
          if (!hook) continue;
          let transform!: (event: { payload: unknown }) => unknown;
          await hook.factory({
            on: (event: string, handler: typeof transform) => {
              expect(event).toBe("before_provider_request");
              transform = handler;
            },
          } as unknown as ExtensionAPI);
          const payload = { model: id, input: ["preserved"], service_tier: "auto" };
          // The same hook applies to continuations and compaction requests.
          for (let request = 0; request < 3; request++) {
            expect(transform({ payload })).toEqual({
              ...payload, service_tier: fast === "ultrafast" ? "ultrafast" : "priority",
            });
          }
          expect(payload.service_tier).toBe("auto");
        }
      }
    }
  }
});

test("unsupported or invalid speed selections fail rather than silently downgrade", () => {
  for (const model of ["openai/gpt-6-sol:high", "claude-code/claude-opus-5-5:high"]) {
    expect(() => buildInProcessChildLaunch({ ...base, host: "parent", model, fast: "ultrafast" }))
      .toThrow("Unsupported model");
    expect(() => buildInProcessChildLaunch({ ...base, host: "parent", model, fast: false }))
      .not.toThrow();
  }
  expect(() => buildInProcessChildLaunch({
    ...base, host: "parent", model: "openai/gpt-6-astra", fast: "invalid" as any,
  })).toThrow("fast must be");
});

test("workflow speed defaults yield to children and never override retained resume", () => {
  const defaults = { fast: "ultrafast" as const };
  expect(prepareWorkflowLaunchParams(defaults, { agent: "delegate", task: "test" }, "run", "a").fast)
    .toBe("ultrafast");
  for (const fast of [false, true, "ultrafast"] as const) {
    expect(prepareWorkflowLaunchParams(defaults, { agent: "delegate", task: "test", fast }, "run", "a").fast)
      .toBe(fast);
  }
  expect(prepareWorkflowLaunchParams(defaults, { resume: "prior-run", task: "continue" }, "run", "a").fast)
    .toBeUndefined();
  const schema = createSubagentParamsSchema();
  expect(JSON.stringify(schema.properties.fast)).toContain("ultrafast");
});

test("callers cannot set subagent run limits; every run uses the uniform 6-hour limit", async () => {
  const executor = await import("../node_modules/pi-subagents/src/runs/foreground/subagent-executor.js");
  const asyncExecution = await import("../node_modules/pi-subagents/src/runs/background/async-execution.js");
  const sixHours = 6 * 60 * 60 * 1000;
  expect(executor.DEFAULT_FOREGROUND_TIMEOUT_MS).toBe(sixHours);
  expect(asyncExecution.DEFAULT_ASYNC_TIMEOUT_MS).toBe(sixHours);
  const properties = (createSubagentParamsSchema() as any).properties;
  expect(properties.timeoutMs).toBeUndefined();
  expect(properties.maxRuntimeMs).toBeUndefined();
  // Workflow children inherit no parent deadline: the workflow itself has none.
  const child = prepareWorkflowLaunchParams({}, { agent: "worker", task: "x" }, "wf", "step", {});
  expect(child.workflowParentDeadlineAt).toBeUndefined();
  // The single-agent resolver applies the uniform limit when no caller value survives.
  expect(executor.resolveSingleAgentLaunchTimeout({ agent: "worker" }, true, sixHours)).toEqual({ timeoutMs: sixHours });
  const source = await Bun.file("node_modules/pi-subagents/src/runs/foreground/subagent-executor.js").text();
  expect(source).toContain("let requestParams = withoutCallerRunDeadline(normalizedGate.params);");
  expect(source).toContain("const timeout = undefined; // Jelly");
});
