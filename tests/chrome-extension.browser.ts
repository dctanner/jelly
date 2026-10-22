import { chromium, type BrowserContext } from "playwright-core";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "bun:test";
import { ChromeBridge } from "../src/server/chrome-bridge";
const dir = mkdtempSync(join(tmpdir(), "jelly-chrome-headed-"));
let deniedHits = 0;
let protectedHits = 0;
let socketHits = 0;
let assetHits = 0;
const protectedFixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    protectedHits++;
    return new Response("CONTROL MUST NOT BE REACHED");
  },
});
const denied = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    deniedHits++;
    return new Response("NOT APPROVED");
  },
});
const childFixture = Bun.serve({
  hostname: process.platform === "darwin" ? "localhost" : "127.0.0.2",
  port: 0,
  fetch: () =>
    new Response(
      "<h2>OOPIF child</h2><button onclick=\"document.querySelector('h2').textContent='OOPIF clicked'\">Child go</button>",
      { headers: { "Content-Type": "text/html" } },
    ),
});
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  websocket: { open(ws) { socketHits++; ws.send("local socket ready"); }, message() {} },
  fetch(req, server): Response | undefined {
    const path = new URL(req.url).pathname;
    if (path === "/socket" && server.upgrade(req)) return;
    if (path === "/local-asset.js") { assetHits++; return new Response("document.body.dataset.localAsset = 'yes'", { headers: { "Content-Type": "text/javascript" } }); }
    if (path === "/dotted-redirect") return Response.redirect(`http://LOCALHOST.:${fixture.port}/dotted-assets`);
    if (path === "/dotted-control") return Response.redirect(`http://LOCALHOST.:${protectedFixture.port}/control`);
    if (path === "/dotted-assets") return new Response(`<h1>Dotted approved</h1><script src="http://LOCALHOST.:${fixture.port}/local-asset.js"></script><img src="http://LOCALHOST.:${protectedFixture.port}/secret.png">`, { headers: { "Content-Type": "text/html" } });
    if (path === "/local-redirect") return Response.redirect(`${fixture.url.origin}/internet-assets`);
    if (path === "/internet-redirect")
      return Response.redirect(`${protectedFixture.url.origin}/control`);
    if (path === "/internet-assets")
      return new Response(
        `<h1>Internet assets</h1><script src="/local-asset.js"></script><script>new WebSocket('ws://${fixture.url.host}/socket'); new WebSocket('ws://${protectedFixture.url.host}/socket');</script><iframe src="${childFixture.url.origin}/"></iframe><img src="${protectedFixture.url.origin}/secret.png"><script src="${protectedFixture.url.origin}/secret.js"></script>`,
        { headers: { "Content-Type": "text/html" } },
      );
    if (path === "/redirect")
      return Response.redirect(`${denied.url.origin}/forbidden`);
    if (path === "/visibility")
      return new Response(
        `
        <h1>Visibility fixture</h1>
        <div id="transparent" style="opacity:0"><span>TRANSPARENT_SENTINEL</span><button>Transparent button</button></div>
        <div id="collapsed" style="height:0;overflow:hidden"><span>CLIPPED_SENTINEL</span><button>Clipped button</button></div>
        <div style="width:80px;overflow:hidden;white-space:nowrap"><span>Visible<span style="margin-left:200px">HORIZONTAL_SENTINEL</span></span></div>
        <div id="dynamic-opacity"><button onclick="document.body.dataset.clicked='yes'">Opacity action</button><input></div>
        <div id="dynamic-clip"><button onclick="document.body.dataset.clicked='yes'">Clip action</button><input></div>
      `,
        { headers: { "Content-Type": "text/html" } },
      );
    if (path === "/oopif")
      return new Response(
        `<h1>Cross-site frames</h1><iframe src="${childFixture.url.href}"></iframe>`,
        { headers: { "Content-Type": "text/html" } },
      );
    if (path === "/popup")
      return new Response(
        `<button onclick="window.open('/popup-child')">Popup go</button>`,
        { headers: { "Content-Type": "text/html" } },
      );
    if (path === "/options")
      return new Response(
        '<select><option value="one">One</option><option value="two">Two</option></select><button onclick="document.body.dataset.key=\'yes\'">Key go</button>',
        { headers: { "Content-Type": "text/html" } },
      );
    if (path === "/frame-secret")
      return new Response('<iframe src="/secret"></iframe>', {
        headers: { "Content-Type": "text/html" },
      });
    if (path === "/frame")
      return new Response('<iframe src="/child"></iframe>', {
        headers: { "Content-Type": "text/html" },
      });
    if (path === "/secret")
      return new Response('<input type="password" value="DO_NOT_OBSERVE">', {
        headers: { "Content-Type": "text/html" },
      });
    return new Response(
      "<h1>Local fixture</h1><input id=\"field\"><button onclick=\"document.querySelector('h1').textContent='Clicked fixture'\">Go</button>",
      { headers: { "Content-Type": "text/html" } },
    );
  },
});
let bridge = new ChromeBridge(join(dir, "data"), "headed-fixture");
let context: BrowserContext | undefined;
let secondContext: BrowserContext | undefined;
let secondBridge: ChromeBridge | undefined;
let xvfb: ReturnType<typeof Bun.spawn> | undefined;
async function command(args: string[], env = process.env) {
  const p = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  if (code)
    throw new Error(
      `Command failed: ${args[1]}: ${await new Response(p.stderr).text()}`,
    );
}
const delay = (ms = 100) => new Promise((r) => setTimeout(r, ms));
try {
  await bridge.ready;
  const extension = join(dir, "extension");
  await command(
    [process.execPath, "scripts/build-chrome-extension.ts", extension],
    process.env,
  );
  const home = join(dir, "home");
  mkdirSync(home);
  const config = join(home, ".config");
  mkdirSync(config);
  let display = process.env.DISPLAY;
  const xbin = existsSync("/usr/bin/Xvfb")
    ? "/usr/bin/Xvfb"
    : resolve(".jelly/runtime/usr/bin/Xvfb");
  if (existsSync(xbin)) {
    xvfb = Bun.spawn(
      [
        xbin,
        "-displayfd",
        "1",
        "-screen",
        "0",
        "1280x900x24",
        "-nolisten",
        "tcp",
      ],
      {
        env: {
          ...process.env,
          LD_LIBRARY_PATH: resolve(".jelly/runtime/usr/lib/x86_64-linux-gnu"),
        },
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    const reader = (xvfb.stdout as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    display = `:${new TextDecoder().decode(first.value).trim()}`;
    reader.releaseLock();
  }
  if (!display && process.platform !== "darwin")
    throw new Error(
      "Headed Chrome needs Xvfb or DISPLAY; no test was performed.",
    );
  const chrome =
    process.env.JELLY_EXTENSION_BROWSER_PATH ?? chromium.executablePath();
  console.log("Chrome fixture: launching headed disposable profile", display);
  context = await chromium.launchPersistentContext(join(dir, "profile"), {
    timeout: 30000,
    ignoreDefaultArgs: ["--disable-extensions"],
    executablePath: chrome,
    headless: false,
    viewport: { width: 800, height: 600 },
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: home,
      XDG_CONFIG_HOME: config,
      DISPLAY: display,
    },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  console.log("Chrome fixture: waiting for extension worker");
  let worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const id = new URL(worker.url()).host;
  expect(id).toBe("mikadpfmkipiafkemjplldmfckomphcf");
  for (const product of [
    "google-chrome",
    "chromium",
    "google-chrome-for-testing",
  ])
    await command([
      process.execPath,
      "scripts/install-chrome-host.ts",
      "--data-dir",
      join(dir, "data"),
      "--extension-id",
      id,
      "--chrome-config",
      join(config, product),
    ]);
  await command([
    process.execPath,
    "scripts/install-chrome-host.ts",
    "--data-dir",
    join(dir, "data"),
    "--extension-id",
    id,
    "--chrome-config",
    join(dir, "profile"),
  ]);
  console.log("Chrome fixture: host installed, waiting for automatic retry without popup");
  for (let i = 0; i < 450 && !bridge.profiles().length; i++) await delay();
  expect(bridge.profiles()).toHaveLength(1);
  let popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html#connect`);
  await popup.waitForURL(`chrome-extension://${id}/popup.html`);
  for (let i = 0; i < 100 && !bridge.profiles().length; i++) await delay();
  if (!bridge.profiles().length) {
    const diagnostic = await worker.evaluate(
      () =>
        new Promise((resolve) => {
          const p = (globalThis as any).chrome.runtime.connectNative(
            "org.jelly.browser",
          );
          p.onDisconnect.addListener(() =>
            resolve((globalThis as any).chrome.runtime.lastError?.message),
          );
          setTimeout(() => {
            p.disconnect();
            resolve("no disconnect");
          }, 3000);
        }),
    );
    throw new Error(
      `Native pairing failed: ${diagnostic}; ${await popup.locator("body").innerText()}`,
    );
  }
  const peer = bridge.profiles()[0]!;
  const session = crypto.randomUUID(),
    initialRun = crypto.randomUUID();
  let run = initialRun;
  const call = (
    method: Parameters<ChromeBridge["call"]>[4],
    params: Record<string, unknown> = {},
    sid = session,
  ) =>
    bridge
      .call(peer.id, peer.generation, sid, run, method, params)
      .catch((error) => {
        throw new Error(
          `Fixture ${method} (${JSON.stringify(params)}): ${error.message}`,
        );
      }) as Promise<any>;
  await call("begin", {
    name: "Headed fixture",
    origins: [fixture.url.origin, childFixture.url.origin],
    protected: [],
    agent: "persistent-agent-one",
  });
  await call("name", { name: "Fixture comparison" });
  const opened = await call("open", { url: fixture.url.href });
  // Check background creation before later explicit-human focus/close tests can
  // cause Chrome itself to select this tab as their active-tab replacement.
  const initiallyBackground = await worker.evaluate(async (url) =>
    (await (globalThis as any).chrome.tabs.query({})).find((t: any) => t.url === url || t.pendingUrl === url)?.active,
    fixture.url.href);
  expect(initiallyBackground).toBe(false);
  const tab = opened.pageId;
  let snapshot: any;
  for (let i = 0; i < 40; i++) {
    try {
      snapshot = await call("snapshot", { tab });
      break;
    } catch {
      await delay();
    }
  }
  expect(snapshot.text).toContain("Local fixture");
  const dottedSession = crypto.randomUUID();
  const dottedOrigin = `http://localhost:${fixture.port}`;
  const dottedControl = `http://localhost:${protectedFixture.port}`;
  await call("begin", { name: "Dotted approved", origins: [dottedOrigin], protected: [dottedControl] }, dottedSession);
  const assetsBefore = assetHits;
  const dotted = await call("open", { url: `http://LOCALHOST.:${fixture.port}/dotted-assets` }, dottedSession);
  for (let i = 0; i < 40 && assetHits === assetsBefore; i++) await delay();
  expect(assetHits).toBeGreaterThan(assetsBefore);
  expect((await call("snapshot", { tab: dotted.pageId }, dottedSession)).text).toContain("Dotted approved");
  await call("open", { tab: dotted.pageId, url: `${dottedOrigin}/dotted-redirect` }, dottedSession);
  for (let i = 0; i < 40 && assetHits < assetsBefore + 2; i++) await delay();
  expect(assetHits).toBeGreaterThan(assetsBefore + 1);
  expect((await call("snapshot", { tab: dotted.pageId }, dottedSession)).text).toContain("Dotted approved");
  await expect(call("open", { url: `http://LOCALHOST.:${protectedFixture.port}/control` }, dottedSession)).rejects.toThrow();
  await call("open", { tab: dotted.pageId, url: `${dottedOrigin}/dotted-control` }, dottedSession);
  await delay(300);
  expect(protectedHits).toBe(0);
  await call("end", { discard: true }, dottedSession);
  console.log("PASS: approved production policy accepts dotted navigation, redirect and script; dotted control navigation/redirect/assets denied.");
  // No origin allowlist in internet mode, including cross-site frames/assets.
  // Exact control-endpoint denies apply before navigation and subresource requests.
  const internetSession = crypto.randomUUID();
  await call(
    "begin",
    {
      name: "Internet fixture",
      origins: [],
      siteScope: "internet",
      protected: [protectedFixture.url.origin],
    },
    internetSession,
  );
  const unrestricted = await call(
    "open",
    { url: `${fixture.url.origin}/local-redirect` },
    internetSession,
  );
  let internetSnapshot: any;
  for (let i = 0; i < 40; i++) {
    try {
      internetSnapshot = await call(
        "snapshot",
        { tab: unrestricted.pageId },
        internetSession,
      );
      break;
    } catch {
      await delay();
    }
  }
  expect(internetSnapshot.text).toContain("Internet assets");
  expect(internetSnapshot.text).toContain("OOPIF child");
  for (let i = 0; i < 40 && (!socketHits || !assetHits); i++) await delay();
  expect(socketHits).toBeGreaterThan(0);
  expect(assetHits).toBeGreaterThan(0);
  expect(protectedHits).toBe(0);
  await expect(
    call("open", { url: protectedFixture.url.href }, internetSession),
  ).rejects.toThrow();
  await call(
    "open",
    { url: `${fixture.url.origin}/internet-redirect` },
    internetSession,
  );
  await delay(300);
  expect(protectedHits).toBe(0);
  const internetStatus = await popup.evaluate(() =>
    (globalThis as any).chrome.runtime.sendMessage({ action: "status" }),
  );
  expect(
    internetStatus.sessions.find((s: any) => s.id === internetSession)
      .siteScope,
  ).toBe("internet");
  await call("end", { discard: true }, internetSession);
  console.log("PASS: production local-address policy permits same-host different-port main frame, local redirect, cross-site frame, script and WebSocket; exact local control navigation/redirect/assets/WebSocket have zero hits.");
  // Private control survives run settlement for explicit and protective pauses.
  // Human input still works, while agent observation remains revoked.
  for (const mode of ["server", "debugger-conflict"]) {
    const takeover = crypto.randomUUID();
    const url = `${fixture.url.origin}/private-takeover-${mode}`;
    await call(
      "begin",
      { name: "Private takeover", origins: [fixture.url.origin], protected: [] },
      takeover,
    );
    const humanTab = await call("open", { url }, takeover);
    await call("focus", { tab: humanTab.pageId }, takeover);
    // Native tab-update acknowledgement can precede Playwright's page/URL event.
    for (let i = 0; i < 100 && !context.pages().some(p => p.url() === url); i++) await delay(25);
    const humanPage = context.pages().find((p) => p.url() === url)!;
    await humanPage.getByRole("heading", { name: "Local fixture" }).waitFor();
    if (mode === "server") await call("pause", {}, takeover);
    else {
      await worker.evaluate(async (url) => {
        const api = (globalThis as any).chrome;
        const id = (await api.tabs.query({})).find((t: any) => t.url === url).id;
        const original = api.debugger.attach.bind(api.debugger);
        const targets = api.debugger.getTargets.bind(api.debugger);
        (globalThis as any).restoreTakeoverAttach = () => {
          api.debugger.attach = original;
          api.debugger.getTargets = targets;
        };
        api.debugger.attach = async () => {
          throw new Error("Fixture debugger conflict");
        };
        // The fixture's inspection pipe attaches separately. Model confirmation
        // that the rejected Jelly attachment is gone, without detaching that pipe.
        api.debugger.getTargets = async () =>
          (await targets()).map((t: any) =>
            t.tabId === id ? { ...t, attached: false } : t,
          );
      }, url);
      try {
        await expect(
          call("screenshot", { tab: humanTab.pageId }, takeover),
        ).rejects.toThrow();
      } finally {
        await worker.evaluate(() => (globalThis as any).restoreTakeoverAttach());
      }
    }
    const paused = await popup.evaluate(() =>
      (globalThis as any).chrome.runtime.sendMessage({ action: "status" }),
    );
    expect(paused.sessions.find((s: any) => s.id === takeover)).toMatchObject({
      paused: true,
      failed: false,
    });
    await expect(
      call("snapshot", { tab: humanTab.pageId }, takeover),
    ).rejects.toThrow();
    expect(await call("end", {}, takeover)).toMatchObject({
      retained: [humanTab.pageId],
    });
    expect(humanPage.isClosed()).toBe(false);
    await humanPage.getByRole("button", { name: "Go", exact: true }).click();
    expect(await humanPage.locator("h1").innerText()).toBe("Clicked fixture");
    if (mode === "server") {
      await call(
        "begin",
        { name: "Private takeover", origins: [fixture.url.origin], protected: [] },
        takeover,
      );
      await call("resume", {}, takeover);
      const closed = humanPage.waitForEvent("close");
      expect(await call("end", {}, takeover)).toMatchObject({ retained: [] });
      await closed; // Explicit return of control restores temporary-tab cleanup.
    } else {
      // Closing the idle session releases control without closing the human's tab.
      await call("end", { discard: true }, takeover);
      expect(humanPage.isClosed()).toBe(false);
      await humanPage.close();
    }
  }
  console.log(
    "PASS: private pause preserves open tabs and human control after settlement",
  );
  const screenshot = await call("screenshot", { tab });
  expect(
    Buffer.from(screenshot.image, "base64").subarray(1, 4).toString(),
  ).toBe("PNG");
  // A rejected real debugger detach must not acknowledge private-safe pause.
  const pauseEvents: unknown[][] = [];
  bridge.onPauseState = (...args) => pauseEvents.push(args);
  await worker.evaluate(async (url) => {
    const api = (globalThis as any).chrome;
    const id = (await api.tabs.query({})).find((t: any) => t.url === url).id;
    const original = api.debugger.detach.bind(api.debugger);
    (globalThis as any).restoreReviewDetach = () => {
      api.debugger.detach = original;
    };
    (globalThis as any).reviewDetachId = id;
    api.debugger.detach = async (target: any) => {
      if (target.tabId === id) throw new Error("Fixture rejected detach");
      return original(target);
    };
  }, fixture.url.href);
  await expect(call("pause")).rejects.toThrow();
  let pauseStatus = await popup.evaluate(() =>
    (globalThis as any).chrome.runtime.sendMessage({ action: "status" }),
  );
  expect(pauseStatus.sessions[0]).toMatchObject({
    paused: false,
    pausing: false,
    failed: true,
  });
  expect(pauseEvents.some((e) => e.at(-1) === "failed")).toBe(true);
  expect(pauseEvents.some((e) => e.at(-1) === "paused")).toBe(false);
  await expect(call("resume")).rejects.toThrow();
  expect(
    await worker.evaluate(async () => {
      const api = (globalThis as any).chrome;
      const image = await api.debugger.sendCommand(
        { tabId: (globalThis as any).reviewDetachId },
        "Page.captureScreenshot",
        { format: "png" },
      );
      (globalThis as any).restoreReviewDetach();
      return image.data.length;
    }),
  ).toBeGreaterThan(0);
  await call("pause");
  pauseStatus = await popup.evaluate(() =>
    (globalThis as any).chrome.runtime.sendMessage({ action: "status" }),
  );
  expect(pauseStatus.sessions[0]).toMatchObject({
    paused: true,
    failed: false,
  });
  expect(
    await worker.evaluate(async () => {
      try {
        await (globalThis as any).chrome.debugger.sendCommand(
          { tabId: (globalThis as any).reviewDetachId },
          "Page.captureScreenshot",
        );
        return true;
      } catch {
        return false;
      }
    }),
  ).toBe(false);
  await call("resume");

  // Repeated human closure of the last idle retained tab must not consume the
  // extension's eight-session capacity. Server reset skips end for empty tasks.
  for (let i = 0; i < 10; i++) {
    const sid = crypto.randomUUID(),
      url = `${fixture.url.origin}/idle-leak-${i}`;
    await call(
      "begin",
      {
        name: "Retained reset fixture",
        origins: [fixture.url.origin],
        protected: [],
      },
      sid,
    );
    const retained = await call("open", { url }, sid);
    await call("mark", { tab: retained.pageId, mark: "handoff" }, sid);
    await call("end", {}, sid);
    await worker.evaluate(async (url) => {
      const api = (globalThis as any).chrome;
      const tab = (await api.tabs.query({})).find(
        (t: any) => t.url === url || t.pendingUrl === url,
      );
      await api.tabs.remove(tab.id);
    }, url);
    await delay(50);
    const state = await popup.evaluate(() =>
      (globalThis as any).chrome.runtime.sendMessage({ action: "status" }),
    );
    expect(state.sessions.some((s: any) => s.id === sid)).toBe(false);
  }
  // Regression: closed roots are invisible to element.shadowRoot, but their
  // pixels are in Page.captureScreenshot. Exercise the real isolated extension
  // guard, including a non-secret-looking filled field and contenteditable.
  const shadowPage = context.pages().find((p) => p.url() === fixture.url.href)!;
  await shadowPage.evaluate(() => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "svg-guard-fixture";
    svg.innerHTML =
      '<circle cx="10" cy="10" r="5"/><foreignObject width="300" height="80"><div xmlns="http://www.w3.org/1999/xhtml" id="svg-html-host">Visible SVG HTML</div></foreignObject>';
    document.body.append(svg);
  });
  expect((await call("snapshot", { tab })).text).toContain("Visible SVG HTML");
  expect(
    Buffer.from((await call("screenshot", { tab })).image, "base64")
      .subarray(1, 4)
      .toString(),
  ).toBe("PNG");
  await shadowPage.evaluate(() => {
    document
      .getElementById("svg-html-host")!
      .attachShadow({ mode: "closed" }).innerHTML =
      '<input autocomplete="current-password" value="SVG_CLOSED_ROOT_SECRET">';
  });
  await expect(call("snapshot", { tab })).rejects.toThrow();
  await expect(call("screenshot", { tab })).rejects.toThrow();
  await shadowPage.evaluate(() =>
    document.getElementById("svg-guard-fixture")!.remove(),
  );
  for (const content of [
    '<input type="text" autocomplete="current-password" value="CLOSED_ROOT_SECRET">',
    '<input type="text" value="CLOSED_ROOT_NONEMPTY">',
    "<div contenteditable>CLOSED_ROOT_EDITABLE</div>",
  ]) {
    await shadowPage.evaluate((html) => {
      const host = document.createElement("div");
      host.id = "closed-root-fixture";
      document.body.append(host);
      host.attachShadow({ mode: "closed" }).innerHTML = html;
      if (host.shadowRoot !== null) throw new Error("Expected closed root");
    }, content);
    await expect(call("screenshot", { tab })).rejects.toThrow();
    await expect(call("snapshot", { tab })).rejects.toThrow();
    await shadowPage.evaluate(() =>
      document.getElementById("closed-root-fixture")!.remove(),
    );
  }
  expect(
    Buffer.from((await call("screenshot", { tab })).image, "base64")
      .subarray(1, 4)
      .toString(),
  ).toBe("PNG");
  snapshot = await call("snapshot", { tab });
  await call("fill", {
    tab,
    ref: snapshot.elements.find((e: any) => e.tag === "input").ref,
    text: "harmless fixture",
  });
  await expect(call("screenshot", { tab })).rejects.toThrow();
  snapshot = await call("snapshot", { tab });
  expect(JSON.stringify(snapshot)).not.toContain("harmless fixture");
  const stale = snapshot.elements.find((e: any) => e.tag === "button").ref;
  await call("click", { tab, ref: stale });
  await expect(call("click", { tab, ref: stale })).rejects.toThrow();
  expect((await call("snapshot", { tab })).text).toContain("Clicked fixture");
  const other = crypto.randomUUID();
  await call(
    "begin",
    { name: "Other agent", origins: [fixture.url.origin], protected: [] },
    other,
  );
  await expect(call("snapshot", { tab }, other)).rejects.toThrow();
  // Human closure (not a Jelly close RPC) revokes the capability and the last group.
  const removals: unknown[][] = [];
  bridge.onTabRemoved = (...args) => removals.push(args);
  const humanTab = await call(
    "open",
    { url: `${fixture.url.origin}/human` },
    other,
  );
  await worker.evaluate(async (url: string) => {
    const api = (globalThis as any).chrome;
    const tabs = await api.tabs.query({});
    await api.tabs.remove(
      tabs.find((t: any) => t.url === url || t.pendingUrl === url).id,
    );
  }, `${fixture.url.origin}/human`);
  for (let i = 0; i < 50 && !removals.length; i++) await delay();
  expect(removals).toEqual([
    [peer.id, peer.generation, other, run, humanTab.pageId],
  ]);
  expect((await call("tabs", { operation: "list" }, other)).tabs).toEqual([]);
  const replacement = await call(
    "open",
    { url: `${fixture.url.origin}/replacement` },
    other,
  );
  expect(replacement.pageId).not.toBe(humanTab.pageId);
  await expect(
    call("snapshot", { tab: humanTab.pageId }, other),
  ).rejects.toThrow();
  expect((await call("tabs", { operation: "list" }, other)).tabs).toEqual([
    { pageId: replacement.pageId },
  ]);
  await delay(200);
  const parallel = await Promise.all([
    call("snapshot", { tab }),
    call("snapshot", { tab: replacement.pageId }, other),
  ]);
  expect(parallel[0].text).toContain("Clicked fixture");
  expect(parallel[1].text).toContain("Local fixture");
  await expect(
    call(
      "click",
      { tab: replacement.pageId, ref: parallel[0].elements[0].ref },
      other,
    ),
  ).rejects.toThrow();

  const visibility = await call("open", {
    url: `${fixture.url.origin}/visibility`,
  });
  let observed: any;
  for (let i = 0; i < 40; i++) {
    try {
      observed = await call("snapshot", { tab: visibility.pageId });
      break;
    } catch {
      await delay();
    }
  }
  expect(observed.text).toContain("Visibility fixture");
  for (const hidden of [
    "TRANSPARENT_SENTINEL",
    "CLIPPED_SENTINEL",
    "HORIZONTAL_SENTINEL",
    "Transparent button",
    "Clipped button",
  ])
    expect(JSON.stringify(observed)).not.toContain(hidden);
  expect(observed.elements.filter((e: any) => e.tag === "button")).toHaveLength(
    2,
  );
  expect(observed.elements.filter((e: any) => e.tag === "input")).toHaveLength(
    2,
  );
  const fixturePage = context
    .pages()
    .find((p) => p.url() === `${fixture.url.origin}/visibility`)!;
  for (const [id, label, style] of [
    ["dynamic-opacity", "Opacity action", "opacity:0"],
    ["dynamic-clip", "Clip action", "height:0;overflow:hidden"],
  ]) {
    observed = await call("snapshot", { tab: visibility.pageId });
    const ref = observed.elements.find((e: any) => e.label.includes(label)).ref;
    const input = observed.elements.find((e: any) => e.tag === "input").ref;
    await fixturePage.evaluate(
      ({ id, style }) =>
        document.getElementById(id!)!.setAttribute("style", style!),
      { id, style },
    );
    await expect(
      call("click", { tab: visibility.pageId, ref }),
    ).rejects.toThrow();
    await expect(
      call("fill", {
        tab: visibility.pageId,
        ref: input,
        text: "hidden write",
      }),
    ).rejects.toThrow();
    const hidden = await call("snapshot", { tab: visibility.pageId });
    expect(JSON.stringify(hidden)).not.toContain(label);
  }
  expect(
    await fixturePage.evaluate(() => document.body.dataset.clicked),
  ).toBeUndefined();
  expect(
    await fixturePage
      .locator("input")
      .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value)),
  ).toEqual(["", ""]);
  await call("tabs", { operation: "close", pageId: visibility.pageId });
  const browserTabs = await worker.evaluate(() =>
    (globalThis as any).chrome.tabs.query({}),
  );
  const taskTab = browserTabs.find((t: any) => t.url === fixture.url.href);
  expect(taskTab.groupId).toBeGreaterThanOrEqual(0);
  const group = await worker.evaluate(
    (groupId: number) => (globalThis as any).chrome.tabGroups.get(groupId),
    taskTab.groupId,
  );
  expect(group.title).toContain("Headed fixture");
  expect(group.title).toContain("Fixture comparison");
  // Deleting a group changes organization, not authority. Recreated groups keep color.
  await worker.evaluate(async (groupId: number) => {
    const api = (globalThis as any).chrome;
    await api.tabs.ungroup(
      (await api.tabs.query({ groupId })).map((t: any) => t.id),
    );
  }, taskTab.groupId);
  expect((await call("snapshot", { tab })).text).toContain("Clicked fixture");
  const regrouped = await call("open", {
    url: `${fixture.url.origin}/regrouped`,
  });
  const nextGroup = await worker.evaluate(async (url: string) => {
    const api = (globalThis as any).chrome;
    const t = (await api.tabs.query({})).find(
      (t: any) => t.url === url || t.pendingUrl === url,
    );
    return await api.tabGroups.get(t.groupId);
  }, `${fixture.url.origin}/regrouped`);
  expect(nextGroup.id).not.toBe(group.id);
  expect(nextGroup.color).toBe(group.color);
  await call("tabs", { operation: "close", pageId: regrouped.pageId });
  // Personal tabs cannot be granted; original groups and lifecycle remain untouched.
  const additions: unknown[][] = [];
  bridge.onTabAdded = (...args) => additions.push(args);
  const userPage = await context.newPage();
  await userPage.goto(`${fixture.url.origin}/user-owned`);
  const userInfo = await worker.evaluate(async (url: string) => {
    const api = (globalThis as any).chrome;
    const tab = (await api.tabs.query({})).find((t: any) => t.url === url);
    const groupId = await api.tabs.group({ tabIds: tab.id });
    await api.tabGroups.update(groupId, {
      title: "My original group",
      color: "green",
    });
    return { id: tab.id, groupId };
  }, userPage.url());
  await popup.reload();
  expect(await popup.locator("select, #grant").count()).toBe(0);
  const ungranted = await popup.evaluate(
    async ({ session, tab }) => {
      const api = (globalThis as any).chrome;
      return { grant: await api.runtime.sendMessage({ action: "grant", session, tab }),
        status: await api.runtime.sendMessage({ action: "status" }) };
    }, { session, tab: userInfo.id });
  expect(ungranted.grant).toEqual({ error: "Unavailable" });
  expect(ungranted.status).not.toHaveProperty("candidates");
  expect(additions).toHaveLength(0);
  expect(await worker.evaluate((id: number) => (globalThis as any).chrome.tabs.get(id), userInfo.id))
    .toMatchObject({ groupId: userInfo.groupId });
  expect(userPage.isClosed()).toBe(false);
  // Referenced select and semantic key actions, bounded waits and no shortcuts.
  const options = await call("open", { url: `${fixture.url.origin}/options` });
  await delay(250);
  let controls = await call("snapshot", { tab: options.pageId });
  await call("select", {
    tab: options.pageId,
    ref: controls.elements.find((e: any) => e.tag === "select").ref,
    value: "two",
  });
  controls = await call("snapshot", { tab: options.pageId });
  const keyRef = controls.elements.find((e: any) => e.tag === "button").ref;
  await call("key", { tab: options.pageId, ref: keyRef, key: "Enter" });
  const optionsPage = context
    .pages()
    .find((p) => p.url() === `${fixture.url.origin}/options`)!;
  expect(await optionsPage.locator("select").inputValue()).toBe("two");
  expect(await optionsPage.evaluate(() => document.body.dataset.key)).toBe(
    "yes",
  );
  expect(
    await call("wait_for", {
      tab: options.pageId,
      condition: "text",
      text: "Key go",
      timeoutMs: 500,
    }),
  ).toEqual({ ok: true });
  expect(
    await call("wait_for", {
      tab: options.pageId,
      condition: "text",
      text: "never present",
      timeoutMs: 100,
    }),
  ).toEqual({ ok: false, timedOut: true });
  const waiting = call("wait_for", {
    tab: options.pageId,
    condition: "text",
    text: "never present",
    timeoutMs: 10000,
  });
  void waiting.catch(() => {});
  await delay(100);
  await Promise.all([call("pause"), call("pause", {}, other)]);
  await expect(waiting).rejects.toThrow();
  await expect(
    call("key", { tab: options.pageId, ref: keyRef, key: "Enter" }),
  ).rejects.toThrow();
  await call("resume");
  await call("resume", {}, other);
  // Real queued renderer operations race local takeover. No stub delays in the
  // controller: a busy fixture renderer supplies the in-flight window.
  const racing = await call("open", { url: `${fixture.url.origin}/race` });
  await delay(200);
  const racingPage = context
    .pages()
    .find((p) => p.url() === `${fixture.url.origin}/race`)!;
  // Deterministically hold delivery of a REAL dispatched Chrome API response.
  // This is a drain/ack test, not a claim of atomic rendering or side-effect
  // cancellation: the admitted fill is allowed to complete before pause acks.
  for (const operation of ["screenshot", "fill"] as const) {
    await call("screenshot", { tab: racing.pageId }); // debugger already attached
    const refs = await call("snapshot", { tab: racing.pageId });
    expect(
      await worker.evaluate(async (url) => {
        const api = (globalThis as any).chrome;
        const tab = (await api.tabs.query({})).find((t: any) => t.url === url);
        return (await api.debugger.getTargets()).some(
          (t: any) => t.tabId === tab.id && t.attached,
        );
      }, racingPage.url()),
    ).toBe(true);
    await worker.evaluate((operation) => {
      const g = globalThis as any,
        api = g.chrome;
      const target = operation === "screenshot" ? api.debugger : api.scripting;
      const method =
        operation === "screenshot" ? "sendCommand" : "executeScript";
      const original = target[method];
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const hold = (g.fixtureDrain = {
        started: false,
        release,
        restore: () => {
          target[method] = original;
        },
      });
      target[method] = async (...args: any[]) => {
        const result = original.apply(target, args);
        if (
          (operation === "screenshot"
            ? args[1] === "Page.captureScreenshot"
            : args[0]?.args?.[0] === "fill") &&
          !hold.started
        ) {
          hold.started = true;
          const actual = await result;
          await gate;
          return actual;
        }
        return result;
      };
    }, operation);
    const pending = call(operation, {
      tab: racing.pageId,
      ...(operation === "fill"
        ? {
            ref: refs.elements.find((e: any) => e.tag === "input").ref,
            text: "admitted fill",
          }
        : {}),
    });
    const outcome = pending.then(
      () => "returned",
      () => "revoked",
    );
    let started = false;
    for (let i = 0; i < 50 && !started; i++) {
      started = await worker.evaluate(
        () => (globalThis as any).fixtureDrain.started,
      );
      if (!started) await delay(20);
    }
    expect(started).toBe(true);
    let acknowledged = false;
    const pause = call("pause").then(() => {
      acknowledged = true;
    });
    let draining: any;
    for (let i = 0; i < 50; i++) {
      draining = await popup.evaluate(() =>
        (globalThis as any).chrome.runtime.sendMessage({ action: "status" }),
      );
      if (draining.sessions.some((s: any) => s.pausing)) break;
      await delay(20);
    }
    expect(draining.sessions.some((s: any) => s.pausing && !s.paused)).toBe(
      true,
    );
    expect(acknowledged).toBe(false);
    await worker.evaluate(() => {
      const g = globalThis as any;
      g.fixtureDrain.release();
      g.fixtureDrain.restore();
      delete g.fixtureDrain;
    });
    await pause;
    expect(await outcome).toBe("revoked");
    expect(acknowledged).toBe(true);
    expect(
      await worker.evaluate(async (url) => {
        const api = (globalThis as any).chrome;
        const tab = (await api.tabs.query({})).find((t: any) => t.url === url);
        // Playwright's independent inspection pipe may still attach this target;
        // verify THIS extension can no longer issue a debugger command.
        return api.debugger
          .sendCommand({ tabId: tab.id }, "Page.getFrameTree")
          .then(
            () => true,
            () => false,
          );
      }, racingPage.url()),
    ).toBe(false);
    await racingPage.evaluate(() => {
      document.querySelector("input")!.value = "";
    });
    await call("resume");
  }
  for (const operation of [
    "snapshot",
    "screenshot",
    "fill",
    "click",
  ] as const) {
    const refs = await call("snapshot", { tab: racing.pageId });
    const blocked = racingPage.evaluate(() => {
      const until = Date.now() + 500;
      while (Date.now() < until) {}
    });
    await delay(20);
    const pending = call(operation, {
      tab: racing.pageId,
      ...(["fill", "click"].includes(operation)
        ? {
            ref: refs.elements.find(
              (e: any) => e.tag === (operation === "fill" ? "input" : "button"),
            ).ref,
          }
        : {}),
      ...(operation === "fill" ? { text: "race fixture" } : {}),
    });
    const outcome = pending.then(
      () => "completed-before-pause",
      () => "revoked",
    );
    await delay(20);
    // Await the actual native security pause acknowledgement, not just button dispatch.
    await Promise.all([call("pause"), call("pause", {}, other)]);
    const paused = await popup.evaluate(() =>
      (globalThis as any).chrome.runtime.sendMessage({ action: "status" }),
    );
    expect(paused.sessions.every((s: any) => s.paused)).toBe(true);
    await blocked;
    expect(await outcome).toBe("revoked");
    await expect(call("snapshot", { tab: racing.pageId })).rejects.toThrow();
    await expect(
      call("fill", {
        tab: racing.pageId,
        ref: refs.elements.find((e: any) => e.tag === "input").ref,
        text: "after pause",
      }),
    ).rejects.toThrow();
    await call("resume");
    await call("resume", {}, other);
  }
  await call("tabs", { operation: "close", pageId: racing.pageId });
  // Popup ownership is derived from an exclusively leased opener, never a group.
  const popupOpener = await call("open", {
    url: `${fixture.url.origin}/popup`,
  });
  await delay(250);
  controls = await call("snapshot", { tab: popupOpener.pageId });
  const prior = additions.length;
  await call("click", {
    tab: popupOpener.pageId,
    ref: controls.elements[0].ref,
  });
  for (let i = 0; i < 50 && additions.length === prior; i++) await delay();
  expect(additions.length).toBe(prior + 1);
  const popupCap = additions.at(-1)![4] as string;
  await delay(200);
  expect((await call("snapshot", { tab: popupCap })).text).toContain(
    "Local fixture",
  );
  await expect(call("snapshot", { tab: popupCap }, other)).rejects.toThrow();
  await call("tabs", { operation: "close", pageId: options.pageId });
  const retained = await call("open", {
    url: `${fixture.url.origin}/retained`,
  });
  await call("mark", { tab: retained.pageId, mark: "handoff" });
  const deliverable = await call("open", {
    url: `${fixture.url.origin}/deliverable`,
  });
  await call("mark", { tab: deliverable.pageId, mark: "deliverable" });
  await Promise.all([call("pause"), call("pause", {}, other)]);
  await expect(call("snapshot", { tab })).rejects.toThrow();
  await expect(call("screenshot", { tab })).rejects.toThrow();
  await call("resume");
  await expect(call("click", { tab, ref: stale })).rejects.toThrow();
  await call("open", { tab, url: `${fixture.url.origin}/frame` });
  await delay(300);
  let framed = await call("snapshot", { tab });
  expect(framed.frames).toHaveLength(2);
  const childButton = framed.elements.find((e: any) => e.tag === "button");
  await call("click", { tab, ref: childButton.ref });
  expect((await call("snapshot", { tab })).text).toContain("Clicked fixture");
  await call("open", { tab, url: `${fixture.url.origin}/oopif` });
  await delay(500);
  framed = await call("snapshot", { tab });
  expect(framed.text).toContain("OOPIF child");
  const frameInspector = await context.newCDPSession(popup);
  expect(
    (await frameInspector.send("Target.getTargets")).targetInfos.some(
      (t) => t.type === "iframe" && t.url === childFixture.url.href,
    ),
  ).toBe(true);
  await frameInspector.detach();
  expect(
    Buffer.from((await call("screenshot", { tab })).image, "base64")
      .subarray(1, 4)
      .toString(),
  ).toBe("PNG");
  const oopifPage = context
    .pages()
    .find((p) => p.url() === `${fixture.url.origin}/oopif`)!;
  const oopif = oopifPage
    .frames()
    .find((f) => f.url() === childFixture.url.href)!;
  for (const secret of [true, false]) {
    await oopif.evaluate((secret) => {
      const host = document.createElement("div");
      host.id = "closed-child-root";
      document.body.append(host);
      const input = document.createElement("input");
      input.value = "CLOSED_CHILD_NONEMPTY";
      if (secret) input.autocomplete = "current-password";
      host.attachShadow({ mode: "closed" }).append(input);
    }, secret);
    await expect(call("screenshot", { tab })).rejects.toThrow();
    await oopif.evaluate(() =>
      document.getElementById("closed-child-root")!.remove(),
    );
  }
  framed = await call("snapshot", { tab });
  await call("click", {
    tab,
    ref: framed.elements.find((e: any) => e.label.trim() === "Child go").ref,
  });
  expect((await call("snapshot", { tab })).text).toContain("OOPIF clicked");
  // The other agent has no grant for the cross-site child's origin.
  await call("resume", {}, other);
  await call(
    "open",
    { tab: replacement.pageId, url: `${fixture.url.origin}/oopif` },
    other,
  );
  await delay(300);
  await expect(
    call("snapshot", { tab: replacement.pageId }, other),
  ).rejects.toThrow();
  await call("resume", {}, other);
  await call("open", { tab, url: `${fixture.url.origin}/frame-secret` });
  await delay(300);
  await expect(call("snapshot", { tab })).rejects.toThrow();
  await expect(call("screenshot", { tab })).rejects.toThrow();
  await call("open", { tab, url: `${fixture.url.origin}/secret` });
  await delay(300);
  await expect(call("snapshot", { tab })).rejects.toThrow();
  await expect(call("screenshot", { tab })).rejects.toThrow();
  await call("open", { tab, url: `${fixture.url.origin}/redirect` });
  await delay(300);
  const info = await worker.evaluate(
    (tabId: number) => (globalThis as any).chrome.tabs.get(tabId),
    taskTab.id,
  );
  expect(deniedHits).toBe(0);
  expect(info.url).not.toBe(fixture.url.href);
  await expect(call("snapshot", { tab })).rejects.toThrow();
  expect(await call("end")).toMatchObject({ retained: [retained.pageId] });
  await call("end", {}, other);
  await expect(call("snapshot", { tab: retained.pageId })).rejects.toThrow();
  const oldRun = run;
  run = crypto.randomUUID();
  await call("begin", {
    name: "Headed fixture",
    agent: "persistent-agent-one",
    origins: [fixture.url.origin, childFixture.url.origin],
    protected: [],
  });
  await expect(call("snapshot", { tab: retained.pageId })).rejects.toThrow();
  await expect(
    bridge.call(peer.id, peer.generation, session, oldRun, "resume", {}),
  ).rejects.toThrow();
  await call("resume");
  expect((await call("snapshot", { tab: retained.pageId })).text).toContain(
    "Local fixture",
  );
  await call("end", { discard: true });
  expect(userPage.isClosed()).toBe(false);
  expect(
    await worker.evaluate(
      (id: number) => (globalThis as any).chrome.tabs.get(id),
      userInfo.id,
    ),
  ).toMatchObject({ groupId: userInfo.groupId });
  const localTakeover = crypto.randomUUID();
  await call(
    "begin",
    { name: "Local takeover", origins: [fixture.url.origin], protected: [] },
    localTakeover,
  );
  const takeoverTab = await call(
    "open",
    { url: `${fixture.url.origin}/takeover` },
    localTakeover,
  );
  await call("pause", {}, localTakeover);
  expect(await call("end", {}, localTakeover)).toMatchObject({
    retained: [takeoverTab.pageId],
  });
  await call("end", { discard: true }, localTakeover);
  const remaining = await worker.evaluate(() =>
    (globalThis as any).chrome.tabs.query({}),
  );
  expect(
    remaining.some(
      (t: any) =>
        t.url === `${fixture.url.origin}/takeover` ||
        t.pendingUrl === `${fixture.url.origin}/takeover`,
    ),
  ).toBe(true);
  expect(remaining.some((t: any) => t.id === taskTab.id)).toBe(false);
  expect(
    remaining.some((t: any) => t.url === `${fixture.url.origin}/deliverable`),
  ).toBe(true);
  await expect(call("snapshot", { tab: deliverable.pageId })).rejects.toThrow();
  expect(
    await worker.evaluate(() =>
      (globalThis as any).chrome.declarativeNetRequest.getSessionRules(),
    ),
  ).toHaveLength(0);
  // Two real profiles, two Jelly native instances, simultaneous transport.
  secondBridge = new ChromeBridge(join(dir, "data-two"), "headed-instance-two");
  await secondBridge.ready;
  const homeTwo = join(dir, "home-two"),
    configTwo = join(homeTwo, ".config");
  mkdirSync(configTwo, { recursive: true });
  for (const product of [
    "google-chrome",
    "chromium",
    "google-chrome-for-testing",
  ])
    await command([
      process.execPath,
      "scripts/install-chrome-host.ts",
      "--data-dir",
      join(dir, "data-two"),
      "--chrome-config",
      join(configTwo, product),
    ]);
  await command([
    process.execPath,
    "scripts/install-chrome-host.ts",
    "--data-dir",
    join(dir, "data-two"),
    "--chrome-config",
    join(dir, "profile-two"),
  ]);
  secondContext = await chromium.launchPersistentContext(
    join(dir, "profile-two"),
    {
      executablePath: chrome,
      headless: false,
      ignoreDefaultArgs: ["--disable-extensions"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C.UTF-8",
        HOME: homeTwo,
        XDG_CONFIG_HOME: configTwo,
        DISPLAY: display,
      },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
    },
  );
  const secondPopup = await secondContext.newPage();
  await secondPopup.goto(`chrome-extension://${id}/popup.html`);
  await secondPopup
    .getByRole("button", { name: "Reconnect to installed Jelly instance" })
    .click();
  for (let i = 0; i < 100 && !secondBridge.profiles().length; i++)
    await delay();
  const peerTwo = secondBridge.profiles()[0]!;
  expect(peerTwo.id).not.toBe(peer.id);
  expect(bridge.profiles()).toHaveLength(1);
  await expect(
    secondBridge.call(peer.id, peer.generation, session, run, "snapshot", {
      tab,
    }),
  ).rejects.toThrow("disconnected");
  const secondSession = crypto.randomUUID();
  await secondBridge.call(
    peerTwo.id,
    peerTwo.generation,
    secondSession,
    run,
    "begin",
    { name: "Second instance", origins: [fixture.url.origin], protected: [] },
  );
  await call("begin", {
    name: "Restart task",
    agent: "persistent-agent-one",
    origins: [fixture.url.origin],
    protected: [],
  });
  const restartTab = await call("open", { url: fixture.url.href });
  const secondTab = (await secondBridge.call(
    peerTwo.id,
    peerTwo.generation,
    secondSession,
    run,
    "open",
    { url: fixture.url.href },
  )) as any;
  await delay(250);
  const crossInstance = await Promise.all([
    call("snapshot", { tab: restartTab.pageId }),
    secondBridge.call(
      peerTwo.id,
      peerTwo.generation,
      secondSession,
      run,
      "snapshot",
      { tab: secondTab.pageId },
    ) as Promise<any>,
  ]);
  expect(crossInstance.every((s) => s.text.includes("Local fixture"))).toBe(
    true,
  );
  await expect(
    secondBridge.call(
      peerTwo.id,
      peerTwo.generation,
      secondSession,
      run,
      "snapshot",
      { tab: restartTab.pageId },
    ),
  ).rejects.toThrow();
  await secondBridge.call(
    peerTwo.id,
    peerTwo.generation,
    secondSession,
    run,
    "end",
    {},
  );
  expect(secondTab.pageId).not.toBe(retained.pageId);
  // Real native-host version mismatch is rejected without affecting the live port.
  expect(
    await worker.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const p = (globalThis as any).chrome.runtime.connectNative(
            "org.jelly.browser",
          );
          p.onDisconnect.addListener(() => {
            void (globalThis as any).chrome.runtime.lastError;
            resolve(true);
          });
          p.postMessage({ type: "hello", version: 999 });
        }),
    ),
  ).toBe(true);
  expect(bridge.profiles()).toHaveLength(1);
  // Terminate the real extension worker target; waking it must not restore authority.
  const inspector = await context.newCDPSession(popup);
  const targets = await inspector.send("Target.getTargets");
  const workerTarget = targets.targetInfos.find(
    (t) => t.type === "service_worker" && t.url === worker.url(),
  )!;
  await inspector.send("Target.closeTarget", {
    targetId: workerTarget.targetId,
  });
  for (let i = 0; i < 50 && bridge.profiles().length; i++) await delay();
  expect(bridge.profiles()).toHaveLength(0);
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  worker = context.serviceWorkers().find((w) => w.url().includes(id))!;
  await popup
    .getByRole("button", { name: "Reconnect to installed Jelly instance" })
    .click();
  for (let i = 0; i < 100 && !bridge.profiles().length; i++) await delay();
  expect(bridge.profiles()[0]?.id).toBe(peer.id);
  expect(bridge.profiles()[0]?.generation).not.toBe(peer.generation);
  await expect(call("snapshot", { tab: restartTab.pageId })).rejects.toThrow(
    "disconnected",
  );
  expect(
    (
      await worker.evaluate(() => (globalThis as any).chrome.tabs.query({}))
    ).some((t: any) => t.url === fixture.url.href),
  ).toBe(true);
  const beforeServerRestart = bridge.profiles()[0]!;
  const serverRestartSession = crypto.randomUUID();
  await bridge.call(
    beforeServerRestart.id,
    beforeServerRestart.generation,
    serverRestartSession,
    run,
    "begin",
    { name: "Server restart", origins: [fixture.url.origin], protected: [] },
  );
  const serverRestartTab = (await bridge.call(
    beforeServerRestart.id,
    beforeServerRestart.generation,
    serverRestartSession,
    run,
    "open",
    { url: `${fixture.url.origin}/server-restart` },
  )) as any;
  await bridge.close();
  bridge = new ChromeBridge(join(dir, "data"), "headed-fixture");
  await bridge.ready;
  for (let i = 0; i < 450 && !bridge.profiles().length; i++) await delay();
  const afterServerRestart = bridge.profiles()[0]!;
  expect(afterServerRestart.id).toBe(beforeServerRestart.id);
  expect(afterServerRestart.generation).not.toBe(
    beforeServerRestart.generation,
  );
  await expect(
    bridge.call(
      beforeServerRestart.id,
      beforeServerRestart.generation,
      serverRestartSession,
      run,
      "snapshot",
      { tab: serverRestartTab.pageId },
    ),
  ).rejects.toThrow("disconnected");
  await expect(
    bridge.call(
      afterServerRestart.id,
      afterServerRestart.generation,
      serverRestartSession,
      run,
      "snapshot",
      { tab: serverRestartTab.pageId },
    ),
  ).rejects.toThrow();
  // Uncertain debugger cleanup survives revoked authority and worker recreation.
  // Reconnect must not pair while detach still fails, or forget the attachment
  // when an old tab is explicitly re-granted to an entirely new session.
  const cleanupSession = crypto.randomUUID();
  const cleanupURL = `${fixture.url.origin}/unresolved-debugger`;
  const cleanupCall = (
    method: Parameters<ChromeBridge["call"]>[4],
    params = {},
  ) =>
    bridge.call(
      afterServerRestart.id,
      afterServerRestart.generation,
      cleanupSession,
      run,
      method,
      params,
    ) as Promise<any>;
  await cleanupCall("begin", {
    name: "Cleanup obligation",
    origins: [fixture.url.origin],
    protected: [],
  });
  const cleanupTab = await cleanupCall("open", { url: cleanupURL });
  for (let i = 0; i < 40; i++) {
    try {
      await cleanupCall("snapshot", { tab: cleanupTab.pageId });
      break;
    } catch {
      await delay();
    }
  }
  await cleanupCall("screenshot", { tab: cleanupTab.pageId });
  const cleanupNativeId = await worker.evaluate(async (url) => {
    const api = (globalThis as any).chrome;
    const id = (await api.tabs.query({})).find((t: any) => t.url === url).id;
    const original = api.debugger.detach.bind(api.debugger);
    (globalThis as any).restoreCleanupDetach = () => {
      api.debugger.detach = original;
    };
    api.debugger.detach = async (target: any) => {
      if (target.tabId === id) throw new Error("Fixture unresolved detach");
      return original(target);
    };
    const stored = await api.storage.session.get("debuggerCleanup");
    if (!stored.debuggerCleanup.includes(id))
      throw new Error("Cleanup was not persisted before attach");
    return id;
  }, cleanupURL);
  await popup.evaluate(() =>
    (globalThis as any).chrome.runtime.sendMessage({ action: "disconnect" }),
  );
  for (let i = 0; i < 50 && bridge.profiles().length; i++) await delay();
  expect(bridge.profiles()).toHaveLength(0);
  const refused = await popup.evaluate(() =>
    (globalThis as any).chrome.runtime.sendMessage({ action: "connect" }),
  );
  expect(refused.connectionError).toBe("cleanup-required");
  expect(bridge.profiles()).toHaveLength(0);
  const orphaned = await popup.evaluate(() =>
    (globalThis as any).chrome.runtime.sendMessage({ action: "status" }),
  );
  expect(orphaned).toMatchObject({
    connected: false,
    unresolvedDebuggerCleanup: 1,
    sessions: [],
  });
  // Restoration does not itself detach. Recreate the worker to verify that the
  // cleanup-only metadata, not its in-memory maps, protects the next connection.
  await worker.evaluate(() => (globalThis as any).restoreCleanupDetach());
  const cleanupInspector = await context.newCDPSession(popup);
  const cleanupTargets = await cleanupInspector.send("Target.getTargets");
  await cleanupInspector.send("Target.closeTarget", {
    targetId: cleanupTargets.targetInfos.find(
      (t) => t.type === "service_worker" && t.url === worker.url(),
    )!.targetId,
  });
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  worker = context.serviceWorkers().find((w) => w.url().includes(id))!;
  await popup.evaluate(() =>
    (globalThis as any).chrome.runtime.sendMessage({ action: "connect" }),
  );
  for (let i = 0; i < 100 && !bridge.profiles().length; i++) await delay();
  const cleanedPeer = bridge.profiles()[0]!;
  expect(cleanedPeer.generation).not.toBe(afterServerRestart.generation);
  const canReadWithOldDebugger = () =>
    worker.evaluate(async (tabId) => {
      try {
        await (globalThis as any).chrome.debugger.sendCommand(
          { tabId },
          "Page.getFrameTree",
        );
        return true;
      } catch {
        return false;
      }
    }, cleanupNativeId);
  expect(await canReadWithOldDebugger()).toBe(false);
  expect(
    await worker.evaluate(
      async () =>
        (
          await (globalThis as any).chrome.storage.session.get(
            "debuggerCleanup",
          )
        ).debuggerCleanup,
    ),
  ).toEqual([]);
  const regrantSession = crypto.randomUUID();
  await bridge.call(
    cleanedPeer.id,
    cleanedPeer.generation,
    regrantSession,
    run,
    "begin",
    {
      name: "Fresh explicit grant",
      origins: [fixture.url.origin],
      protected: [],
    },
  );
  const regranted = await popup.evaluate(
    ({ session, tab }) =>
      (globalThis as any).chrome.runtime.sendMessage({
        action: "grant",
        session,
        tab,
      }),
    { session: regrantSession, tab: cleanupNativeId },
  );
  expect(regranted).toEqual({ error: "Unavailable" });
  const newCaps = (await bridge.call(
    cleanedPeer.id,
    cleanedPeer.generation,
    regrantSession,
    run,
    "tabs",
    { operation: "list" },
  )) as any;
  expect(newCaps.tabs).toEqual([]);
  await bridge.call(
    cleanedPeer.id,
    cleanedPeer.generation,
    regrantSession,
    run,
    "pause",
    {},
  );
  const truthfulPause = await popup.evaluate(() =>
    (globalThis as any).chrome.runtime.sendMessage({ action: "status" }),
  );
  expect(truthfulPause.sessions[0]).toMatchObject({
    paused: true,
    failed: false,
  });
  expect(await canReadWithOldDebugger()).toBe(false);
  await popup.getByRole("button", { name: "Disconnect", exact: true }).click();
  await delay();
  expect(bridge.profiles()).toHaveLength(0);
  await popup.reload();
  await delay(250);
  expect(bridge.profiles()).toHaveLength(0); // The one-shot launch fragment was consumed.
  console.log(
    "PASS: headed disposable Chrome + real native host/socket: two agents, two profiles/instances, rejected personal-tab grant with preserved original group, task naming, background groups, exact fill/click/select/key, bounded waits interrupted by native security pause, same-process/OOPIF observations/actions, popup adoption, retained follow-up handoff, hidden/secret/closed-root suppression (main and OOPIF), delayed real capture/fill drain acknowledgement and debugger detach, stale/foreign caps, zero-hit denied redirect, cleanup, native version mismatch, worker termination/native bridge restart/generation revocation, disconnect.",
  );
} finally {
  await Promise.race([context?.close(), delay(5000)]);
  await secondContext?.close();
  xvfb?.kill();
  if (xvfb) await xvfb.exited;
  await bridge.close();
  await fixture.stop(true);
  await childFixture.stop(true);
  await denied.stop(true);
  await protectedFixture.stop(true);
  await secondBridge?.close();
  rmSync(dir, { recursive: true, force: true });
}
