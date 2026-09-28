import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { McpStatus } from "../shared/types";

const exec = promisify(execFile);
const cli = fileURLToPath(import.meta.resolve("mcporter/cli"));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export class Mcps {
  readonly configPath: string;
  private pending?: Promise<McpStatus>;

  constructor(
    readonly configDir = resolve(
      process.env.JELLY_CONFIG_DIR ?? join(homedir(), ".jelly"),
    ),
  ) {
    this.configPath = join(configDir, "mcporter.json");
  }

  private prepare() {
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(this.configPath, '{"mcpServers":{},"imports":[]}\n', {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  instructions() {
    this.prepare();
    const command = [process.execPath, cli, "--config", this.configPath]
      .map(quote)
      .join(" ");
    return `MCP servers are user-wide, shared by all Jelly agents and projects. You can configure and use them yourself through the installed MCPorter CLI using bash. Always use this exact command prefix (works from any working directory): ${command}
Use 'config add <name> <url>' for HTTP or 'config add <name> --command <executable> --arg <argument>' for stdio (repeat --arg as needed), 'config remove <name>' to remove, 'list' to check connections, 'list <name> --schema' to discover tools, and 'call <name>.<tool> --args <json>' to invoke them. Append '--help' for command details. Use absolute executable and cwd paths for local servers.
For OAuth servers, configure '--auth oauth --token-cache-dir <directory>' with a per-server directory under ${JSON.stringify(join(this.configDir, "mcp-auth"))}, then use 'auth <name>'. Use the private browser-login handoff if a person must sign in; never request secrets in chat. Prefer environment references such as literal ${"${TOKEN}"} in headers/env over inline secrets; do not print config or token files into chat. Keep config and credential files owner-only.
The MCPorter config is ${JSON.stringify(this.configPath)}. Preserve existing entries and imports:[] when editing it. Do not put MCP config in project directories or the instance database. Changes are available on the very next CLI command without restarting Jelly. MCP tools are called through bash, not registered as native Pi tools. After changes, verify with 'list <name>' and report whether the connection succeeded. Settings shows read-only connection status; adding, editing, removing, and authentication are handled by you with the CLI.`;
  }

  status(): Promise<McpStatus> {
    // Coalesce simultaneous settings requests, but re-read configuration on refresh.
    return (this.pending ??= this.check().finally(() => {
      this.pending = undefined;
    }));
  }

  private async check(): Promise<McpStatus> {
    try {
      this.prepare();
      const { stdout } = await exec(
        process.execPath,
        [
          cli,
          "--config",
          this.configPath,
          "list",
          "--json",
          "--no-oauth",
          "--timeout",
          "5000",
        ],
        { cwd: this.configDir, timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      );
      const result = JSON.parse(stdout);
      return {
        servers: result.servers.map(
          (server: { name: string; status: string; tools?: unknown[] }) => ({
            name: server.name,
            status:
              server.status === "ok"
                ? "connected"
                : server.status === "auth"
                  ? "needs_auth"
                  : "unavailable",
            toolCount:
              server.status === "ok" ? (server.tools?.length ?? 0) : null,
          }),
        ),
      };
    } catch {
      // CLI errors, transport URLs, headers and tool metadata can contain secrets.
      return {
        servers: [],
        error:
          "Could not check MCP connections. Ask Jelly to check its MCP configuration.",
      };
    }
  }
}
