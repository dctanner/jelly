import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  openSync,
  closeSync,
  constants,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { nativeChromeDesktop } from "../src/server/chrome-desktop";
import { spawn, execFileSync } from "node:child_process";
import {
  ChromeFrames,
  chromeFrame,
  CHROME_MAX_FRAME,
  CHROME_PROTOCOL,
} from "../src/shared/chrome-protocol";
import {
  ChromeWriter,
  CHROME_DRAIN_TIMEOUT,
} from "../src/server/chrome-writer";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function hostFixture(stalledStdout = false, env = process.env) {
  const dir = mkdtempSync(join(tmpdir(), "jelly-native-backpressure-"));
  const socketPath = join(dir, "bridge.sock");
  let accept!: (socket: Socket) => void;
  const accepted = new Promise<Socket>((resolve) => {
    accept = resolve;
  });
  const server = createServer(accept);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const config = join(dir, "config.json");
  const extensionId = "a".repeat(32);
  writeFileSync(
    config,
    JSON.stringify({
      socket: socketPath,
      extensionId,
      instance: "fixture",
      grant: "fixture",
    }),
    { mode: 0o600 },
  );
  let outputFd: number | undefined;
  if (stalledStdout) {
    const fifo = join(dir, "stdout");
    execFileSync("mkfifo", [fifo]);
    outputFd = openSync(fifo, constants.O_RDWR);
  }
  const child = spawn(
    process.execPath,
    [
      "scripts/chrome-native-host.ts",
      config,
      `chrome-extension://${extensionId}/`,
    ],
    { env, stdio: ["pipe", outputFd ?? "pipe", "ignore"] },
  );
  // The stalled-reader case deliberately kills the host with queued stdin
  // bytes. Its writer may then receive EPIPE; that is expected shutdown, not
  // a failed timeout assertion. Other child-pipe errors remain test failures.
  child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  const socket = await accepted;
  socket.on("error", () => {});
  return {
    socket,
    child,
    exited,
    async close() {
      child.kill();
      socket.destroy();
      await exited;
      if (outputFd !== undefined) closeSync(outputFd);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("native host forwards large legal frames intact in both directions under backpressure", async () => {
  const f = await hostFixture();
  try {
    const incoming = new ChromeFrames();
    const messages: unknown[] = [];
    f.socket.on("data", (data) =>
      messages.push(...incoming.push(Buffer.from(data))),
    );
    const outgoing = new ChromeFrames();
    const received: unknown[] = [];
    const reading = (async () => {
      for await (const value of f.child.stdout!.iterator({
        destroyOnReturn: false,
      })) {
        received.push(...outgoing.push(value));
        if (received.length >= 3) return;
      }
      throw new Error("Native stdout truncated");
    })();
    f.child.stdin!.write(
      chromeFrame({ type: "hello", version: CHROME_PROTOCOL }),
    );
    const payloads = [65536, 512000, CHROME_MAX_FRAME - 32].map((size) => ({
      text: "x".repeat(size),
    }));
    for (const payload of payloads) {
      f.child.stdin!.write(chromeFrame(payload));
      f.socket.write(chromeFrame(payload));
    }
    await reading;
    for (let i = 0; i < 200 && messages.length < 4; i++) await delay(10);
    expect(received).toEqual(payloads);
    expect(messages.slice(1)).toEqual(payloads);
    expect(messages[0]).toMatchObject({
      type: "hello",
      instance: "fixture",
      extensionId: "a".repeat(32),
    });
    expect(f.child.exitCode).toBeNull();
  } finally {
    await f.close();
  }
}, 15000);

test("native host times out stalled stdout and socket readers rather than buffering indefinitely", async () => {
  await Promise.all(
    ["stdout", "socket"].map(async (direction) => {
      const f = await hostFixture(direction === "stdout");
      try {
        const frame = chromeFrame({ text: "x".repeat(700000) });
        if (direction === "stdout") {
          // No stdout reader. Two frames exceed the pipe's kernel buffer.
          f.socket.write(frame);
          f.socket.write(frame);
        } else {
          // No socket reader. Keep stdin open so only the drain timeout can stop it.
          f.socket.pause();
          f.child.stdin!.write(
            chromeFrame({ type: "hello", version: CHROME_PROTOCOL }),
          );
          for (let i = 0; i < 8; i++) f.child.stdin!.write(frame);
        }
        await delay(200);
        expect(f.child.exitCode).toBeNull();
        const result = await Promise.race([
          f.exited,
          delay(CHROME_DRAIN_TIMEOUT + 3000).then(
            () => `${direction} timed out`,
          ),
        ]);
        expect(result).toBe(0);
      } finally {
        await f.close();
      }
    }),
  );
}, 15000);

test("ChromeWriter drains queued frames once in order and rejects a bounded queue overflow", async () => {
  const received: Buffer[] = [];
  let release!: () => void;
  const destination = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      received.push(Buffer.from(chunk));
      release = done;
    },
  });
  let failures = 0,
    pauses = 0,
    resumes = 0;
  const writer = new ChromeWriter(
    destination,
    () => {
      failures++;
    },
    () => {
      pauses++;
    },
    () => {
      resumes++;
    },
  );
  try {
    writer.write(Buffer.from("first"));
    writer.write(Buffer.from("second"));
    expect(received.map((b) => b.toString())).toEqual(["first"]);
    release();
    await delay(10);
    expect(received.map((b) => b.toString())).toEqual(["first", "second"]);
    release();
    await delay(10);
    expect(pauses).toBe(2);
    expect(resumes).toBe(1);
    expect(failures).toBe(0);
    const frame = chromeFrame({ text: "x".repeat(CHROME_MAX_FRAME - 32) });
    for (let i = 0; i < 5; i++) writer.write(frame);
    expect(failures).toBe(1);
  } finally {
    writer.dispose();
    destination.destroy();
  }
});

