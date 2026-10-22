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
import { spawnSync } from "node:child_process";
import { expect } from "bun:test";
import { startApp } from "./fixtures/app";
import { ChromeSessions } from "../src/server/chrome-sessions";
import { ChromeShare } from "../src/server/chrome-share";
import { openChromeViewer } from "./fixtures/chrome-viewer";
import { interventionTools } from "../src/server/agent-tools";

const capturePids = new Set<number>();
function expectNoCaptureShm(pid: number) {
  const [header, ...rows] = readFileSync("/proc/sysvipc/shm", "utf8").trim().split("\n");
  const creator = header!.trim().split(/\s+/).indexOf("cpid");
  expect(creator).toBeGreaterThanOrEqual(0);
  expect(rows.filter((row) => Number(row.trim().split(/\s+/)[creator]) === pid)).toEqual([]);
}
function trackCapture(pid: number) {
  capturePids.add(pid);
  expect(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")).toContain("-noshm");
  expectNoCaptureShm(pid);
}

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
  staticDir: process.env.JELLY_TEST_STATIC_DIR,
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
    onclick="document.querySelector('h1').textContent='Human VNC click received';document.querySelector('textarea').focus()">Human button</button>
  <textarea style="position:absolute;top:300px;left:100px" aria-label="Human text"></textarea>
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
  hasTouch: true,
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
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
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
      expect(chrome.humanState()).toBe(false);
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
  const oldBrowserTab = taskA.active;
  const remote = personal
    .pages()
    .find((p) => p.url().includes(`agent=${agent.id}`))!;
  await remote
    .getByRole("heading", { name: "Connected Chrome human fixture" })
    .waitFor();
  const pidBefore = readlinkSync(join(profileDir, "SingletonLock"));
  // Fixture-only focus chooses the test tab, not a local-machine UI control.
  await remote.bringToFront();
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
      name: "Use the computer",
      exact: true,
    })
    .waitFor();
  expect((app.service.chromeShare as any).process).toBeNull();
  expect(await page.locator(".chrome-share-screen canvas").count()).toBe(0);
  expect(
    await page.getByText(/Full computer access, including other windows and notifications/).count(),
  ).toBe(1);
  await page.getByRole("button", { name: "Take control" }).click();
  try {
    await page
      .getByText(/You’re using the computer/)
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
  expect(chrome.humanState()).toBe(true);
  expect(chrome.state(other.id).task?.paused).toBe(false);
  const originalSnapshot = await a.action("snapshot") as any;
  expect(originalSnapshot).toMatchObject({ humanUsing: true });
  const oldBrowserRef = originalSnapshot.elements.find((element: any) => element.tag === "textarea").ref;
  expect(await b.action("snapshot")).toMatchObject({ humanUsing: true });
  const newAgent = app.service.createAgent({ name: "New", instructions: "Fixture", color: "#b5bafc" });
  expect(() => chrome.allocate(newAgent.id, "new-run", selected, "New")).not.toThrow();
  // x11vnc has no TCP listener, including the separate LibVNCServer IPv6 port.
  const child = (app.service.chromeShare as any).process;
  trackCapture(child.pid);
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
  const buttonPoint = () => page.evaluate(() => {
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
  const point = await buttonPoint();
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
  // Explicit transfer is separate from the passive RFB sentinel above.
  await ui.grantPermissions(["clipboard-read", "clipboard-write"]);
  const unicode = "雪 café 🪼\nsecond line\n";
  await page.evaluate(async text => navigator.clipboard.writeText(text), unicode);
  await remote.getByRole("textbox").fill("");
  await page.locator(".chrome-share-screen canvas").focus();
  await page.keyboard.press("Control+v");
  await waitFor(async () => await remote.getByRole("textbox").inputValue() === unicode);
  // Exercise actual noVNC Mac Command -> Alt_L mapping, with Command still
  // held when the transfer ACK arrives (Linux Chromium needs a supplied paste event).
  await remote.getByRole("textbox").fill("");
  await remote.evaluate(() => {
    (window as any).clipboardKeys = [];
    document.addEventListener("keydown", event => (window as any).clipboardKeys.push({ key: event.key, alt: event.altKey, ctrl: event.ctrlKey }));
  });
  await page.evaluate(() => Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" }));
  await page.locator(".chrome-share-screen canvas").focus();
  await page.keyboard.down("Meta");
  await waitFor(() => remote.evaluate(() => (window as any).clipboardKeys.some((key: any) => key.key === "Alt" && key.alt)));
  await page.evaluate(text => {
    const data = new DataTransfer(); data.setData("text/plain", text);
    document.querySelector(".chrome-share-screen canvas")!.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data }));
  }, unicode);
  await waitFor(async () => await remote.getByRole("textbox").inputValue() === unicode);
  expect(await remote.evaluate(() => (window as any).clipboardKeys.some((key: any) => key.key.toLowerCase() === "v" && key.ctrl && !key.alt))).toBe(true);
  console.log("PASS: real noVNC Mac Command maps to remote Alt; Command held through clipboard ACK still produces Ctrl+V without Alt and pastes Unicode.");
  await page.keyboard.up("Meta");
  await page.evaluate(() => { delete (navigator as any).platform; });
  await page.getByRole("button", { name: "Copy from computer" }).click();
  await page.getByText("Copied to this device.", { exact: true }).waitFor();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(unicode);
  // Same manual experience as plain HTTP or clipboard permission denial.
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
  await page.getByRole("button", { name: "Paste to computer" }).click();
  await page.getByText(/Paste access is unavailable/).waitFor();
  await page.getByLabel("Text to computer", { exact: true }).fill(unicode);
  await page.getByRole("button", { name: "Send without pasting" }).click();
  await page.getByText(/Not pasted/).waitFor();
  expect(await remote.getByRole("textbox").inputValue()).toBe(unicode);
  await page.getByRole("button", { name: "Copy from computer" }).click();
  await page.getByLabel("Text from computer", { exact: true }).waitFor();
  expect(await page.getByLabel("Text from computer", { exact: true }).inputValue()).toBe(unicode);
  await remote.getByRole("textbox").fill("");
  await page.getByLabel("Text to computer", { exact: true }).fill(unicode);
  await page.getByRole("button", { name: "Send & paste" }).click();
  await waitFor(async () => await remote.getByRole("textbox").inputValue() === unicode);
  await page.getByRole("button", { name: "Send without pasting" }).click(); // empty draft is real empty text
  await page.getByText(/Not pasted/).waitFor();
  await page.getByRole("button", { name: "Copy from computer" }).click();
  await page.getByText(/contains empty text/).waitFor();
  expect(await page.getByLabel("Text from computer", { exact: true }).inputValue()).toBe("");
  await page.getByRole("button", { name: "Clear text", exact: true }).click();
  await page.getByRole("button", { name: "Text options" }).click();
  await remote.getByRole("textbox").fill("human-typed");
  clip.kill();
  await clip.exited;
  // Real noVNC scaling and input mapping at both edges, with the actual
  // 1280x900 desktop rather than the removed managed browser's fixed ratio.
  await remote.evaluate(() => {
    (window as any).panClicks = [];
    document.addEventListener("click", event => (window as any).panClicks.push(event.clientX));
  });
  const slider = page.getByRole("slider", { name: "Pan computer left and right" });
  const screen = page.locator(".chrome-share-screen");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await slider.waitFor();
    await page.waitForFunction(() => {
      const canvas = document.querySelector(".chrome-share-screen canvas")!.getBoundingClientRect();
      const viewport = document.querySelector(".chrome-share-screen")!.getBoundingClientRect();
      return Math.abs(canvas.height - viewport.height) < 2 && canvas.width > viewport.width;
    });
    for (const [key, sym] of [["Shift", 0xffe1], ["w", 0x77]] as const) {
      await page.locator(".chrome-share-screen canvas").focus();
      await page.keyboard.down(key);
      await waitFor(async () => (await inputState(false, sym)) === "True False");
      await slider.focus();
      await page.keyboard.up(key);
      await waitFor(async () => (await inputState(false, sym)) === "False False");
      // Returning to the canvas can press/release the same key normally:
      // neither the remote state nor noVNC's own key map may remain latched.
      await page.locator(".chrome-share-screen canvas").focus();
      await page.keyboard.down(key);
      await waitFor(async () => (await inputState(false, sym)) === "True False");
      await page.keyboard.up(key);
      await waitFor(async () => (await inputState(false, sym)) === "False False");
    }
    const keyCount = await remote.evaluate(() => (window as any).clipboardKeys.length);
    const clickCount = await remote.evaluate(() => (window as any).panClicks.length);
    const bounds = (await slider.boundingBox())!;
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(await page.locator(".chrome-share-pan > span").evaluate(label => getComputedStyle(label).whiteSpace)).toBe("nowrap");
    await slider.tap({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
    await waitFor(async () => Number(await slider.inputValue()) > 0);
    await slider.focus();
    await slider.press("End");
    await page.waitForFunction(() => {
      const canvas = document.querySelector(".chrome-share-screen canvas")!.getBoundingClientRect();
      const viewport = document.querySelector(".chrome-share-screen")!.getBoundingClientRect();
      return Math.abs(canvas.right - viewport.right) < 2;
    });
    expect(await remote.evaluate(() => (window as any).panClicks.length)).toBe(clickCount);
    expect(await remote.evaluate(() => (window as any).clipboardKeys.length)).toBe(keyCount);
    await screen.scrollIntoViewIfNeeded();
    let box = (await screen.boundingBox())!;
    await page.mouse.click(box.x + box.width - 30, box.y + box.height / 2);
    await waitFor(async () => Number((await inputState(true)).split(" ")[0]) > 1000);
    await slider.focus();
    await slider.press("Home");
    await page.waitForFunction(() => {
      const canvas = document.querySelector(".chrome-share-screen canvas")!.getBoundingClientRect();
      const viewport = document.querySelector(".chrome-share-screen")!.getBoundingClientRect();
      return Math.abs(canvas.left - viewport.left) < 2;
    });
    await screen.scrollIntoViewIfNeeded();
    box = (await screen.boundingBox())!;
    await page.mouse.click(box.x + 30, box.y + box.height / 2);
    await waitFor(async () => Number((await inputState(true)).split(" ")[0]) < 200);
    expect(await page.locator(".chrome-share-screen canvas").evaluate(canvas => ({
      width: (canvas as HTMLCanvasElement).width, height: (canvas as HTMLCanvasElement).height,
    }))).toEqual({ width: 1280, height: 900 });
    expect(await page.getByRole("button", { name: "Paste to computer" }).isEnabled()).toBe(true);
    const scene = (await screen.boundingBox())!;
    expect(scene.y).toBeLessThan(185);
    expect(scene.height).toBeGreaterThan(844 * 0.65);
    expect(scene.y + scene.height).toBeLessThanOrEqual(845);
    for (const name of ["Show keyboard", "Paste to computer", "Copy from computer", "Text options", "About computer control", "Done"]) {
      const button = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
      expect(button.width).toBeGreaterThanOrEqual(44);
      expect(button.height).toBeGreaterThanOrEqual(44);
      expect(button.x).toBeGreaterThanOrEqual(0);
      expect(button.x + button.width).toBeLessThanOrEqual(width);
    }
    await page.getByRole("button", { name: "About computer control" }).tap();
    await page.getByText(/Full computer access, including other windows/).waitFor();
    await page.getByRole("button", { name: "About computer control" }).tap();
    await page.getByText(/Full computer access, including other windows/).waitFor({ state: "hidden" });
    await remote.getByRole("textbox").fill("");
    await page.getByRole("button", { name: "Show keyboard" }).tap();
    const keyboard = page.getByRole("textbox", { name: "Remote keyboard input" });
    await page.getByRole("button", { name: "Hide keyboard" }).waitFor();
    expect(await keyboard.evaluate(input => input === document.activeElement)).toBe(true);
    await page.waitForFunction(() => document.querySelector(".chrome-share-screen canvas")!.getBoundingClientRect().height <= document.querySelector(".chrome-share-screen")!.getBoundingClientRect().height + 2);
    const remotePoint = await buttonPoint();
    await page.touchscreen.tap(remotePoint.x, remotePoint.y);
    expect(await keyboard.evaluate(input => input === document.activeElement)).toBe(true);
    await page.keyboard.type("Hi");
    await page.keyboard.insertText(" é雪🪼");
    await waitFor(async () => await remote.getByRole("textbox").inputValue() === "Hi é雪🪼");
    await keyboard.evaluate(input => {
      const field = input as HTMLTextAreaElement;
      field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      field.value = "\u200bni";
      field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, inputType: "insertCompositionText", data: "ni" }));
    });
    expect(await remote.getByRole("textbox").inputValue()).toBe("Hi é雪🪼");
    await keyboard.evaluate(input => {
      const field = input as HTMLTextAreaElement;
      field.value = "\u200b你";
      field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你" }));
      field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "你" }));
    });
    await waitFor(async () => await remote.getByRole("textbox").inputValue() === "Hi é雪🪼你");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await page.keyboard.type("ok");
    await page.getByRole("button", { name: "ArrowLeft", exact: true }).tap();
    await page.keyboard.type("!");
    await waitFor(async () => await remote.getByRole("textbox").inputValue() === "Hi é雪🪼\no!k");
    // Model visual-viewport changes from an OS keyboard. This is not physical
    // Safari/Android qualification; native input above is real X11/noVNC.
    const identityBeforeKeyboardResize = app.service.chromeShare.state().controlId;
    for (const visibleHeight of [360, 420, 480]) {
      await page.evaluate(height => {
        Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: height });
        window.visualViewport!.dispatchEvent(new Event("resize"));
      }, visibleHeight);
      await page.waitForFunction(height => {
        const box = document.querySelector(".chrome-share-screen")!.getBoundingClientRect();
        return box.height > 60 && box.bottom <= height + 2;
      }, visibleHeight);
    }
    await page.evaluate(() => {
      delete (window.visualViewport as any).height;
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    expect(app.service.chromeShare.state().controlId).toBe(identityBeforeKeyboardResize);
    await page.getByRole("button", { name: "Hide keyboard" }).tap();
    await page.getByRole("button", { name: "Show keyboard" }).waitFor();
    expect(await keyboard.inputValue()).toBe("");
    if (process.env.JELLY_TEST_SCREENSHOT_DIR) {
      await slider.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(process.env.JELLY_TEST_SCREENSHOT_DIR, `computer-pan-${width}.png`) });
    }
  }
  for (const [width, height] of [[844, 390], [1100, 1000]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await slider.waitFor({ state: "detached" });
    await page.waitForFunction(() => {
      const canvas = document.querySelector(".chrome-share-screen canvas")!.getBoundingClientRect();
      const viewport = document.querySelector(".chrome-share-screen")!.getBoundingClientRect();
      return canvas.width <= viewport.width + 2 && canvas.height <= viewport.height + 2;
    });
  }
  console.log("PASS: compact 390/320 controls leave over 65% screen height, 44px targets, explicit notice, keyboard-toggle focus retained through remote taps, Unicode/IME/Backspace/Enter/arrows and simulated soft-keyboard viewport resizing.");
  console.log("PASS: portrait 390/320 height-fill, held modifier/ordinary-key release on pan focus and reuse, touch/keyboard pan without remote input, both-edge native pointer mapping, unchanged framebuffer and landscape/desktop fit.");
  // The ordinary-key regression intentionally typed into the disposable field.
  // Restore the fixture sentinel for the subsequent reconnect-preservation check.
  await remote.getByRole("textbox").fill("human-typed");
  // A different cookie never sees this person's pixels or receives a ticket.
  const foreign = await viewerBrowser.newContext();
  const foreignPage = await foreign.newPage();
  await foreignPage.goto(app.server.url.origin);
  await foreignPage.getByTitle(`${agent.name} · idle`).click();
  await openChromeViewer(foreignPage);
  await foreignPage
    .getByText(/computer viewer is open in another control session/)
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
  const deniedClipboard = await foreignPage.evaluate(async identity => {
    const { csrf } = await (await fetch("/api/control-session")).json();
    return (await fetch("/api/chrome/share/clipboard/receive", { method: "POST",
      headers: { "content-type": "application/json", "x-jelly-csrf": csrf }, body: JSON.stringify(identity) })).status;
  }, { generation: app.service.chromeShare.state().generation, controlId: app.service.chromeShare.state().controlId });
  expect(deniedClipboard).toBe(403);
  await foreign.close();
  // Real held modifier AND pointer-button state must be drained before a new
  // viewer/automation is admitted. Queries below are disposable-fixture only.
  async function inputState(position = false, keysym = 0xffe1) {
    // This bounded read-only probe need not register asynchronous process pipes.
    // Bun's execFile epoll path can fail with EBADF after many fixture children.
    const probe = spawnSync(
        "/usr/bin/python3", [
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
k = x.XKeysymToKeycode(d, ${keysym})
a = (c.c_ubyte * 32)(); x.XQueryKeymap(d, a)
r, child, mask = c.c_ulong(), c.c_ulong(), c.c_uint()
rx, ry, wx, wy = c.c_int(), c.c_int(), c.c_int(), c.c_int()
x.XQueryPointer(d, x.XDefaultRootWindow(d), c.byref(r), c.byref(child), c.byref(rx), c.byref(ry), c.byref(wx), c.byref(wy), c.byref(mask))
print(rx.value, ry.value) if ${position ? "True" : "False"} else print(bool(a[k // 8] & (1 << (k % 8))), bool(mask.value & 256))`,
      ],
      { env: { ...xenv, DISPLAY: display }, timeout: 2000, maxBuffer: 1024, encoding: "utf8" },
    );
    if (probe.error || probe.status !== 0) throw new Error("Disposable held-input query failed.");
    return probe.stdout.trim();
  }
  async function holdViewerInputs() {
    // Mobile resize and reconnect change coordinates/focus. Never reuse the
    // earlier desktop click position for a held-input cleanup assertion.
    const box = await page.locator(".chrome-share-screen canvas").boundingBox();
    if (!box) throw new Error("Viewer canvas missing");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Shift");
    await page.mouse.down();
  }
  await holdViewerInputs();
  await waitFor(async () => (await inputState()) === "True True");
  for (const close of [
    ...(app.service.chromeShare as any).connections,
  ] as (() => void)[])
    close();
  await page
    .getByText(/Viewer disconnected/).first()
    .waitFor();
  expect(chrome.humanState()).toBe(true);
  expect(chrome.state(agent.id).task?.paused).toBe(false);
  await waitFor(
    () => app.service.chromeShare.state().status === "disconnected",
  );
  expect(await inputState()).toBe("False False");
  await page.keyboard.up("Shift");
  await page.mouse.up();
  await page
    .getByRole("button", { name: "Reconnect", exact: true })
    .click();
  await page.getByText(/You’re using the computer/).waitFor();
  // Closing stops local input and dismisses even if native cleanup needs repair.
  const share = app.service.chromeShare as any;
  trackCapture(share.process.pid);
  const stopCapture = share.stopCapture.bind(share);
  share.stopCapture = async () => { throw new Error("Fixture cleanup failure"); };
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Computer control" }).waitFor({ state: "detached" });
  expect(chrome.humanState()).toBe(false);
  expect(await a.action("snapshot")).toMatchObject({ humanUsing: false });
  share.stopCapture = stopCapture;
  await openChromeViewer(page);
  await page.getByRole("button", { name: "Retry cleanup", exact: true }).click();
  await page.getByRole("button", { name: "Take control", exact: true }).waitFor();
  expect(share.process).toBeNull();
  expect(share.runtime).toBeNull();
  expect(share.clipboard.children.size).toBe(0);
  expect(await inputState()).toBe("False False");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Computer control" }).waitFor({ state: "detached" });
  expect(chrome.state(other.id).task?.paused).toBe(false);
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
  await page.getByText(/You’re using the computer/).waitFor();
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
  await holdViewerInputs();
  await waitFor(async () => (await inputState()) === "True True");
  const killedCapture = (app.service.chromeShare as any).process;
  trackCapture(killedCapture.pid);
  killedCapture.kill("SIGKILL");
  // Deterministically cover cleanup after actual native-generation loss too.
  chrome.bridge.disconnect(peer.id);
  await waitFor(
    () => chrome.state(agent.id).task?.pauseState === "disconnected",
  );
  await waitFor(() => app.service.chromeShare.state().status === "failed");
  await page
    .getByRole("button", {
      name: "Retry cleanup",
      exact: true,
    })
    .waitFor();
  expect(chrome.humanState()).toBe(true);
  // Public paused means acknowledged human-safe state, and must stay false if
  // the real native peer disconnected. Assert authority revocation separately.
  const failedTask = tasks.get(agent.id);
  expect(failedTask.paused).toBe(true);
  expect(chrome.state(agent.id).task?.paused).toBe(!failedTask.lost);
  expect(app.service.chromeStatus(agent.id).task?.paused).toBe(false);
  await expect(a.action("snapshot")).rejects.toThrow("expired");
  expect(() =>
    chrome.allocate("blocked-new", "blocked-run", selected, "Blocked"),
  ).toThrow("disconnected");
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
      name: "Retry cleanup",
      exact: true,
    })
    .click();
  await page
    .getByRole("heading", {
      name: "Use the computer",
      exact: true,
    })
    .waitFor();
  expect(await inputState()).toBe("False False");
  expect(tasks.get(agent.id).paused).toBe(true); // Cleanup never resumes an old task.
  expect(chrome.state(agent.id).task?.pauseState === "active").toBe(false);
  await page.keyboard.up("Shift");
  await page.mouse.up();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();

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
  trackCapture(ready.child);
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
    expect(cleanupChrome.humanState()).toBe(false);
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
    expect(cleanupChrome.humanState()).toBe(false);
    writeFileSync(auth, originalAuth);
    await orphanShare.release(
      "new-owner",
      orphanShare.state().generation,
      true,
    );
    expect(cleanupChrome.humanState()).toBe(false);
    expect(orphanShare.state().status).toBe("idle");
  } finally {
    parent.kill("SIGKILL");
    await orphanShare.close();
    await cleanupChrome.close();
  }
  // The prior intentional profile disconnect is not repairable by an agent.
  await expect(a.reconnect!()).rejects.toThrow("has not reconnected");
  const reconnectPopup = await personal.newPage();
  await reconnectPopup.goto(`chrome-extension://${id}/popup.html`);
  await reconnectPopup.getByRole("button", { name: "Reconnect to installed Jelly instance" }).click();
  await waitFor(() => chrome.bridge.profiles().some(p => p.id === peer.id && p.generation !== peer.generation));
  await reconnectPopup.close();
  const recoveryTool = interventionTools(
    { get: requested => { if (requested !== agent.id) throw new Error("Foreign fixture agent"); return a; } },
    app.service.interventions, agent.id, "run-a", dir,
  ).find(tool => tool.name === "browser_reconnect")!;
  const recover = async () => {
    const result = await recoveryTool.execute("recover-fixture", {}, new AbortController().signal, undefined, {} as any);
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  const pagesBeforeRecovery = personal.pages().length;
  expect(await recover()).toMatchObject({ status: "reconnected" });
  expect(personal.pages()).toHaveLength(pagesBeforeRecovery);
  expect(chrome.state(agent.id).task).toMatchObject({ connected: true, active: null, tabs: [] });
  expect(chrome.state(other.id).task?.connected).toBe(false);
  await expect(a.action("tabs", { operation: "select", pageId: oldBrowserTab })).rejects.toThrow("Stale or foreign");
  await expect(a.action("open", { url: "https://not-approved.invalid/" })).rejects.toThrow("outside");
  const recovered = await a.action("open", { url: `${site.url.origin}/?recovered=explicit` }) as any;
  expect(recovered.pageId).not.toBe(oldBrowserTab);
  // browser_open acknowledges navigation dispatch, not document readiness.
  // Wait for this known disposable fixture to load before testing references.
  await waitFor(() => personal!.pages().some(p => p.url().includes("recovered=explicit")));
  const recoveredPage = personal.pages().find(p => p.url().includes("recovered=explicit"))!;
  await recoveredPage.getByRole("heading", { name: "Connected Chrome human fixture" }).waitFor();
  await a.action("snapshot");
  await expect(a.action("fill", { ref: oldBrowserRef, text: "MUST NOT APPEAR" })).rejects.toThrow("unavailable");
  const recoveredSnapshot = await a.action("snapshot") as any;
  await a.action("fill", { ref: recoveredSnapshot.elements.find((element: any) => element.tag === "textarea").ref, text: "fresh session input" });
  expect(await recoveredPage.getByRole("textbox").inputValue()).toBe("fresh session input");
  expect(remote.isClosed()).toBe(false);

  // Ordinary transport loss reconnects on the extension's real 30-second retry
  // alarm. No explicit popup action, timer override or automatic task renewal.
  const recoveredGeneration = chrome.bridge.profiles()[0]!.generation;
  (chrome.bridge as any).peers.get(peer.id).socket.destroy();
  await waitFor(() => chrome.state(agent.id).task?.connected === false);
  await expect(a.action("snapshot")).rejects.toThrow("browser_reconnect");
  await waitFor(() => chrome.bridge.profiles().some(p => p.id === peer.id && p.generation !== recoveredGeneration), 60000);
  await expect(a.action("snapshot")).rejects.toThrow("browser_reconnect");
  expect(await recover()).toMatchObject({ status: "reconnected" });
  await expect(a.action("tabs", { operation: "select", pageId: recovered.pageId })).rejects.toThrow("Stale or foreign");
  await a.action("open", { url: `${site.url.origin}/?recovered=automatic-transport` });
  await waitFor(() => personal!.pages().some(p => p.url().includes("recovered=automatic-transport")));
  await personal.pages().find(p => p.url().includes("recovered=automatic-transport"))!
    .getByRole("heading", { name: "Connected Chrome human fixture" }).waitFor();
  expect(JSON.stringify(await a.action("snapshot"))).toContain("Connected Chrome human fixture");
  expect(readlinkSync(join(profileDir, "SingletonLock"))).toBe(pidBefore);
  expect((await personal.cookies(site.url.origin)).some(c => c.name === "sameProfile" && c.value === "preserved")).toBe(true);
  console.log("PASS: browser_reconnect tool cannot clear intentional disconnect; after operator repair or ordinary transport auto-reconnect it creates only the caller's fresh session, preserves scope/profile/cookies, rejects old tabs/refs, and performs no action replay.");
  expect(errors).toEqual([]);
  for (const pid of capturePids) expectNoCaptureShm(pid);
  console.log("PASS: capture creates no System V shared-memory segments during viewing, reconnect, forced SIGKILL or real parent death; input-cleanup checks remain enforced.");
  assertionsPassed = true;
  console.log(
    "PASS: disposable Xvfb + existing headed Chrome + native attestation + x11vnc + noVNC; direct take, actual desktop pixels/input, advisory browser status, owner exclusion, no TCP/passive clipboard export, explicit Unicode/empty text clipboard and native paste, manual fallback, mobile fit, disconnect/reconnect, failed-cleanup dismissal and retry, confirmed native teardown, stale epochs/process loss, real parent-death/orphan cleanup lock, unchanged Chrome PID/profile/cookies.",
  );
} catch (e) {
  console.error(
    "Share browser fixture failed:",
    (e as Error).stack?.slice(0, 2000) ?? (e as Error).message,
    { status: app.service.chromeShare.state().status, error: app.service.chromeShare.state().error },
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
