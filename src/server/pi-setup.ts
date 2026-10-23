import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
export const ALL_PI_TOOLS = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];
function settingsObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object in Pi subagent settings; refusing to overwrite settings.");
  return value as Record<string, unknown>;
}
export function preparePi(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const settings = join(dataDir, "settings.json");
  if (!existsSync(settings))
    writeFileSync(
      settings,
      JSON.stringify(
        {
          defaultTools: ALL_PI_TOOLS,
          defaultProjectTrust: "always",
          subagents: {
            agentOverrides: Object.fromEntries(
              [
                "advisor",
                "delegate",
                "oracle",
                "researcher",
                "evidence-auditor",
                "reviewer",
                "scout",
                "worker",
              ].map((name) => [
                name,
                { tools: ALL_PI_TOOLS, excludeTools: false, thinking: false },
              ]),
            ),
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  // Persist in Jelly's Pi agent directory so discovery and detached children
  // share this policy, including instances whose settings already exist.
  const current = settingsObject(JSON.parse(readFileSync(settings, "utf8")));
  const subagents = settingsObject(current.subagents ?? {});
  const overrides = settingsObject(subagents.agentOverrides ?? {});
  const claudeExtension = fileURLToPath(new URL("./claude-code-provider.ts", import.meta.url));
  const upstreamClaudeExtension = fileURLToPath(import.meta.resolve("@earendil-works/pi-claude-code/src/index.ts"));
  const extensions = current.extensions ?? [];
  if (!Array.isArray(extensions) || !extensions.every(value => typeof value === "string"))
    throw new Error("Expected extension paths in Pi settings; refusing to overwrite settings.");
  // Replace only our previous exact upstream path; preserve other resources.
  const guardedExtensions = extensions.filter(path => path !== upstreamClaudeExtension);
  if (!guardedExtensions.includes(claudeExtension)) guardedExtensions.push(claudeExtension);
  let changed = JSON.stringify(extensions) !== JSON.stringify(guardedExtensions);
  if (changed) current.extensions = guardedExtensions;
  for (const name of ["claude-code", "claude-code-writer"]) {
    const override = settingsObject(overrides[name] ?? {});
    if (override.disabled === true) continue;
    overrides[name] = { ...override, disabled: true };
    changed = true;
  }
  if (changed)
    writeFileSync(
      settings,
      JSON.stringify({ ...current, subagents: { ...subagents, agentOverrides: overrides } }, null, 2),
      { mode: 0o600 },
    );
  const path = join(dataDir, "extensions", "subagent", "config.json");
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      JSON.stringify(
        {
          asyncByDefault: true,
          artifactDir: "project",
          defaultSessionDir: join(dataDir, "subagent-sessions"),
          fleetView: false,
          asyncWidget: false,
          permissions: { rules: {} },
          authorityPolicy: {
            discardWorktree: "auto",
            destructiveCleanup: "auto",
            spawnBudgetGrant: "auto",
            scheduleCreate: "auto",
            stopRun: "auto",
            steerRun: "auto",
            inspectorOpen: "auto",
            projectOpen: "auto",
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
}
