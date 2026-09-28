import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  const path = join(dataDir, "extensions", "subagent", "config.json");
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      JSON.stringify(
        {
          asyncByDefault: false,
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
