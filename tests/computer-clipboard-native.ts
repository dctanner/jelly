import { expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { ComputerClipboard } from "../src/server/computer-clipboard";
import { bindChromeDesktop } from "../src/server/chrome-desktop";

// Never use the host clipboard: every helper is bound to this private X server.
const dir = mkdtempSync(join(tmpdir(), "jelly-clipboard-native-"));
const auth = join(dir, "Xauthority");
const field = (bytes: Buffer) => {
  const size = Buffer.alloc(2);
  size.writeUInt16BE(bytes.length);
  return Buffer.concat([size, bytes]);
};
writeFileSync(
  auth,
  Buffer.concat([
    Buffer.from([255, 255]),
    field(Buffer.alloc(0)),
    field(Buffer.alloc(0)),
    field(Buffer.from("MIT-MAGIC-COOKIE-1")),
    field(randomBytes(16)),
  ]),
  { mode: 0o600 },
);
const env = {
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  XAUTHORITY: auth,
  LD_LIBRARY_PATH: resolve(".jelly/runtime/usr/lib/x86_64-linux-gnu"),
};
const xvfb = Bun.spawn(
  [
    resolve(".jelly/runtime/usr/bin/Xvfb"),
    "-displayfd",
    "1",
    "-screen",
    "0",
    "800x600x24",
    "-nolisten",
    "tcp",
    "-auth",
    auth,
  ],
  { env, stdout: "pipe", stderr: "ignore" },
);
const reader = xvfb.stdout.getReader();
const display = `:${new TextDecoder().decode((await reader.read()).value).trim()}`;
reader.releaseLock();
const clipboard = new ComputerClipboard();

try {
  const binding = bindChromeDesktop({ available: true, display, auth });
  let live = true;
  const current = () => {
    if (!live) throw new Error("revoked fixture");
  };
  for (const text of [
    "\uFEFF雪 café 🪼\nsecond line\r\n",
    "",
    "🪼".repeat(65536),
  ]) {
    console.log("Checking native round trip byte length:", Buffer.byteLength(text));
    expect(await clipboard.transfer(binding, current, text)).toEqual({
      ok: true,
    });
    expect(await clipboard.transfer(binding, current)).toEqual({ text });
  }
  await expect(
    clipboard.transfer(binding, current, "🪼".repeat(65537)),
  ).rejects.toThrow("256 KiB");
  await expect(clipboard.transfer(binding, current, "\ud800")).rejects.toThrow(
    "Unicode",
  );
  for (const kind of [
    "oversize",
    "invalid-utf8",
    "unsupported",
    "unresponsive",
  ] as const) {
    console.log(`Checking native rejection: ${kind}`);
    const owner = Bun.spawn(
      [
        "/usr/bin/xclip",
        "-quiet",
        "-selection",
        "clipboard",
        "-target",
        kind === "unsupported" ? "application/octet-stream" : "UTF8_STRING",
      ],
      {
        env: { ...env, DISPLAY: display },
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    owner.stdin.write(
      kind === "oversize"
        ? Buffer.alloc(256 * 1024 + 1, 65)
        : kind === "invalid-utf8"
          ? Buffer.from([0xff, 0xfe])
          : "fixture",
    );
    owner.stdin.end();
    try {
      await Bun.sleep(150);
      if (kind === "unresponsive") owner.kill("SIGSTOP");
      const started = Date.now();
      await expect(clipboard.transfer(binding, current)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2500);
    } finally {
      owner.kill("SIGKILL");
      await owner.exited;
    }
  }
  for (const mode of ["reject", "change-owner", "change-format", "incr", "incr-format", "incr-invalid", "incr-over"]) {
    console.log(`Checking actual selection conversion: ${mode}`);
    const owner = Bun.spawn(["/usr/bin/python3", resolve("tests/fixtures/clipboard-owner.py"), mode],
      { env: { ...env, DISPLAY: display }, stdout: "pipe", stderr: "ignore" });
    const ready = owner.stdout.getReader();
    expect(new TextDecoder().decode((await ready.read()).value).trim()).toBe("ready"); ready.releaseLock();
    try {
      if (mode === "change-format") expect(await clipboard.transfer(binding, current)).toEqual({ text: "first" });
      const read = Bun.spawn(["/usr/bin/python3", resolve("scripts/desktop-child.py"), "--expected-parent", String(process.pid),
        "/usr/bin/python3", resolve("scripts/computer-clipboard-read.py")],
        { env: { ...env, DISPLAY: display }, stdout: "pipe", stderr: "pipe" });
      const bytes = await new Response(read.stdout).arrayBuffer();
      const code = await read.exited;
      expect(await new Response(read.stderr).text()).toBe("");
      if (mode === "incr") { expect(code).toBe(0); expect(bytes.byteLength).toBe(256 * 1024); }
      else { expect(code).not.toBe(0); expect(bytes.byteLength).toBe(0); }
    } finally { owner.kill("SIGKILL"); await owner.exited; }
  }
  const writing = clipboard.transfer(binding, current, "pending");
  await expect(
    clipboard.transfer(binding, current, "concurrent"),
  ).rejects.toThrow("progress");
  live = false;
  clipboard.stop();
  await expect(writing).rejects.toThrow();
  await clipboard.drain();
  expect((clipboard as any).children.size).toBe(0);
  console.log(
    "PASS: disposable X11 clipboard UTF-8/BOM/newline/empty/256 KiB round trips; oversized/invalid/unsupported/hung-owner rejection; failed/changed owner and format, bounded INCR and all-or-nothing output; serialized writes, revoke cancellation and helper cleanup.",
  );
} finally {
  await clipboard.drain();
  xvfb.kill();
  await xvfb.exited;
  rmSync(dir, { recursive: true, force: true });
}
