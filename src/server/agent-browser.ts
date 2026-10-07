import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright-core";

/** Pinned 0.38.2 native CLI daemon protocol (cli/src/commands.rs). No shell,
 * ambient config, automatic browser launch, snapshots, or credential exports.
 * Jelly owns Chromium/profile and the safety/observation bridge. */
export class AgentBrowser {
  private process?: ChildProcess;
  private failed = false;
  constructor(private runtime: string) {}
  async start(
    endpoint: string,
    protectPort: (port: number) => void,
    streamPort: number,
  ) {
    if (!Number.isInteger(streamPort) || streamPort < 1 || streamPort > 65535)
      throw new Error("Invalid reserved AgentBrowser control port.");
    if (
      process.platform !== "linux" ||
      !["x64", "arm64"].includes(process.arch)
    )
      throw new Error("AgentBrowser requires Linux x64 or arm64.");
    const musl =
      existsSync("/lib/ld-musl-x86_64.so.1") ||
      existsSync("/lib/ld-musl-aarch64.so.1");
    const binary = resolve(
      import.meta.dir,
      `../../node_modules/agent-browser/bin/agent-browser-linux-${musl ? "musl-" : ""}${process.arch}`,
    );
    if (!existsSync(binary))
      throw new Error(
        "AgentBrowser is unavailable. Reinstall the pinned agent-browser dependency.",
      );
    // The npm tarball ships binaries as 0644. Match upstream's launcher repair
    // without trusting its postinstall (which can download a separate browser).
    try {
      accessSync(binary, constants.X_OK);
    } catch {
      try {
        chmodSync(binary, 0o755);
      } catch {
        throw new Error(
          "AgentBrowser binary is not executable. Reinstall agent-browser with executable permissions.",
        );
      }
    }
    this.process = spawn(
      "/usr/bin/python3",
      [resolve(import.meta.dir, "../../scripts/desktop-child.py"), binary],
      {
        cwd: this.runtime,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: this.runtime,
          LANG: "C.UTF-8",
          AGENT_BROWSER_DAEMON: "1",
          AGENT_BROWSER_SESSION: "jelly",
          AGENT_BROWSER_SOCKET_DIR: this.runtime,
          AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
          AGENT_BROWSER_DEFAULT_TIMEOUT: "10000",
          AGENT_BROWSER_STREAM_PORT: String(streamPort),

          AGENT_BROWSER_CDP: endpoint,
        },
        stdio: "ignore",
      },
    );
    this.process.on("error", () => {
      this.failed = true;
    });
    this.process.on("exit", () => {
      this.failed = true;
    });
    const deadline = Date.now() + 10000;
    while (
      !existsSync(join(this.runtime, "jelly.sock")) ||
      !existsSync(join(this.runtime, "jelly.stream"))
    ) {
      if (this.failed || Date.now() > deadline)
        throw new Error("AgentBrowser could not start.");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const port = Number(
      readFileSync(join(this.runtime, "jelly.stream"), "utf8"),
    );
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid AgentBrowser control port.");
    protectPort(port);
    // Upstream falls back to a random port on bind failure. Never attach a
    // browser to that unexpected listener; protect it and fail closed instead.
    if (port !== streamPort) {
      this.failed = true;
      this.process.kill("SIGKILL");
      throw new Error(
        "AgentBrowser control port changed. Close and reopen the browser session.",
      );
    }
    // Attaching pinned without a prior binding creates an extra blank tab.
    // Attach without input first; act() selects an owned target and pins it
    // before sending any actual browser operation.
    await this.command("launch", { cdpUrl: endpoint, pinTab: false });
  }
  private command(
    action: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (
      this.failed ||
      !this.process ||
      this.process.exitCode !== null ||
      this.process.signalCode
    )
      return Promise.reject(
        new Error(
          "AgentBrowser disconnected. Close and reopen this browser session.",
        ),
      );
    return new Promise((resolve, reject) => {
      const socket = connect(join(this.runtime, "jelly.sock"));
      let data = "",
        settled = false;
      const finish = (error?: Error, value?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value ?? {});
      };
      const timer = setTimeout(() => {
        // A timed-out native operation must not continue into a human handoff.
        this.failed = true;
        this.process?.kill("SIGKILL");
        finish(
          new Error(
            "AgentBrowser timed out. Close and reopen this browser session.",
          ),
        );
      }, 35000);
      const transportFailure = (message: string) => {
        if (settled) return;
        // A dropped response does not prove the native action finished. Stop
        // the controller before allowing a queued private handoff to proceed.
        this.failed = true;
        this.process?.kill("SIGKILL");
        finish(new Error(message));
      };
      socket.on("error", () =>
        transportFailure("AgentBrowser connection failed."),
      );
      socket.on("close", () => transportFailure("AgentBrowser disconnected."));
      socket.on("connect", () =>
        socket.write(
          JSON.stringify({ id: crypto.randomUUID(), action, ...args }) + "\n",
        ),
      );
      socket.on("data", (chunk) => {
        data += chunk.toString();
        if (data.length > 1024 * 1024) {
          this.failed = true;
          this.process?.kill("SIGKILL");
          finish(new Error("AgentBrowser response exceeded its limit."));
          return;
        }
        if (!data.includes("\n")) return;
        try {
          const response = JSON.parse(data.slice(0, data.indexOf("\n")));
          // Native errors can contain page text/URLs. Never forward those.
          if (response.success !== true)
            finish(
              new Error(
                "AgentBrowser action failed. Refresh the observation and try again.",
              ),
            );
          else finish(undefined, response.data ?? {});
        } catch {
          transportFailure("Invalid AgentBrowser response.");
        }
      });
    });
  }
  async act(
    page: Page,
    action: string,
    args: Record<string, unknown>,
    guard: () => void,
  ) {
    guard();
    const session = await page.context().newCDPSession(page);
    let targetId: string;
    try {
      targetId = (await session.send("Target.getTargetInfo")).targetInfo
        .targetId;
    } finally {
      await session.detach();
    }
    guard();
    // Never rely on native active-tab heuristics or URL matching. Pinning makes
    // a closed target fail rather than directing input into a neighboring tab.
    await this.command("tab_switch", { tabId: targetId, pinTab: true });
    guard();
    let result: Record<string, unknown>;
    if (action === "coordinateClick") {
      await this.command("mouse", { ...args, eventType: "mouseMoved" });
      await this.command("mouse", {
        ...args,
        eventType: "mousePressed",
        button: "left",
        clickCount: 1,
      });
      // Finish the same click before releasing the serialization lock to VNC.
      result = await this.command("mouse", {
        ...args,
        eventType: "mouseReleased",
        button: "left",
        clickCount: 1,
      });
    } else result = await this.command(action, args);
    guard();
    return result;
  }
  async close() {
    const child = this.process;
    if (!child) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child.pid || child.exitCode !== null || child.signalCode)
        return resolve();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.process = undefined;
  }
}
