import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ChromeDesktopBinding } from "./chrome-desktop";
import { HttpError } from "./errors";
import {
  COMPUTER_CLIPBOARD_MAX_BYTES,
  validClipboardText,
} from "../shared/computer-clipboard";

type Helper = Bun.Subprocess<"pipe", "pipe", "ignore">;
const unavailable = () =>
  new HttpError(
    409,
    "Text transfer could not be confirmed. Check the computer clipboard and try again.",
  );

/** On-demand CLIPBOARD/UTF8_STRING only. No polling, files, logging or model interface.
 * xclip stays in the foreground with parent-death protection; the selection owner
 * lives until replaced or the viewer is revoked. OS clipboard managers may retain it.
 */
export class ComputerClipboard {
  private children = new Set<Helper>();
  private busy = false;
  private epoch = 0;
  stop() {
    ++this.epoch;
    for (const child of this.children) child.kill("SIGKILL");
  }
  async drain() {
    this.stop();
    // A clipboard-only cleanup problem must not bypass held-key cleanup.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([...this.children].map((child) => child.exited)),
      new Promise<void>((done) => {
        timer = setTimeout(done, 1500);
      }),
    ]);
    clearTimeout(timer);
  }
  private start(binding: ChromeDesktopBinding, read: boolean) {
    if (this.children.size >= 4) throw unavailable();
    if (!existsSync("/usr/bin/xclip"))
      throw new HttpError(
        409,
        "Text transfer requires xclip on the computer. Keyboard and pointer control are still available.",
      );
    let child: Helper;
    try {
      child = Bun.spawn(
        [
          "/usr/bin/python3",
          resolve(import.meta.dir, "../../scripts/desktop-child.py"),
          "--expected-parent",
          String(process.pid),
          ...(read
            ? ["/usr/bin/python3", resolve(import.meta.dir, "../../scripts/computer-clipboard-read.py")]
            : ["/usr/bin/xclip", "-quiet", "-selection", "clipboard", "-target", "UTF8_STRING", "-in"]),
        ],
        {
          env: {
            PATH: "/usr/bin:/bin",
            LANG: "C.UTF-8",
            DISPLAY: binding.display,
            XAUTHORITY: binding.auth,
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        },
      );
    } catch {
      throw unavailable();
    }
    this.children.add(child);
    void child.exited.then(() => this.children.delete(child));
    return child;
  }
  private async read(binding: ChromeDesktopBinding): Promise<string> {
    const child = this.start(binding, true);
    child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reading = (async () => {
      const reader = child.stdout.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > COMPUTER_CLIPBOARD_MAX_BYTES)
            throw new HttpError(
              413,
              "Computer clipboard exceeds the 256 KiB text limit. Nothing was transferred.",
            );
          chunks.push(value);
        }
        if ((await child.exited) !== 0) throw unavailable();
        try {
          return new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(Buffer.concat(chunks));
        } catch {
          throw new HttpError(
            409,
            "The computer clipboard is not supported UTF-8 text. Nothing was transferred.",
          );
        }
      } finally {
        reader.releaseLock();
      }
    })();
    try {
      return await Promise.race([
        reading,
        new Promise<never>((_done, reject) => {
          timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(unavailable());
          }, 1200);
        }),
      ]);
    } catch (error) {
      child.kill("SIGKILL");
      throw error instanceof HttpError ? error : unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
  private async readText(binding: ChromeDesktopBinding, current: () => void) {
    current();
    // The native reader checks the actual conversion, including INCR completion;
    // failed/changed formats cannot masquerade as successful empty text.
    const text = await this.read(binding);
    current();
    return text;
  }
  async transfer(
    binding: ChromeDesktopBinding,
    requireCurrent: () => void,
    text?: string,
  ) {
    requireCurrent();
    if (this.busy)
      throw new HttpError(
        409,
        "Another text transfer is in progress. Try again when it finishes.",
      );
    if (text !== undefined && !validClipboardText(text))
      throw new HttpError(
        413,
        "Send valid Unicode text up to 256 KiB. Nothing was transferred.",
      );
    this.busy = true;
    const epoch = this.epoch;
    const current = () => {
      requireCurrent();
      if (epoch !== this.epoch) throw unavailable();
    };
    let writer: Helper | undefined;
    try {
      current();
      if (text === undefined)
        return { text: await this.readText(binding, current) };
      writer = this.start(binding, false);
      writer.stdin.write(Buffer.from(text, "utf8"));
      writer.stdin.end();
      // Spawn is not an ACK: confirm exact bounded UTF-8 readback before any paste.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        await Bun.sleep(25);
        current();
        if (writer.exitCode !== null) throw unavailable();
        try {
          const actual = await this.readText(binding, current);
          current();
          if (actual === text) return { ok: true };
        } catch {
          current();
        }
      }
      throw unavailable();
    } catch (error) {
      writer?.kill("SIGKILL");
      throw error instanceof HttpError ? error : unavailable();
    } finally {
      this.busy = false;
    }
  }
}