test("native host rejects spoofed desktop claims and an X11 environment without a Chrome browser parent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-native-desktop-"));
  const auth = join(dir, "authority");
  writeFileSync(auth, "private", { mode: 0o600 });
  try {
    for (const supported of [true, false]) {
      const f = await hostFixture(false, {
        ...process.env,
        XDG_SESSION_TYPE: supported ? "x11" : "wayland",
        WAYLAND_DISPLAY: "",
        DISPLAY: ":818.0",
        XAUTHORITY: auth,
      });
      try {
        const parser = new ChromeFrames();
        const received: any[] = [];
        f.socket.on("data", (b) =>
          received.push(...parser.push(Buffer.from(b))),
        );
        f.child.stdin!.write(
          chromeFrame({
            type: "hello",
            version: CHROME_PROTOCOL,
            desktop: {
              available: true,
              display: ":9999",
              auth: "/arbitrary/extension/path",
            },
          }),
        );
        for (let i = 0; i < 100 && !received.length; i++) await delay(10);
        expect(received[0]?.desktop).toEqual({ available: false });
      } finally {
        await f.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nativeChromeDesktop requires matching parent environment and unambiguous resolved X11 process evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-native-proc-"));
  const auth = join(dir, "authority"),
    exe = join(dir, "chrome");
  writeFileSync(auth, "private", { mode: 0o600 });
  writeFileSync(exe, "fixture executable identity");
  const keys = [
    "DISPLAY",
    "XAUTHORITY",
    "XDG_SESSION_TYPE",
    "WAYLAND_DISPLAY",
  ] as const;
  const saved = keys.map((key) => process.env[key]);
  const env = {
    DISPLAY: ":818.0",
    XAUTHORITY: auth,
    XDG_SESSION_TYPE: "x11",
    WAYLAND_DISPLAY: "",
  };
  Object.assign(process.env, env);
  const browser = `${exe} --user-data-dir=/private/profile\0`;
  const gpu = `${exe} --type=gpu-process --ozone-platform=x11\0`;
  const writeProcess = (
    pid: number,
    parent: number,
    command: string,
    children = "",
  ) => {
    const path = join(dir, String(pid));
    mkdirSync(join(path, "task", String(pid)), { recursive: true });
    writeFileSync(
      join(path, "stat"),
      `${pid} (chrome) S ${parent} ${Array(17).fill("0").join(" ")} 123\n`,
    );
    writeFileSync(join(path, "cmdline"), command);
    writeFileSync(join(path, "task", String(pid), "children"), children);
    symlinkSync(exe, join(path, "exe"));
  };
  const setEnvironment = (changes = {}) =>
    writeFileSync(
      join(dir, "100/environ"),
      Object.entries({ ...env, ...changes })
        .map(([k, v]) => `${k}=${v}\0`)
        .join(""),
    );
  const attest = () => nativeChromeDesktop(100, dir);
  try {
    writeProcess(100, 1, browser, "101");
    writeProcess(101, 100, gpu);
    setEnvironment();
    expect(attest()).toEqual({ available: true, display: env.DISPLAY, auth });
    expect(nativeChromeDesktop(100, dir, "darwin")).toEqual({
      available: false,
    });
    for (const extra of [
      "--display=:819",
      "--display :819",
      "-display=:819",
      "-display :819",
      "-ozone-platform=x11",
      "-ozone-platform-hint=x11",
      "-headless=new",
      "--display=:818.0",
      "--display-server=other",
      "--ozone-platform=wayland",
      "--ozone-platform=auto",
      "--ozone-platform x11",
      "--ozone-platform=x11 --ozone-platform=x11",
      "--ozone-platform-hint=auto",
      "--ozone-platform-hint=wayland",
      "--headless=new",
      "--type=renderer",
      "--user-data-dir=/path/containing--ozone-platform=x11",
    ]) {
      writeFileSync(
        join(dir, "100/cmdline"),
        browser.slice(0, -1) + ` ${extra}\0`,
      );
      expect(attest()).toEqual({ available: false });
    }
    writeFileSync(
      join(dir, "100/cmdline"),
      browser.slice(0, -1) +
        " --ozone-platform=x11 --ozone-platform-hint=x11\0",
    );
    expect(attest()).toEqual({ available: true, display: env.DISPLAY, auth });
    writeFileSync(join(dir, "100/cmdline"), browser);
    for (const command of [
      `${exe} --type=gpu-process\0`,
      `${exe} --type=gpu-process --ozone-platform=wayland\0`,
      `${exe} --type=gpu-process --ozone-platform=x11 --ozone-platform=wayland\0`,
      `${exe} --type=gpu-process --ozone-platform=x11 --ozone-platform-hint=auto\0`,
      `${exe} --type=gpu-process --ozone-platform=x11 --display=:819\0`,
      `${exe} --type=renderer --type=gpu-process --ozone-platform=x11\0`,
    ]) {
      writeFileSync(join(dir, "101/cmdline"), command);
      expect(attest()).toEqual({ available: false });
    }
    writeFileSync(join(dir, "101/cmdline"), gpu);
    for (const changes of [
      { DISPLAY: ":819" },
      { XAUTHORITY: "/different/private/auth" },
      { XDG_SESSION_TYPE: "wayland" },
      { WAYLAND_DISPLAY: "wayland-0" },
      { OZONE_PLATFORM: "wayland" },
    ]) {
      setEnvironment(changes);
      expect(attest()).toEqual({ available: false });
    }
    setEnvironment();
    writeFileSync(join(dir, "100/task/100/children"), "");
    expect(attest()).toEqual({ available: false });
    writeFileSync(join(dir, "100/task/100/children"), "101 ".repeat(129));
    expect(attest()).toEqual({ available: false });
    writeFileSync(join(dir, "100/task/100/children"), "101");
    rmSync(join(dir, "101/exe"));
    symlinkSync(process.execPath, join(dir, "101/exe"));
    expect(attest()).toEqual({ available: false });
    rmSync(join(dir, "101/exe"));
    symlinkSync(exe, join(dir, "101/exe"));
    rmSync(join(dir, "100/exe"));
    symlinkSync(process.execPath, join(dir, "100/exe"));
    expect(attest()).toEqual({ available: false });
  } finally {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
