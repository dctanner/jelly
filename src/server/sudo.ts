import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  realpathSync,
  statSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
export interface SudoCommand {
  executable: string;
  args: string[];
  cwd: string;
  summary: string;
  reason: string;
}
export interface SudoResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  timedOut: boolean;
}
export type SudoExecutor = (
  command: SudoCommand,
  password: Buffer,
  signal: AbortSignal,
) => Promise<SudoResult>;
export function validateCommand(command: SudoCommand): SudoCommand {
  if (!isAbsolute(command.executable) || command.executable.includes("\0"))
    throw new Error("Sudo requires an absolute executable path.");
  const executable = realpathSync(command.executable);
  if (!statSync(executable).isFile()) throw new Error("Invalid executable.");
  if (
    !Array.isArray(command.args) ||
    command.args.length > 64 ||
    command.args.some(
      (a) => typeof a !== "string" || a.length > 8192 || a.includes("\0"),
    ) ||
    JSON.stringify(command.args).length > 24000
  )
    throw new Error("Invalid command arguments.");
  if (
    typeof command.reason !== "string" ||
    !command.reason.trim() ||
    command.reason.length > 2000
  )
    throw new Error("A short reason is required.");
  if (
    typeof command.summary !== "string" ||
    !command.summary.trim() ||
    command.summary.length > 500
  )
    throw new Error(
      "A human-readable command summary of up to 500 characters is required.",
    );
  const cwd = realpathSync(command.cwd);
  if (!statSync(cwd).isDirectory())
    throw new Error("Invalid working directory.");
  return {
    executable,
    args: [...command.args],
    cwd,
    summary: command.summary.trim(),
    reason: command.reason.trim(),
  };
}
export function createSudoExecutor(
  sudoPath = "/usr/bin/sudo",
  timeoutMs = 120000,
): SudoExecutor {
  return async (command, password, signal) => {
    const dir = mkdtempSync(join(tmpdir(), "jelly-auth-")),
      socket = join(dir, "auth.sock"),
      helper = join(dir, "askpass");
    let supplied = false,
      stdout = "",
      stderr = "",
      cancelled = false,
      timedOut = false;
    // A private askpass socket separates authentication completely from command stdin.
    const broker = createServer((client) => {
      client.on("error", () => {});
      if (supplied) {
        client.destroy();
        return;
      }
      supplied = true;
      client.end(Buffer.concat([password, Buffer.from("\n")]));
    });
    let timer: ReturnType<typeof setTimeout> | undefined,
      killTimer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        broker.once("error", reject);
        broker.listen(socket, resolve);
      });
      writeFileSync(
        helper,
        `#!/usr/bin/python3\nimport socket,sys\ns=socket.socket(socket.AF_UNIX)\ns.connect(${JSON.stringify(socket)})\nwhile True:\n b=s.recv(4096)\n if not b: break\n sys.stdout.buffer.write(b)\n`,
        { mode: 0o700 },
      );
      const child = spawn(
        sudoPath,
        [
          ...(password.length ? ["-k", "-A"] : ["-n"]),
          "--",
          command.executable,
          ...command.args,
        ],
        {
          cwd: command.cwd,
          env: {
            PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            LANG: "C.UTF-8",
            HOME: process.env.HOME ?? "/",
            SUDO_ASKPASS: helper,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const terminate = () => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
        killTimer.unref();
      };
      abort = () => {
        cancelled = true;
        terminate();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timer.unref();
      // Keep a secret-length suffix until redaction, so truncation cannot expose a partial password.
      const captureLimit = 64000 + password.length + 4;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(0, captureLimit);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(0, captureLimit);
      });
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      const secret = password.toString();
      const redact = (s: string) =>
        secret ? s.split(secret).join("[redacted]") : s;
      return {
        exitCode,
        stdout: redact(stdout).slice(0, 64000),
        stderr: redact(stderr).slice(0, 64000),
        cancelled,
        timedOut,
      };
    } finally {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      broker.close();
      rmSync(dir, { recursive: true, force: true });
      password.fill(0);
    }
  };
}
