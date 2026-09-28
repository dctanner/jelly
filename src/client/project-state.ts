import type { AgentRecord, ProjectRecord } from "../shared/types";
export type Scope =
  | { kind: "all" }
  | { kind: "ungrouped" }
  | { kind: "project"; projectId: string };
export const scopeKey = (s: Scope) =>
  s.kind === "project" ? s.projectId : s.kind;
export const belongs = (a: AgentRecord, s: Scope) =>
  s.kind === "all" ||
  (s.kind === "ungrouped" ? !a.projectId : a.projectId === s.projectId);
export const scopeName = (s: Scope, projects: ProjectRecord[]) =>
  s.kind === "all"
    ? "All agents"
    : s.kind === "ungrouped"
      ? "Ungrouped"
      : (projects.find((p) => p.id === s.projectId)?.name ?? "Project");
export const scopeQuery = (s: Scope) =>
  `scope=${s.kind}${s.kind === "project" ? `&projectId=${encodeURIComponent(s.projectId)}` : ""}`;
export function validScope(value: unknown, projects: ProjectRecord[]): Scope {
  const s = value as Scope | undefined;
  return s?.kind === "ungrouped"
    ? s
    : s?.kind === "project" && projects.some((p) => p.id === s.projectId)
      ? s
      : { kind: "all" };
}
