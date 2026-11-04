import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Goal, GoalBinding } from "../shared/goals";
import { Goals, goalPrompt } from "./goals";

const GOAL_TOOL_DESCRIPTION =
  "Inspect the current Jelly goal or record progress, a genuine blocker, or verified completion with evidence. Cannot create or resume goals or change their objective.";

/** Parent-only adapter. Jelly owns persistence/admission; Pi owns the agent loop. */
export function goalExtension(
  goals: Goals,
  binding: GoalBinding,
  canContinue: () => boolean,
  commitCompaction: (entryId: string) => boolean,
): ExtensionFactory {
  return (pi) => {
    let shutdown = false;
    let compactionBefore: Set<string> | undefined;
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
      return `This goal execution is no longer active (${shutdown ? "session ended" : (goal?.state ?? "removed")}). Do not resume autonomous goal work or attest completion from historical context. Follow current human instructions instead.`;
    };
    // Request-local only: preserve Pi's stable leading prompt and every tool delta.
    // The tail section is the sole authoritative goal envelope, even after native
    // wakes or compaction, neither of which reruns before_agent_start.
    pi.on("context_with_system", (event) => ({
      messages: [
        ...goalContext(event.messages, goals, binding.agentId),
        {
          role: "system",
          content: "",
          sections: { jelly_goal: envelope() },
          timestamp: 0,
        },
      ],
    }));
    pi.on("session_before_compact", (event, ctx) => {
      compactionBefore = new Set(
        ctx.sessionManager.getBranch().map((entry) => entry.id),
      );
      // Pi's standalone summarizer bypasses context hooks. Preparation is mutable
      // in 0.87.1; preserve cut points, file operations and other extensions' data.
      if (event.preparation.previousSummary)
        event.preparation.previousSummary = goalSummaryContext(
          event.preparation.previousSummary,
        );
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
            ...goalContext(event.preparation[key], goals, binding.agentId),
            snapshot,
          ];
      }
    });
    pi.on("session_compact_failed", () => {
      compactionBefore = undefined;
    });
    pi.on("session_compact", (_event, ctx) => {
      // Pi 0.87.1 reports the first entry with an equal summary, which can be old.
      // Resolve the newly appended active-branch identity instead. A replayed
      // success callback without a new preparation must not count again.
      const before = compactionBefore;
      compactionBefore = undefined;
      if (shutdown || !before) return;
      const entry = ctx.sessionManager
        .getBranch()
        .findLast(
          (entry) => entry.type === "compaction" && !before.has(entry.id),
        );
      if (!entry) return;
      try {
        if (commitCompaction(entry.id)) ctx.abort();
      } catch (error) {
        // Extension errors alone are swallowed by Pi: fail closed on a failed
        // durable checkpoint. The host also initiates owned-work cleanup.
        ctx.abort();
        throw error;
      }
    });
    pi.registerTool({
      name: "jelly_goal",
      label: "Jelly goal",
      description: GOAL_TOOL_DESCRIPTION,
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
          content: [{ type: "text", text: JSON.stringify(modelGoal(goal)) }],
          details: modelGoal(goal),
        };
      },
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

/** Explicit model projection: never include server policy, counters or operator reasons. */
function modelGoal(
  goal: Pick<Goal, "id" | "objective" | "progress" | "state"> | null,
) {
  if (!goal) return null;
  return {
    id: goal.id,
    objective: goal.objective,
    progress: goal.progress,
    state: ["active", "completed", "cleared", "blocked"].includes(goal.state)
      ? goal.state
      : "paused",
    ...(goal.state !== "active"
      ? {
          instruction: "This goal is stopped. Only the operator can resume it.",
        }
      : {}),
  };
}

/** Keep durable history; exclude only Jelly-owned obsolete policy from requests. */
export function goalContext(
  messages: AgentMessage[],
  goals: Goals,
  agentId: string,
): AgentMessage[] {
  // Match persisted server-owned admissions, not arbitrary human text patterns.
  const prompts = new Set(
    (
      goals.store.db
        .query(
          "SELECT r.prompt FROM runs r JOIN goal_runs g ON g.runId=r.id WHERE r.agentId=?",
        )
        .all(agentId) as { prompt: string }[]
    ).map((row) => row.prompt),
  );
  return messages
    .filter(
      (message) =>
        !(
          message.role === "user" &&
          prompts.has(
            typeof message.content === "string"
              ? message.content
              : message.content.length === 1 &&
                  message.content[0]?.type === "text"
                ? message.content[0].text
                : "",
          )
        ) &&
        !(
          message.role === "custom" &&
          ["jelly_goal_continuation", "jelly_goal_budget_limit"].includes(
            message.customType,
          )
        ),
    )
    .map((message) => {
      if (
        message.role === "compactionSummary" ||
        message.role === "branchSummary"
      )
        return { ...message, summary: goalSummaryContext(message.summary) };
      if (message.role === "toolResult" && message.toolName === "jelly_goal") {
        // Old tool results serialized the entire internal record. Retain only
        // goal evidence in the request view; raw history remains untouched.
        const details = message.details as Goal | undefined;
        if (details && typeof details.objective === "string") {
          const safe = modelGoal(details);
          return {
            ...message,
            content: [{ type: "text" as const, text: JSON.stringify(safe) }],
            details: safe,
          };
        }
      }
      if (
        message.role === "system" &&
        message.toolsAdded?.some((tool) => tool.name === "jelly_goal")
      )
        message = {
          ...message,
          toolsAdded: message.toolsAdded.map((tool) =>
            tool.name === "jelly_goal"
              ? { ...tool, description: GOAL_TOOL_DESCRIPTION }
              : tool,
          ),
        };
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

/** Scrub recognizable generated v18 policy spans in summaries, not entire lines
 * or human messages. Summary originals remain durable evidence. */
export function goalSummaryContext(summary: string): string {
  return summary.replace(
    /(?:The )?parent-session continuation token budget(?::\s*[\d,]+\s*\/\s*[\d,]+| is exhausted\s*\([\d,]+\s*\/\s*[\d,]+\))/gi,
    "Historical goal policy omitted; follow current execution authority",
  );
}
