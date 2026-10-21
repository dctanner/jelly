import { chromium, type BrowserContext, type Browser } from "playwright-core";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { expect } from "bun:test";
import { startApp } from "./fixtures/app";
import { ChromeSessions } from "../src/server/chrome-sessions";
import { ChromeShare } from "../src/server/chrome-share";
import { openChromeViewer } from "./fixtures/chrome-viewer";

// All Chrome profiles, host registrations, X11 authority and displays are disposable.
const dir = mkdtempSync(join(tmpdir(), "jelly-chrome-share-browser-"));
const dataDir = join(dir, "data");
mkdirSync(dataDir);
symlinkSync(resolve(".jelly/runtime"), join(dataDir, "runtime"));
const auth = join(dir, "Xauthority");
const field = (b: Buffer) => {
  const n = Buffer.alloc(2);
  n.writeUInt16BE(b.length);
  return Buffer.concat([n, b]);
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
const xenv = {
  PATH: process.env.PATH!,
  LANG: "C.UTF-8",
  XDG_SESSION_TYPE: "x11",
  XAUTHORITY: auth,
  LD_LIBRARY_PATH: resolve(".jelly/runtime/usr/lib/x86_64-linux-gnu"),
};
async function disposableDisplay() {
  const process = Bun.spawn(
    [
      resolve(".jelly/runtime/usr/bin/Xvfb"),
      "-displayfd",
      "1",
      "-screen",
      "0",
      "1280x900x24",
      "-nolisten",
      "tcp",
      "-auth",
      auth,
    ],
    { env: xenv, stdout: "pipe", stderr: "ignore" },
  );
  const reader = process.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  return {
    process,
    display: `:${new TextDecoder().decode(first.value).trim()}`,
  };
}
const { process: xvfb, display } = await disposableDisplay();
const { process: decoyXvfb, display: decoyDisplay } = await disposableDisplay();
const app = await startApp({
  dataDir,
  configDir: join(dir, "config"),
  port: 0,
});
const fixtureHttpPort = app.server.port!;
const site = Bun.serve({
  hostname: "127.0.0.2",
  port: 0,
  fetch: () =>
    new Response(
      `
  <body style="background:#142e48;color:white"><h1>Connected Chrome human fixture</h1>
  <button style="position:absolute;left:100px;top:150px;width:240px;height:100px;background:rgb(231,17,123);border:0"
    onclick="document.querySelector('h1').textContent='Human VNC click received';document.querySelector('input').focus()">Human button</button>
  <input style="position:absolute;top:300px;left:100px" aria-label="Human text">
  <script>document.cookie='sameProfile=preserved;SameSite=Lax'</script>`,
      { headers: { "Content-Type": "text/html" } },
    ),
});
let personal: BrowserContext | undefined;
let assertionsPassed = false;
type FixtureBrowserIdentity = {
  pid: number;
  start: string;
  exe: string;
  profile: string;
};
let personalIdentity: FixtureBrowserIdentity | undefined;
function processStart(pid: number) {
  const value = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0], start: fields[19] };
}
async function closeFixtureBrowser(
  browser: Browser | null | undefined,
  identity: FixtureBrowserIdentity | undefined,
) {
  if (!browser) return;
  const closing = browser.close().then(
    () => true,
    () => false,
  );
  await Promise.race([closing, Bun.sleep(3000).then(() => false)]);
  // Bun/Playwright can wait forever for persistent-context shutdown. Only this
  // disposable profile's original, still-identical process may be terminated.
  if (!identity) throw new Error("Missing disposable Chrome process identity.");
  const alive = () => {
    try {
      const current = processStart(identity.pid);
      if (current.state === "Z" || current.start !== identity.start)
        return false;
      if (!(
        lstatSync(`/proc/${identity.pid}`).uid === process.getuid?.() &&
        readlinkSync(`/proc/${identity.pid}/exe`) === identity.exe &&
        readFileSync(`/proc/${identity.pid}/cmdline`, "utf8").includes(
          identity.profile,
        )
      ))
        throw new Error(
          "Disposable Chrome identity changed; refusing cleanup signal.",
        );
      return true;
    } catch (error) {
      if (
        ["ENOENT", "ESRCH"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return false;
      throw error;
    }
  };
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!alive()) return;
    process.kill(identity.pid, signal);
    for (let i = 0; i < 80 && alive(); i++) await Bun.sleep(25);
  }
  if (alive()) throw new Error("Disposable Chrome did not terminate.");
}
const viewerBrowser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
});
const viewerInspector = await viewerBrowser.newBrowserCDPSession();
const viewerProcesses = await viewerInspector.send("SystemInfo.getProcessInfo");
const viewerPid = viewerProcesses.processInfo.find(
  (p) => p.type === "browser",
)!.id;
const viewerProfile = readFileSync(`/proc/${viewerPid}/cmdline`, "utf8").match(
  /--user-data-dir=(\/tmp\/playwright_chromiumdev_profile-[^\s\0]+)/,
)?.[1];
if (!viewerProfile)
  throw new Error("Missing disposable viewer profile identity.");
