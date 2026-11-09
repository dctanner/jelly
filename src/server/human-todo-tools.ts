import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HumanTodos } from "./human-todos";

export const HUMAN_TODO_INSTRUCTIONS =
  "Human todos are durable actions for the human, not your implementation checklist. Record concrete dependencies of authorized work, not every question/tool failure. Check human_todo_list first; reuse existing blockers and stable requestId/dedupeKey. Give a short actionable title and a body explaining what to do, why, and what counts as done. Set blocking:true only when it blocks your active goal. Never put passwords, tokens or recovery codes in persisted text; use private handoff tools. Only claim saved after the durable receipt succeeds. Finish this run when no useful work remains; never sleep/poll/hold a tool open for a todo. Re-read current state before relying on it. Human edits/cancellation are authoritative, not permission to expand the job. Completion is attestation, not verified effects: agent completion needs observed evidence or explicit human instruction in resolutionNote. Open-task cancellation/deletion needs a reason. These tools cannot wake agents or resume goals. Ordinary child agents report blockers to their persistent parent; they have no independent todo owner.";
const define = <T extends TSchema>(tool: ToolDefinition<T>): ToolDefinition =>
  tool as ToolDefinition;
const id = Type.String({ minLength: 1, maxLength: 100 });
const fields = {
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  body: Type.Optional(Type.String({ maxLength: 8000 })),
  blocking: Type.Optional(
    Type.Boolean({
      description:
        "Set true only if this blocks your active goal; it pauses the goal. Not shown to the human.",
    }),
  ),
};
export function humanTodoTools(
  todos: HumanTodos,
  agentId: string,
  runId: string,
  active: () => boolean,
): ToolDefinition[] {
  const actor = { kind: "agent" as const, agentId, runId };
  const check = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!active()) throw new Error("Owning parent run is no longer active.");
  };
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  });
  return [
    define({
      name: "human_todo_list",
      label: "Read human todos",
      description:
        "List this parent's paginated todo summaries and current revisions. Supply todoId for the full body, provenance and bounded history before editing or relying on a task. " +
        HUMAN_TODO_INSTRUCTIONS,
      parameters: Type.Object(
        {
          todoId: Type.Optional(id),
          after: Type.Optional(Type.String({ maxLength: 1000 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          status: Type.Optional(
            Type.Union([Type.Literal("open"), Type.Literal("history")]),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, input, signal) => {
        check(signal);
        const { todoId, ...query } = input;
        if (todoId) return result(todos.detail(todoId, actor));
        const page = todos.list(query, actor);
        return result({
          items: page.items,
          after: page.after,
          outstandingCount: page.counts.total,
        });
      },
    }),
    define({
      name: "human_todo_create",
      label: "Request human action",
      description: HUMAN_TODO_INSTRUCTIONS,
      parameters: Type.Object(
        {
          ...fields,
          title: Type.String({ minLength: 1, maxLength: 160 }),
          requestId: id,
          dedupeKey: Type.Optional(id),
          interventionId: Type.Optional(id),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, input, signal) => {
        check(signal);
        return result(todos.mutate("create", null, input, actor));
      },
    }),
    define({
      name: "human_todo_update",
      label: "Update human todo",
      description: HUMAN_TODO_INSTRUCTIONS,
      parameters: Type.Object(
        {
          ...fields,
          interventionId: Type.Optional(Type.Union([id, Type.Null()])),
          todoId: id,
          expectedRevision: Type.Integer({ minimum: 1 }),
          requestId: id,
          status: Type.Optional(
            Type.Union([
              Type.Literal("open"),
              Type.Literal("done"),
              Type.Literal("cancelled"),
            ]),
          ),
          resolutionNote: Type.Optional(Type.String({ maxLength: 4000 })),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, input, signal) => {
        check(signal);
        const { todoId, ...mutation } = input;
        return result(todos.mutate("update", todoId, mutation, actor));
      },
    }),
    define({
      name: "human_todo_delete",
      label: "Delete human todo",
      description: HUMAN_TODO_INSTRUCTIONS,
      parameters: Type.Object(
        {
          todoId: id,
          expectedRevision: Type.Integer({ minimum: 1 }),
          requestId: id,
          reason: Type.String({ minLength: 1, maxLength: 4000 }),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, input, signal) => {
        check(signal);
        const { todoId, reason, ...mutation } = input;
        return result(
          todos.mutate(
            "delete",
            todoId,
            { ...mutation, resolutionNote: reason },
            actor,
          ),
        );
      },
    }),
  ];
}
