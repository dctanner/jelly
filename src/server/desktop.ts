import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DesktopPermission, DesktopStatus } from "../shared/desktop";
import { rasterMime } from "./raster-images";
import { MAX_TOOL_IMAGE_BYTES } from "../shared/tool-images";

const CANDIDATES = [
  "/opt/homebrew/bin/peekaboo",
  "/usr/local/bin/peekaboo",
];
const MAX_OUTPUT = 200_000;

export interface DesktopOptions {
  platform?: string;
  /** Override CLI discovery (tests). */
  cliPath?: string | null;
}

function run(
  cli: string,
  args: string[],
  timeout = 120_000,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cli,
      args,
      { timeout, maxBuffer: 32 * 1024 * 1024, encoding: "utf8", signal },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? (error ? error.message : "")),
        }),
    );
  });
}

/** Full-access Peekaboo integration: one on/off switch, no app allowlists. */
export class Desktop {
  private enabled = false;
  private configPath: string;
  private cached: { at: number; status: DesktopStatus } | null = null;
  constructor(
    dataDir: string,
    private options: DesktopOptions = {},
    private notify: () => void = () => {},
  ) {
    this.configPath = join(dataDir, "desktop.json");
    try {
      this.enabled =
        JSON.parse(readFileSync(this.configPath, "utf8")).enabled === true;
    } catch {
      this.enabled = false;
    }
  }
  get platformSupported() {
    return (this.options.platform ?? process.platform) === "darwin";
  }
  cli(): string | null {
    if (this.options.cliPath !== undefined) return this.options.cliPath;
    return CANDIDATES.find((path) => existsSync(path)) ?? null;
  }
  get active() {
    return this.enabled && this.platformSupported && !!this.cli();
  }
  async status(fresh = false): Promise<DesktopStatus> {
    if (!fresh && this.cached && Date.now() - this.cached.at < 3000)
      return this.cached.status;
    const cli = this.platformSupported ? this.cli() : null;
    let version: string | null = null;
    let permissions: DesktopPermission[] = [];
    if (cli) {
      const [v, p] = await Promise.all([
        run(cli, ["--version"], 10_000),
        run(cli, ["permissions", "--json"], 15_000),
      ]);
      version = v.stdout.match(/Peekaboo\s+([\w.-]+)/)?.[1] ?? null;
      try {
        const rows = JSON.parse(p.stdout)?.data?.permissions;
        if (Array.isArray(rows))
          permissions = rows.map((row: Record<string, unknown>) => ({
            name: String(row.name),
            granted: row.isGranted === true,
            instructions:
              typeof row.grantInstructions === "string"
                ? row.grantInstructions
                : undefined,
          }));
      } catch {
        /* Unknown permissions are shown as empty. */
      }
    }
    const status: DesktopStatus = {
      enabled: this.enabled,
      platformSupported: this.platformSupported,
      installed: !!cli,
      version,
      permissions,
    };
    this.cached = { at: Date.now(), status };
    return status;
  }
  async configure(input: unknown): Promise<DesktopStatus> {
    const enabled = (input as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean")
      throw new Error("enabled must be a boolean.");
    await mkdir(join(this.configPath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(this.configPath, JSON.stringify({ enabled }), {
      mode: 0o600,
    });
    this.enabled = enabled;
    this.notify();
    return this.status(true);
  }
  async requestPermissions(): Promise<DesktopStatus> {
    const cli = this.cli();
    if (cli)
      for (const kind of ["accessibility", "screen-recording"])
        await run(cli, ["permissions", "request", kind], 30_000);
    return this.status(true);
  }
  tools(): ToolDefinition[] {
    if (!this.active) return [];
    return [
      {
        name: "peekaboo",
        label: "Mac",
        description:
          "Control this Mac with the Peekaboo CLI (full access). Pass the CLI arguments, e.g. [\"see\",\"--app\",\"Notes\",\"--json\"], [\"click\",\"--on\",\"B3\"], [\"type\",\"hello\"], [\"press\",\"cmd+s\"], [\"app\",\"launch\",\"Safari\"]. Run [\"learn\"] for the full guide. Screenshots produced by the command are attached.",
        parameters: Type.Object({
          args: Type.Array(Type.String(), {
            minItems: 1,
            description: "Arguments passed to the peekaboo CLI.",
          }),
        }),
        execute: async (_id, input: { args: string[] }, signal) => {
          const cli = this.cli();
          if (!cli) throw new Error("Peekaboo is not installed.");
          const result = await run(cli, input.args, 120_000, signal);
          const text = [result.stdout, result.stderr && `stderr:\n${result.stderr}`]
            .filter(Boolean)
            .join("\n")
            .slice(0, MAX_OUTPUT);
          const images = screenshots(result.stdout);
          if (result.code !== 0 && !images.length)
            throw new Error(text || `peekaboo exited with ${result.code}`);
          return {
            content: [{ type: "text" as const, text: text || "(no output)" }, ...images],
            details: {},
          };
        },
      } as ToolDefinition,
    ];
  }
}

function screenshots(stdout: string) {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  const paths = new Set<string>();
  const visit = (value: unknown, key = "") => {
    if (typeof value === "string") {
      if (
        /^(screenshot_raw|screenshot_annotated|screenshotPath|path)$/.test(key) &&
        /\.(png|jpe?g)$/i.test(value)
      )
        paths.add(value);
    } else if (Array.isArray(value)) value.forEach((item) => visit(item, key));
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) visit(v, k);
  };
  visit(data);
  const images = [];
  for (const path of [...paths].slice(0, 2)) {
    try {
      const bytes = readFileSync(path);
      const mimeType = rasterMime(bytes);
      if (
        (mimeType === "image/png" || mimeType === "image/jpeg") &&
        bytes.length <= MAX_TOOL_IMAGE_BYTES
      )
        images.push({
          type: "image" as const,
          mimeType,
          data: bytes.toString("base64"),
        });
    } catch {
      /* Missing screenshot files are ignored. */
    }
  }
  return images;
}