const viewerIdentity: FixtureBrowserIdentity = {
  pid: viewerPid,
  start: processStart(viewerPid).start!,
  exe: readlinkSync(`/proc/${viewerPid}/exe`),
  profile: viewerProfile,
};
await viewerInspector.detach();
const ui = await viewerBrowser.newContext({
  viewport: { width: 1100, height: 1000 },
});
const page = await ui.newPage();
const errors: string[] = [],
  frames: Buffer[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("websocket", (ws) => {
  if (ws.url().includes("/chrome/share/socket"))
    ws.on("framereceived", (e) => frames.push(Buffer.from(e.payload)));
});
const agent = app.store.agents()[0]!;
const chrome = app.service.chrome;
async function command(args: string[], env = process.env) {
  const child = Bun.spawn(args, { env, stdout: "ignore", stderr: "pipe" });
  if (await child.exited)
    throw new Error(await new Response(child.stderr).text());
}
async function installHost(profile: string, config: string, id: string) {
  for (const root of [
    profile,
    ...["google-chrome", "chromium", "google-chrome-for-testing"].map((p) =>
      join(config, p),
    ),
  ])
    await command([
      process.execPath,
      "scripts/install-chrome-host.ts",
      "--data-dir",
      dataDir,
      "--extension-id",
      id,
      "--chrome-config",
      root,
    ]);
}
async function waitFor(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 15000;
  while (!(await check())) {
    if (Date.now() > end)
      throw new Error(
        `Headed share fixture timed out: ${check.toString().slice(0, 250)}`,
      );
    await Bun.sleep(50);
  }
}
try {
  const extension = join(dir, "extension");
  await command(
    [process.execPath, "scripts/build-chrome-extension.ts", extension],
    process.env,
  );
  const home = join(dir, "home"),
    config = join(home, ".config"),
    profileDir = join(dir, "profile");
  mkdirSync(config, { recursive: true });
  // A real Chrome window runs ONLY on the explicit override display, despite
  // inheriting another valid X server. Neither desktop may be captured by guessing.
  for (const displaySwitch of ["--display", "-display"]) {
    const overrideProfile = join(
      dir,
      `override-profile-${displaySwitch.length}`,
    );
    const overridden = await chromium.launchPersistentContext(overrideProfile, {
      executablePath:
        process.env.JELLY_EXTENSION_BROWSER_PATH ?? chromium.executablePath(),
      headless: false,
      ignoreDefaultArgs: ["--disable-extensions"],
      env: {
        ...xenv,
        HOME: home,
        XDG_CONFIG_HOME: config,
        DISPLAY: decoyDisplay,
      },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        `${displaySwitch}=${display}`,
      ],
    });
    try {
      const worker =
        overridden.serviceWorkers()[0] ??
        (await overridden.waitForEvent("serviceworker"));
      const id = new URL(worker.url()).host;
      await installHost(overrideProfile, config, id);
      const window = await overridden.newPage();
      await window.setContent(
        "<title>Chrome display override regression</title><h1>Only on overridden display</h1>",
      );
      const windows = async (d: string) => {
        const child = Bun.spawn(
          ["/usr/bin/xwininfo", "-display", d, "-root", "-tree"],
          { env: xenv, stdout: "pipe", stderr: "ignore" },
        );
        const output = await new Response(child.stdout).text();
        expect(await child.exited).toBe(0);
        return output;
      };
      await waitFor(async () =>
        (await windows(display)).includes("Chrome display override regression"),
      );
      expect(
        (await windows(decoyDisplay)).includes(
          "Chrome display override regression",
        ),
      ).toBe(false);
      const popup = await overridden.newPage();
      await popup.goto(`chrome-extension://${id}/popup.html`);
      await popup
        .getByRole("button", { name: "Reconnect to installed Jelly instance" })
        .click();
      await waitFor(() => chrome.bridge.profiles().length === 1);
      const peer = chrome.bridge.profiles()[0]!;
      expect(peer.desktopAvailable).toBe(false);
      expect(() => chrome.bridge.desktop(peer.id, peer.generation)).toThrow(
        "unavailable",
      );
      await expect(
        app.service.chromeShare.take(
          "fixture-owner",
          agent.id,
          peer.id,
          peer.generation,
        ),
      ).rejects.toThrow("unavailable");
      expect((app.service.chromeShare as any).process).toBeNull();
      expect(app.service.chromeShare.state().status).toBe("idle");
      expect(chrome.sharingDesktop).toBe(false);
      console.log(
        `PASS: two real X11 displays, Chrome only on ${displaySwitch} override; native host refuses capture/control of either display.`,
      );
    } finally {
      await overridden.close();
      await waitFor(() => chrome.bridge.profiles().length === 0);
    }
  }
  personal = await chromium.launchPersistentContext(profileDir, {
    executablePath:
      process.env.JELLY_EXTENSION_BROWSER_PATH ?? chromium.executablePath(),
    headless: false,
    viewport: { width: 1000, height: 700 },
    ignoreDefaultArgs: ["--disable-extensions"],
    env: { ...xenv, HOME: home, XDG_CONFIG_HOME: config, DISPLAY: display },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  const personalPid = Number(
    readlinkSync(join(profileDir, "SingletonLock")).match(/-(\d+)$/)![1],
  );
  personalIdentity = {
    pid: personalPid,
    start: processStart(personalPid).start!,
    exe: readlinkSync(`/proc/${personalPid}/exe`),
    profile: profileDir,
  };
  const worker =
    personal.serviceWorkers()[0] ??
    (await personal.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  await installHost(profileDir, config, id);
  const popup = await personal.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup
    .getByRole("button", { name: "Reconnect to installed Jelly instance" })
    .click();
  await waitFor(() => chrome.bridge.profiles().length === 1);
  const peer = chrome.bridge.profiles()[0]!;
  expect(peer.desktopAvailable).toBe(true);
  expect(chrome.bridge.desktop(peer.id, peer.generation)).toEqual({
    available: true,
    display,
    auth,
  });
  expect(JSON.stringify(peer)).not.toMatch(/Xauthority|DISPLAY|\/tmp\//);
  app.service.setConfig({
    chromeProfile: peer.id,
    chromeOrigins: ["https://example.com"],
  });
  const selected = app.store.browserSelection();
  const a = app.service.browsers
    .forRun(agent.id, "run-a", selected, agent.name)
    .get(agent.id);
  const other = app.service.createAgent({
    name: "Other",
    instructions: "Fixture",
    color: "#b5bafc",
  });
  const b = app.service.browsers
    .forRun(other.id, "run-b", selected, other.name)
    .get(other.id);
  // Production policy permits these disposable loopback test pages. No live
  // settings or production URL-validation bypass is introduced.
  const tasks = (chrome as any).tasks as Map<string, any>;
  for (const agentId of [agent.id, other.id])
    tasks.get(agentId).origins = [site.url.origin];
  await a.action("name", { name: "Human handoff" });
  await b.action("name", { name: "Other task" });
  for (const agentId of [agent.id, other.id]) {
    const task = tasks.get(agentId);
    const opened = (await chrome.bridge.call(
      peer.id,
      peer.generation,
      task.id,
      task.run,
      "open",
      { url: `${site.url.origin}/?agent=${agentId}` },
    )) as any;
    task.tabs.add(opened.pageId);
    task.active = opened.pageId;
  }
  const taskA = tasks.get(agent.id);
  const remote = personal
    .pages()
    .find((p) => p.url().includes(`agent=${agent.id}`))!;
  await remote
    .getByRole("heading", { name: "Connected Chrome human fixture" })
    .waitFor();
  const pidBefore = readlinkSync(join(profileDir, "SingletonLock"));
  await chrome.control(agent.id, "pause");
  // Focusing is a distinct, explicit request, never a side effect of sharing.
  await chrome.control(agent.id, "focus");
  await popup.close();
  app.service.emit(agent.id, null, "message", {
    role: "user",
    text: "Connected Chrome desktop fixture",
  });
  await page.goto(app.server.url.origin);
  await page.getByTitle(`${agent.name} · idle`).click();
  await openChromeViewer(page);
  await page
    .getByRole("heading", {
      name: "Take control of Connected Chrome",
      exact: true,
    })
    .waitFor();
  expect((app.service.chromeShare as any).process).toBeNull();
  expect(await page.locator(".chrome-share-screen canvas").count()).toBe(0);
  expect(
    await page.getByText(/Other windows, accounts, notifications/).count(),
  ).toBe(1);
  await page.getByRole("button", { name: "Take control" }).click();
  try {
    await page
      .getByText(/You control the full desktop/)
      .waitFor({ timeout: 20000 });
  } catch (e) {
    console.error(
      "Share fixture status:",
      app.service.chromeShare.state(),
      "alerts:",
      await page.getByRole("alert").allTextContents(),
    );
    throw e;
  }
  const sharing = app.service.chromeShare.state();
  expect(sharing.status).toBe("sharing");
  expect(chrome.state(other.id).task?.paused).toBe(true);
  await expect(a.action("snapshot")).rejects.toThrow("paused");
  await expect(b.action("snapshot")).rejects.toThrow("paused");
  expect(() =>
    chrome.allocate("new-agent", "new-run", selected, "New"),
  ).toThrow("paused");
  await expect(chrome.control(other.id, "resume")).rejects.toThrow("paused");
  await expect(
    chrome.bridge.call(
      peer.id,
      peer.generation,
      taskA.id,
      taskA.run,
      "screenshot",
      { tab: taskA.active },
    ),
  ).rejects.toThrow();
  // x11vnc has no TCP listener, including the separate LibVNCServer IPv6 port.
  const child = (app.service.chromeShare as any).process;
  const socketInodes = readdirSync(`/proc/${child.pid}/fd`).flatMap((fd) => {
    try {
      const target = readlinkSync(`/proc/${child.pid}/fd/${fd}`);
      return target.match(/^socket:\[(\d+)\]$/)?.[1] ?? [];
    } catch {
      return [];
    }
  });
  for (const proto of ["tcp", "tcp6"]) {
    const listeners = readFileSync(`/proc/net/${proto}`, "utf8")
      .split("\n")
      .filter((l) => l.trim().split(/\s+/)[3] === "0A");
    expect(
      listeners.some((l) => socketInodes.includes(l.trim().split(/\s+/)[9]!)),
    ).toBe(false);
  }
  // Actual full-desktop pixels, then actual RFB pointer and keyboard input.
  await page.waitForFunction(() => {
    const canvas = document.querySelector(
      ".chrome-share-screen canvas",
    ) as HTMLCanvasElement;
    if (!canvas?.width) return false;
    const d = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < d.length; i += 4)
      if (d[i] === 231 && d[i + 1] === 17 && d[i + 2] === 123) return true;
    return false;
  });
  const point = await page.evaluate(() => {
    const c = document.querySelector(
        ".chrome-share-screen canvas",
      ) as HTMLCanvasElement,
      r = c.getBoundingClientRect();
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let sx = 0,
      sy = 0,
      n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i] === 231 && d[i + 1] === 17 && d[i + 2] === 123) {
        sx += (i / 4) % c.width;
        sy += Math.floor(i / 4 / c.width);
        n++;
      }
    return {
      x: r.x + ((sx / n) * r.width) / c.width,
      y: r.y + ((sy / n) * r.height) / c.height,
    };
  });
  await page.mouse.click(point.x, point.y);
  await remote
    .getByRole("heading", { name: "Human VNC click received" })
    .waitFor();
  await page.keyboard.type("human-typed");
  await waitFor(
    async () =>
      (await remote.getByRole("textbox").inputValue()) === "human-typed",
  );
  const clipboardSentinel = "PRIVATE_OS_CLIPBOARD_MUST_NOT_EXPORT_8173";
  const clip = Bun.spawn(
    ["/usr/bin/xclip", "-quiet", "-selection", "clipboard"],
    {
      env: { ...xenv, DISPLAY: display },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  clip.stdin.write(clipboardSentinel);
  clip.stdin.end();
  await Bun.sleep(500);
  expect(Buffer.concat(frames).includes(Buffer.from(clipboardSentinel))).toBe(
    false,
  );
  expect(await page.getByRole("button", { name: /clipboard/i }).count()).toBe(
    0,
  );
  clip.kill();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const c = document
        .querySelector(".chrome-share-screen canvas")!
        .getBoundingClientRect(),
      v = document.querySelector(".chrome-share-screen")!.getBoundingClientRect();
    return (
      c.width <= v.width + 2 &&
      c.height <= v.height + 2 &&
      Math.abs(c.width / c.height - 1280 / 900) < 0.02
    );
  });
  expect(await page.getByRole("slider").count()).toBe(0);
  // A different cookie never sees this person's pixels or receives a ticket.
  const foreign = await viewerBrowser.newContext();
  const foreignPage = await foreign.newPage();
  await foreignPage.goto(app.server.url.origin);
  await foreignPage.getByTitle(`${agent.name} · idle`).click();
  await openChromeViewer(foreignPage);
  await foreignPage
    .getByText(/Private desktop share owned by another/)
    .waitFor();
  expect(await foreignPage.locator(".chrome-share-screen canvas").count()).toBe(0);
  const denied = await foreignPage.evaluate(async (generation) => {
    const { csrf } = await (await fetch("/api/control-session")).json();
    return (
      await fetch("/api/chrome/share/ticket", {
        method: "POST",
        headers: { "content-type": "application/json", "x-jelly-csrf": csrf },
        body: JSON.stringify({ generation }),
      })
    ).status;
  }, app.service.chromeShare.state().generation);
  expect(denied).toBe(403);
  await foreign.close();
  // Real held modifier AND pointer-button state must be drained before a new
  // viewer/automation is admitted. Queries below are disposable-fixture only.
  async function inputState() {
    const probe = Bun.spawn(
      [
        "/usr/bin/python3",
        "-c",
        `
import ctypes as c, os
x = c.CDLL('libX11.so.6')
x.XOpenDisplay.restype = c.c_void_p
x.XKeysymToKeycode.argtypes = [c.c_void_p, c.c_ulong]
x.XQueryKeymap.argtypes = [c.c_void_p, c.c_void_p]
x.XDefaultRootWindow.argtypes = [c.c_void_p]
x.XDefaultRootWindow.restype = c.c_ulong
x.XQueryPointer.argtypes = [c.c_void_p, c.c_ulong, c.POINTER(c.c_ulong), c.POINTER(c.c_ulong), c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_uint)]
d = x.XOpenDisplay(os.environ['DISPLAY'].encode())
k = x.XKeysymToKeycode(d, 0xffe1)
a = (c.c_ubyte * 32)(); x.XQueryKeymap(d, a)
r, child, mask = c.c_ulong(), c.c_ulong(), c.c_uint()
rx, ry, wx, wy = c.c_int(), c.c_int(), c.c_int(), c.c_int()
x.XQueryPointer(d, x.XDefaultRootWindow(d), c.byref(r), c.byref(child), c.byref(rx), c.byref(ry), c.byref(wx), c.byref(wy), c.byref(mask))
print(bool(a[k // 8] & (1 << (k % 8))), bool(mask.value & 256))`,
      ],
      { env: { ...xenv, DISPLAY: display }, stdout: "pipe", stderr: "ignore" },
    );
    const state = (await new Response(probe.stdout).text()).trim();
    expect(await probe.exited).toBe(0);
    return state;
  }
  await page.keyboard.down("Shift");
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await waitFor(async () => (await inputState()) === "True True");
  for (const close of [
    ...(app.service.chromeShare as any).connections,
  ] as (() => void)[])
    close();
  await page
    .getByText(/Desktop disconnected\. Browser tools remain paused/)
    .waitFor();
  expect(chrome.sharingDesktop).toBe(true);
  expect(chrome.state(agent.id).task?.paused).toBe(true);
  await waitFor(
    () => app.service.chromeShare.state().status === "disconnected",
  );
  expect(await inputState()).toBe("False False");
  await page.keyboard.up("Shift");
  await page.mouse.up();
  await page
    .getByRole("button", { name: "Reconnect desktop", exact: true })
    .click();
  await page.getByText(/You control the full desktop/).waitFor();
  // Escape must wait for a real handback, and keep the panel if it fails.
  const release = app.service.chromeShare.release.bind(app.service.chromeShare);
  app.service.chromeShare.release = async () => {
    throw new Error("Fixture handback failure");
  };
  await page.keyboard.press("Escape");
  await page.getByText(/Could not return control/).waitFor();
  expect(
    await page
      .getByRole("dialog", { name: "Connected Chrome desktop" })
      .count(),
  ).toBe(1);
  expect(chrome.sharingDesktop).toBe(true);
  app.service.chromeShare.release = release;
  // The failed request intentionally closed its viewer before the injected
  // rejection. Wait for that real network-loss drain before retrying handback.
  await waitFor(
    () => app.service.chromeShare.state().status === "disconnected",
  );
  const resume = chrome.resumeAfterShare.bind(chrome);
  chrome.resumeAfterShare = async (id) => {
    expect((app.service.chromeShare as any).process).toBeNull();
    expect((app.service.chromeShare as any).runtime).toBeNull();
    expect((app.service.chromeShare as any).connections.size).toBe(0);
    expect(await inputState()).toBe("False False");
    return resume(id);
  };
  await page.keyboard.press("Escape");
  await page
    .getByRole("dialog", { name: "Connected Chrome desktop" })
    .waitFor({ state: "detached" });
  expect(chrome.sharingDesktop).toBe(false);
  expect(chrome.state(agent.id).task?.pauseState).toBe("active");
  expect(chrome.state(other.id).task?.paused).toBe(true);
  expect(readlinkSync(join(profileDir, "SingletonLock"))).toBe(pidBefore);
  expect(
    (await personal.cookies(site.url.origin)).some(
      (c) => c.name === "sameProfile" && c.value === "preserved",
    ),
  ).toBe(true);
  expect(await remote.getByRole("textbox").inputValue()).toBe("human-typed");
  // A fresh sharing generation cannot be ended or ticketed by stale requests.
  await openChromeViewer(page);
  await page.getByRole("button", { name: "Take control" }).click();
  await page.getByText(/You control the full desktop/).waitFor();
  const stale = await page.evaluate(async (oldGeneration) => {
    const { csrf } = await (await fetch("/api/control-session")).json();
    const headers = {
      "content-type": "application/json",
      "x-jelly-csrf": csrf,
    };
    return Promise.all(
      ["ticket", "release"].map(
        async (operation) =>
          (
            await fetch(`/api/chrome/share/${operation}`, {
              method: "POST",
              headers,
              body: JSON.stringify({ generation: oldGeneration }),
            })
          ).status,
      ),
    );
  }, sharing.generation);
  expect(stale).toEqual([409, 409]);
  const newCanvas = (await page
    .locator(".chrome-share-screen canvas")
    .boundingBox())!;
  await page.mouse.click(
    newCanvas.x + newCanvas.width / 2,
    newCanvas.y + newCanvas.height - 20,
  );
  await page.keyboard.down("Shift");
  await page.mouse.down();
  await waitFor(async () => (await inputState()) === "True True");
  (app.service.chromeShare as any).process.kill("SIGKILL");
  // Deterministically cover cleanup after actual native-generation loss too.
  chrome.bridge.disconnect(peer.id);
  await waitFor(
    () => chrome.state(agent.id).task?.pauseState === "disconnected",
  );
  await waitFor(() => app.service.chromeShare.state().status === "failed");
  await page
    .getByRole("button", {
      name: "End failed share without viewing",
      exact: true,
    })
    .waitFor();
  expect(chrome.sharingDesktop).toBe(true);
  // Public paused means acknowledged human-safe state, and must stay false if
  // the real native peer disconnected. Assert authority revocation separately.
  const failedTask = tasks.get(agent.id);
  expect(failedTask.paused).toBe(true);
  expect(chrome.state(agent.id).task?.paused).toBe(!failedTask.lost);
  expect(app.service.chromeStatus(agent.id).task?.paused).toBe(false);
  await expect(a.action("snapshot")).rejects.toThrow("paused");
  expect(() =>
    chrome.allocate("blocked-new", "blocked-run", selected, "Blocked"),
  ).toThrow("paused");
  await expect(chrome.control(agent.id, "resume")).rejects.toThrow();
  const failedTicket = await page.evaluate(async (generation) => {
    const { csrf } = await (await fetch("/api/control-session")).json();
    return (
      await fetch("/api/chrome/share/ticket", {
        method: "POST",
        headers: { "content-type": "application/json", "x-jelly-csrf": csrf },
        body: JSON.stringify({ generation }),
      })
    ).status;
  }, app.service.chromeShare.state().generation);
  expect(failedTicket).toBe(409);
  await page
    .getByRole("button", {
      name: "End failed share without viewing",
      exact: true,
    })
    .click();
  await page
    .getByRole("heading", {
      name: "Take control of Connected Chrome",
      exact: true,
    })
    .waitFor();
  expect(await inputState()).toBe("False False");
  expect(tasks.get(agent.id).paused).toBe(true); // Cleanup never resumes an old task.
  expect(chrome.state(agent.id).task?.pauseState === "active").toBe(false);
  await page.keyboard.up("Shift");
  await page.mouse.up();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  // Real parent-death/restart proof: never kill a saved numeric PID. The child
  // shim's inherited lock must refuse cleanup while alive, then permit a new
  // authenticated cleanup-only orphan handback after kernel parent-death kill.
  const deadData = join(dir, "dead-parent-data"),
    orphanData = join(dir, "orphan-cleanup-data");
  mkdirSync(deadData);
  symlinkSync(resolve(".jelly/runtime"), join(deadData, "runtime"));
  const parentScript = `
    import { ChromeSessions } from ${JSON.stringify(resolve("src/server/chrome-sessions.ts"))};
    import { ChromeShare } from ${JSON.stringify(resolve("src/server/chrome-share.ts"))};
    const chrome = new ChromeSessions(${JSON.stringify(deadData)}, "parent-death-test");
    await chrome.bridge.ready;
    const profile = { id: crypto.randomUUID(), generation: crypto.randomUUID(), connected: true };
    chrome.bridge.profiles = () => [profile];
    chrome.bridge.desktop = () => ({ available: true, display: ${JSON.stringify(display)}, auth: ${JSON.stringify(auth)} });
    chrome.bridge.call = async () => ({ frozen: true });
    const share = new ChromeShare(chrome, ${JSON.stringify(deadData)}, async () => {});
    await share.take("owner", "agent", profile.id, profile.generation);
    console.log(JSON.stringify({ child: share.process.pid }));
    setInterval(() => {}, 1000);`;
  const parent = Bun.spawn([process.execPath, "-e", parentScript], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = parent.stdout.getReader();
  const ready = JSON.parse(
    new TextDecoder().decode((await output.read()).value),
  );
  output.releaseLock();
  const cleanupChrome = new ChromeSessions(orphanData, "orphan-cleanup-test");
  await cleanupChrome.bridge.ready;
  writeFileSync(
    join(cleanupChrome.bridge.directory, "desktop-share.json"),
    readFileSync(join(deadData, "chrome-bridge/desktop-share.json")),
    { mode: 0o600 },
  );
  const orphanShare = new ChromeShare(
    cleanupChrome,
    orphanData,
    async () => {},
  );
  try {
    expect(orphanShare.state("owner").owned).toBe(false);
    expect(() =>
      orphanShare.ticket("owner", orphanShare.state().generation),
    ).toThrow("private");
    await expect(
      orphanShare.release("new-owner", orphanShare.state().generation, true),
    ).rejects.toThrow("still alive");
    expect(cleanupChrome.sharingDesktop).toBe(true);
    parent.kill("SIGKILL");
    await parent.exited;
    await waitFor(() => {
      try {
        return (
          readFileSync(`/proc/${ready.child}/stat`, "utf8").split(" ")[2] ===
          "Z"
        );
      } catch {
        return true;
      }
    });
    const originalAuth = readFileSync(auth);
    writeFileSync(auth, "changed-authorization");
    await expect(
      orphanShare.release("new-owner", orphanShare.state().generation, true),
    ).rejects.toThrow("binding changed");
    expect(cleanupChrome.sharingDesktop).toBe(true);
    writeFileSync(auth, originalAuth);
    await orphanShare.release(
      "new-owner",
      orphanShare.state().generation,
      true,
    );
    expect(cleanupChrome.sharingDesktop).toBe(false);
    expect(orphanShare.state().status).toBe("idle");
  } finally {
    parent.kill("SIGKILL");
    await orphanShare.close();
    await cleanupChrome.close();
  }
  expect(errors).toEqual([]);
  assertionsPassed = true;
  console.log(
    "PASS: disposable Xvfb + existing headed Chrome + native attestation + x11vnc + noVNC; direct take, actual desktop pixels/input, all-task block, owner exclusion, no TCP/clipboard, mobile fit, disconnect/reconnect, failed Escape handback, confirmed VNC teardown before resume, stale epochs/process loss, real parent-death/orphan cleanup lock, unchanged Chrome PID/profile/cookies.",
  );
} catch (e) {
  console.error(
    "Share browser fixture failed:",
    (e as Error).stack?.slice(0, 2000) ?? (e as Error).message,
  );
  throw e;
} finally {
  let cleanupError: unknown;
  try {
    await closeFixtureBrowser(viewerBrowser, viewerIdentity);
  } catch (error) {
    cleanupError = error;
  }
  // End native messaging before asking the persistent browser to exit. A live
  // native port can keep Chrome's extension worker alive during Browser.close.
  try {
    await app.service.close();
  } catch (error) {
    cleanupError ??= error;
  }
  try {
    await closeFixtureBrowser(personal?.browser(), personalIdentity);
  } catch (error) {
    cleanupError ??= error;
  }
  // As in the managed viewport fixture, Bun can retain phantom WebSocket counts
  // after real VNC disconnects. Dispose services, initiate HTTP shutdown and
  // unref these fixture-only listeners rather than await that stop promise.
  void app.close().catch(() => {});
  for (const server of app.servers) server.unref();
  site.stop(true);
  xvfb.kill();
  decoyXvfb.kill();
  await Promise.all([xvfb.exited, decoyXvfb.exited]);
  rmSync(dir, { recursive: true, force: true });
  if (cleanupError) throw cleanupError;
  const httpStillOpen = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: fixtureHttpPort });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
  if (
    httpStillOpen ||
    (app.service.chromeShare as any).process ||
    (app.service.chromeShare as any).inputCleanupRequired
  )
    throw new Error("Disposable sharing resources were not revoked.");
  if (assertionsPassed) {
    console.log(
      "PASS: fixture browsers, VNC input process, X servers and HTTP listener are revoked.",
    );
    // Bun can retain phantom Playwright/WebSocket references after verified OS
    // teardown. Exit only after all assertions and independent cleanup proofs.
    process.exit(0);
  }
}
