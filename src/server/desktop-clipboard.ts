import { spawn } from "node:child_process";
import { HttpError } from "./errors";

export const MAX_CLIPBOARD_CHARS = 12000;
const MAX_BYTES = MAX_CLIPBOARD_CHARS * 4;

/** Explicit human-only text transfer. No shell, argv payload, files, or logs. */
export function desktopClipboard(
  executable: string,
  env: NodeJS.ProcessEnv,
  text?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // xclip's write parent exits once it owns the selection. Its small selection
    // owner stays on this private X display until replaced or Xvfb shuts down.
    const child = spawn(
      executable,
      [
        "-selection",
        "clipboard",
        text === undefined ? "-out" : "-in",
        "-silent",
      ],
      {
        env,
        stdio: [
          text === undefined ? "ignore" : "pipe",
          text === undefined ? "pipe" : "ignore",
          "ignore",
        ],
      },
    );
    let settled = false,
      size = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, result = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new HttpError(504, "Remote clipboard timed out. Try again."));
    }, 5000);
    child.on("error", () =>
      finish(
        new HttpError(
          503,
          "Remote clipboard is unavailable. Run bun run setup:desktop.",
        ),
      ),
    );
    child.stdout?.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size > MAX_BYTES) {
        child.kill("SIGKILL");
        finish(new HttpError(413, "Remote clipboard text is too large."));
      } else chunks.push(bytes);
    });
    child.once("exit", (code) => {
      if (code !== 0)
        return finish(
          new HttpError(
            409,
            text === undefined
              ? "Remote clipboard is empty or contains no readable text. Copy text in the remote browser first."
              : "Could not set the remote clipboard.",
          ),
        );
      // Wait for stdout to drain on reads, not just for the process to exit.
      if (text !== undefined) finish();
    });
    child.once("close", (code) => {
      if (code !== 0) return;
      const result = Buffer.concat(chunks).toString("utf8");
      if (result.length > MAX_CLIPBOARD_CHARS)
        finish(new HttpError(413, "Remote clipboard text is too large."));
      else finish(undefined, result);
    });
    child.stdin?.on("error", () =>
      finish(new HttpError(503, "Could not set the remote clipboard.")),
    );
    if (text !== undefined) child.stdin?.end(text, "utf8");
  });
}
