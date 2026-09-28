import type { AgentRecord, Snapshot } from "../shared/types";
type Profile = Pick<AgentRecord, "name" | "instructions" | "color"> & {
  projectId?: string | null;
};
interface Context {
  registerTool(
    tool: {
      name: string;
      description: string;
      inputSchema: object;
      annotations?: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute(input: unknown): Promise<unknown>;
    },
    options: { signal: AbortSignal },
  ): void | Promise<void>;
}
export function registerWorkspaceTools(actions: {
  read: () => Promise<Snapshot>;
  create: (input: Profile) => Promise<AgentRecord>;
}) {
  const context = (document as Document & { modelContext?: Context })
    .modelContext;
  if (!context) return () => {};
  const lifecycle = new AbortController();
  const register = (tool: Parameters<Context["registerTool"]>[0]) => {
    try {
      void Promise.resolve(
        context.registerTool(tool, { signal: lifecycle.signal }),
      ).catch(() => {});
    } catch {
      /* Optional browser capability. */
    }
  };
  register({
    name: "read_jelly_workspace",
    description:
      "Read projects, agents, connection mode, and activity in the current Jelly instance.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: () => actions.read(),
  });
  register({
    name: "create_jelly_agent",
    description:
      "Create a persistent Jelly agent with a name and instructions, then select it in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 60 },
        instructions: { type: "string", maxLength: 12000 },
        projectId: { type: ["string", "null"] },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Expected an agent profile.");
      const p = input as Record<string, unknown>;
      if (
        Object.keys(p).some(
          (k) => !["name", "instructions", "projectId"].includes(k),
        ) ||
        (p.projectId !== undefined &&
          p.projectId !== null &&
          (typeof p.projectId !== "string" || !p.projectId)) ||
        typeof p.name !== "string" ||
        !p.name.trim() ||
        p.name.length > 60 ||
        (p.instructions !== undefined &&
          (typeof p.instructions !== "string" || p.instructions.length > 12000))
      )
        throw new Error(
          "Provide a valid name and optional instructions.",
        );
      const agent = await actions.create({
        name: p.name,
        instructions: (p.instructions as string) ?? "",
        color: "#b5bafc",
        projectId: p.projectId as string | null | undefined,
      });
      return { id: agent.id, name: agent.name };
    },
  });
  return () => lifecycle.abort();
}
