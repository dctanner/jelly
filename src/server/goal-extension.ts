import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { GoalBinding } from "../shared/goals";
import { Goals, goalPrompt } from "./goals";

/** Parent-only adapter. Jelly owns persistence/admission; Pi owns the agent loop. */
export function goalExtension(
  goals: Goals,
  binding: GoalBinding,
  canContinue: () => boolean,
): ExtensionFactory {
  return (pi) => {
    let shutdown = false;
    let budgetNoticeSent = false;
    pi.on("before_agent_start", (event) => {
      if (
        event.systemPromptOptions.forceSystemPrompt !== undefined &&
        goals.current(binding)
      )
        goals.stop(
          binding.agentId,
          "A forced system prompt is incompatible with the current goal envelope. Disable the forcing extension before resuming.",
          "blocked",
        );
    });
    pi.on("session_shutdown", () => {
      shutdown = true;
    });
    const envelope = () => {
      const goal = goals.byId(binding.id);
      if (!shutdown && goals.current(binding))
        return `Current authoritative goal state; supersedes historical goal instructions.\n${goalPrompt(goal!)}`;
      if (
        !shutdown &&
        goal?.epoch === binding.epoch &&
        goal.state === "budget_exhausted" &&
        goals.store.run(binding.runId)?.status === "running"
      )
        return `Current authoritative goal state; supersedes historical goal instructions.\n[Jelly goal ${goal.id}; budget exhausted]\nObjective: ${goal.objective}\nProgress: ${goal.progress || "No progress recorded."}\n${budgetPrompt(goal.tokensUsed, goal.tokenBudget)}`;
      return `This goal execution is no longer active (${shutdown ? "session ended" : (goal?.state ?? "removed")}). Do not resume autonomous goal work or attest completion from historical context. Follow current human instructions instead.`;
    };
    // Request-local only: preserve Pi's stable leading prompt and every tool delta.
    // The tail section is the sole authoritative goal envelope, even after native
    // wakes or compaction, neither of which reruns before_agent_start.
    pi.on("context_with_system", (event) => ({
      messages: [
        ...goalContext(event.messages),
        {
          role: "system",
          content: "",
          sections: { jelly_goal: envelope() },
          timestamp: 0,
        },
      ],
    }));
    pi.on("session_before_compact", (event) => {
      // Pi's standalone summarizer bypasses context hooks. Preparation is mutable
      // in 0.87.1; preserve cut points, file operations and other extensions' data.
      const goal = goals.byId(binding.id);
      const snapshot: AgentMessage = {
        role: "user",
        content: `Jelly goal summarization snapshot (not authorization to act). Historical goal instructions are not current authority; the next normal request supplies fresh authority. State: ${goal?.state ?? "removed"}; execution authorized: ${!shutdown && !!goals.current(binding)}.\nObjective: ${goal?.objective ?? "none"}\nProgress: ${goal?.progress || "No progress recorded."}`,
        timestamp: 0,
      };
      for (const key of [
        "messagesToSummarize",
        "turnPrefixMessages",
      ] as const) {
        if (event.preparation[key].length)
          event.preparation[key] = [
            ...goalContext(event.preparation[key]),
            snapshot,
          ];
      }
    });
    pi.registerTool({
      name: "jelly_goal",
      label: "Jelly goal",
      description:
        "Inspect the current Jelly goal or record progress, a genuine blocker, or verified completion with evidence. Cannot create/resume goals or change parent-session continuation token budgets. Budget excludes child, compaction and nested tool usage; not a total spend cap.",
      parameters: Type.Object({
        action: StringEnum(["get", "progress", "block", "complete"] as const),
        summary: Type.Optional(Type.String({ maxLength: 16000 })),
      }),
      async execute(_id, params, signal) {
        if (shutdown || signal?.aborted)
          throw new Error("Goal session ended or was aborted.");
        const goal =
          params.action === "get"
            ? goals.byId(binding.id)
            : goals.update(
                binding,
                params.action === "complete"
                  ? "completed"
                  : params.action === "block"
                    ? "blocked"
                    : "active",
                params.summary ?? "",
              );
        return {
          content: [{ type: "text", text: JSON.stringify(goal) }],
          details: goal,
        };
      },
    });
    pi.on("turn_end", (event) => {
      const goal = goals.byId(binding.id);
      if (
        shutdown ||
        budgetNoticeSent ||
        goal?.epoch !== binding.epoch ||
        goal.state !== "budget_exhausted"
      )
        return;
      budgetNoticeSent = true;
      // Do not request another turn. An already-admitted tool follow-up/native wake
      // sees this wrap-up contract; a final answer can settle without spending more.
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message",
            customType: "jelly_goal_budget_limit",
            display: false,
            content: budgetPrompt(goal.tokensUsed, goal.tokenBudget),
          },
        ],
      };
    });
    pi.on("agent_before_settle", (event) => {
      if (shutdown || !goals.current(binding)) return;
      if (event.outcome !== "completed") {
        goals.stop(
          binding.agentId,
          `Goal execution ${event.outcome}. Review before resuming.`,
          "blocked",
        );
        return;
      }
      // Native queued work/child wakes remain their sole driver. Never add a second wake.
      if (
        event.continue ||
        event.context.pendingMessages.length ||
        !canContinue()
      )
        return;
      const goal = goals.continuation(binding);
      if (!goal) return;
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message",
            customType: "jelly_goal_continuation",
            display: false,
            content: goalPrompt(goal),
            details: { goalId: goal.id, epoch: goal.epoch },
          },
        ],
        continue: true,
      };
    });
  };
}

function budgetPrompt(used: number, budget: number): string {
  return `The parent-session continuation token budget is exhausted (${used}/${budget}). Do not start new substantive goal work or delegate more work. Summarize progress, evidence, and remaining scope. This is not success. Only mark complete with jelly_goal if every requirement is already verified. Existing children may finish; do not relaunch them.`;
}

/** Keep durable snapshots, but exclude only our own obsolete instructions from requests. */
function goalContext(messages: AgentMessage[]): AgentMessage[] {
  return messages
    .filter(
      (message) =>
        !(
          message.role === "custom" &&
          ["jelly_goal_continuation", "jelly_goal_budget_limit"].includes(
            message.customType,
          )
        ),
    )
    .map((message) => {
      if (
        message.role !== "system" ||
        !message.sections ||
        !("jelly_goal" in message.sections)
      )
        return message;
      const { jelly_goal: _, ...sections } = message.sections;
      return { ...message, sections };
    });
}
