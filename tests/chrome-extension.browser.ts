// Real-Chromium end-to-end test of the v9 extension relay: headed disposable
// profile + real native host + ChromeBridge socket.
import { chromium, type BrowserContext } from "playwright-core";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "bun:test";
import { ChromeBridge } from "../src/server/chrome-bridge";
import type { ChromeCdpEvent, ChromeTabInfo } from "../src/shared/chrome-protocol";

const dir = mkdtempSync(join(tmpdir(), "jelly-chrome-relay-"));
const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html" } });
// A different site (localhost vs 127.0.0.1) so the frame is an OOPIF.
const childFixture = Bun.serve({
  hostname: process.platform === "darwin" ? "localhost" : "127.0.0.2",
  port: 0,
  fetch: () => html("<h2>OOPIF child</h2>"),
});
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/oopif") return html(`<h1>Cross-site frames</h1><iframe src="${childFixture.url.origin}/"></iframe>`);
    if (path === "/popup-child") return html("<title>Popup child</title><h1>Popup child</h1>");
    if (path === "/login")
      return html('<title>Login</title><input type="password" id="pw"><iframe src="/captcha" title="captcha"></iframe>');
    if (path === "/captcha") return html("<p>captcha frame</p>");
    if (path === "/user") return html("<title>User tab</title><h1>User tab</h1>");
    return html(`<title>Local fixture</title><h1>Local fixture ${path}</h1>`);
  },
});
const bridge = new ChromeBridge(join(dir, "data"), "relay-fixture");
let context: BrowserContext | undefined;
let xvfb: ReturnType<typeof Bun.spawn> | undefined;
async function command(args: string[]) {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  if (await p.exited) throw new Error(`Command failed: ${args[1]}: ${await new Response(p.stderr).text()}`);
}
const delay = (ms = 100) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, timeout = 10000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
try {
  await bridge.ready;
  const extension = join(dir, "extension");
  await command([process.execPath, "scripts/build-chrome-extension.ts", extension]);
  const home = join(dir, "home");
  const config = join(home, ".config");
  mkdirSync(config, { recursive: true });
  let display = process.env.DISPLAY;
  const xbin = existsSync("/usr/bin/Xvfb") ? "/usr/bin/Xvfb" : resolve(".jelly/runtime/usr/bin/Xvfb");
  if (process.platform !== "darwin" && existsSync(xbin)) {
    xvfb = Bun.spawn([xbin, "-displayfd", "1", "-screen", "0", "1280x900x24", "-nolisten", "tcp"], {
      env: { ...process.env, LD_LIBRARY_PATH: resolve(".jelly/runtime/usr/lib/x86_64-linux-gnu") },
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = (xvfb.stdout as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    display = `:${new TextDecoder().decode(first.value).trim()}`;
    reader.releaseLock();
  }
  if (!display && process.platform !== "darwin") throw new Error("Headed Chrome needs Xvfb or DISPLAY; no test was performed.");
  console.log("Chrome relay fixture: launching headed disposable profile");
  context = await chromium.launchPersistentContext(join(dir, "profile"), {
    timeout: 30000,
    ignoreDefaultArgs: ["--disable-extensions"],
    executablePath: process.env.JELLY_EXTENSION_BROWSER_PATH ?? chromium.executablePath(),
    headless: false,
    viewport: { width: 800, height: 600 },
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", HOME: home, XDG_CONFIG_HOME: config, ...(display ? { DISPLAY: display } : {}) },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-first-run", "--no-default-browser-check"],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const id = new URL(worker.url()).host;
  expect(id).toBe("mikadpfmkipiafkemjplldmfckomphcf");
  for (const target of [...["google-chrome", "chromium", "google-chrome-for-testing"].map((p) => join(config, p)), join(dir, "profile")])
    await command([process.execPath, "scripts/install-chrome-host.ts", "--data-dir", join(dir, "data"), "--extension-id", id, "--chrome-config", target]);
  console.log("Chrome relay fixture: host installed, waiting for pairing");
  const popup = await context.newPage();
  for (let i = 0; i < 450 && !bridge.profiles().length; i++) {
    if (i === 50) await popup.goto(`chrome-extension://${id}/popup.html#connect`);
    await delay();
  }
  expect(bridge.profiles()).toHaveLength(1);
  const peer = bridge.profiles()[0]!;
  const session = crypto.randomUUID();
  let run = crypto.randomUUID();
  const events: ChromeCdpEvent[] = [];
  const added: ChromeTabInfo[] = [];
  const removed: number[] = [];
  const detaches: [number, string][] = [];
  const pauses: string[] = [];
  bridge.onCdpEvent = (_p, _g, s, _r, event) => { if (s === session) events.push(event); };
  bridge.onTabAdded = (_p, _g, s, _r, tab) => { if (s === session) added.push(tab); };
  bridge.onTabRemoved = (_p, _g, s, _r, tabId) => { if (s === session) removed.push(tabId); };
  bridge.onCdpDetach = (_p, _g, s, _r, tabId, reason) => { if (s === session) detaches.push([tabId, reason]); };
  bridge.onPauseState = (_p, _g, s, _r, state, reason) => { if (s === session) pauses.push(`${state}:${reason}`); };
  const call = (method: Parameters<ChromeBridge["call"]>[4], params: Record<string, unknown> = {}) =>
    bridge.call(peer.id, peer.generation, session, run, method, params).catch((error: Error) => {
      throw new Error(`Fixture ${method} ${JSON.stringify(params).slice(0, 200)}: ${error.message}`);
    }) as Promise<any>;
  const evaluate = async (tabId: number, expression: string, sessionId?: string) =>
    (await call("cdp", { tabId, ...(sessionId ? { sessionId } : {}), method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } })).result.value;
  const workerTabs = () => worker.evaluate(() => (globalThis as any).chrome.tabs.query({})) as Promise<any[]>;
  // getTargets().attached also reflects Playwright's own CDP connection, so probe
  // whether *this extension* holds a debugger session on each tab.
  const attachedTargets = () =>
    worker.evaluate(async () => {
      const c = (globalThis as any).chrome;
      const ids = ((await c.tabs.query({})) as any[]).map((t) => t.id);
      const ours: number[] = [];
      for (const tabId of ids)
        try { await c.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "1" }); ours.push(tabId); } catch {}
      return ours;
    }) as Promise<number[]>;

  expect(await call("begin", { name: "Relay test", agent: "agent-a" })).toEqual({ ok: true, tabs: [], paused: false });
  const main = (await call("createTab", { url: `${fixture.url.origin}/first` })).tab as ChromeTabInfo;
  expect(main).toMatchObject({ origin: "agent", mark: null, active: false });
  const groups = await worker.evaluate(() => (globalThis as any).chrome.tabGroups.query({})) as any[];
  expect(groups.map((g) => g.title)).toContain("🔎 Relay test");

  // attach + CDP + event forwarding.
  expect(await call("attach", { tabId: main.id })).toEqual({ ok: true });
  expect(await call("attach", { tabId: main.id })).toEqual({ ok: true });
  await call("cdp", { tabId: main.id, method: "Page.enable" });
  await call("cdp", { tabId: main.id, method: "Page.navigate", params: { url: `${fixture.url.origin}/second` } });
  await until("Page.loadEventFired", () => events.some((e) => e.tabId === main.id && e.method === "Page.loadEventFired"));
  expect(await evaluate(main.id, "document.querySelector('h1').textContent")).toBe("Local fixture /second");
  expect(await call("cdpBatch", { tabId: main.id, commands: [1, 2, 3].map((n) => ({ method: "Runtime.evaluate", params: { expression: `${n}*2`, returnByValue: true } })) }))
    .toEqual({ results: [2, 4, 6].map((value) => ({ result: { type: "number", value, description: String(value) } })) });
  await expect(call("cdp", { tabId: main.id, method: "Runtime.evaluate", params: { expression: "new Promise(() => {})", awaitPromise: true }, timeoutMs: 200 }))
    .rejects.toThrow('Timed out running CDP command "Runtime.evaluate" after 200ms');
  expect(await evaluate(main.id, "1+1")).toBe(2); // still attached after the timeout
  await expect(call("cdp", { tabId: main.id, method: "Nope.missing" })).rejects.toThrow(/wasn't found|not found/i);

  // No refusals: password fields and captcha frames are ordinary DOM.
  await call("cdp", { tabId: main.id, method: "Page.navigate", params: { url: `${fixture.url.origin}/login` } });
  await until("login page", async () => (await evaluate(main.id, "document.title")) === "Login");
  await evaluate(main.id, "document.getElementById('pw').value = 'hunter2'");
  expect(await evaluate(main.id, "document.getElementById('pw').value")).toBe("hunter2");

  // OOPIF child session via flattened auto-attach.
  await call("cdp", { tabId: main.id, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } });
  await call("cdp", { tabId: main.id, method: "Page.navigate", params: { url: `${fixture.url.origin}/oopif` } });
  const child = await until("OOPIF attach", () =>
    events.find((e) => e.method === "Target.attachedToTarget" && (e.params as any).targetInfo.type === "iframe"));
  const childSession = (child.params as any).sessionId as string;
  await call("cdp", { tabId: main.id, sessionId: childSession, method: "Runtime.runIfWaitingForDebugger" });
  expect(await until("OOPIF text", async () => {
    const text = await evaluate(main.id, "document.body?.innerText ?? ''", childSession);
    return text.includes("OOPIF child") && text;
  })).toContain("OOPIF child");
  await call("cdp", { tabId: main.id, sessionId: childSession, method: "Runtime.enable" });
  await until("child-session event", () => events.some((e) => e.sessionId === childSession && e.method === "Runtime.executionContextCreated"));

  // Popup adoption: window.open from a leased tab is leased and grouped.
  await call("cdp", { tabId: main.id, method: "Runtime.evaluate", params: { expression: `window.open('${fixture.url.origin}/popup-child'); 1`, userGesture: true } });
  const popupTab = await until("tabAdded", () => added[0]);
  expect(popupTab).toMatchObject({ origin: "agent", mark: null });
  expect((await call("listTabs")).tabs.map((t: ChromeTabInfo) => t.id).sort()).toEqual([main.id, popupTab.id].sort());
  expect(await until("popup title", async () => (await evaluate(popupTab.id, "document.title")) === "Popup child" || false)).toBe(true);

  // User tabs: listed (not other sessions'), claimed in place.
  const userPage = await context.newPage();
  await userPage.goto(`${fixture.url.origin}/user`);
  const userTab = await until("user tab", async () => (await call("userTabs")).tabs.find((t: any) => t.url.endsWith("/user")));
  expect(userTab).toMatchObject({ groupId: -1, pinned: false });
  expect(typeof userTab.lastAccessed).toBe("number");
  expect((await call("claimTab", { tabId: userTab.id })).tab).toMatchObject({ id: userTab.id, origin: "user" });
  expect(await evaluate(userTab.id, "document.title")).toBe("User tab");

  // chrome.* passthrough.
  const queried = await call("chrome", { namespace: "tabs", method: "query", args: [{ url: `${fixture.url.origin}/user` }] });
  expect(queried.map((t: any) => t.id)).toEqual([userTab.id]);
  await call("chrome", { namespace: "bookmarks", method: "create", args: [{ title: "Jelly fixture", url: `${fixture.url.origin}/` }] });
  expect((await call("chrome", { namespace: "bookmarks", method: "search", args: ["Jelly fixture"] })).length).toBe(1);

  // A human closing an attached tab: cdpDetach + tabRemoved, session not paused.
  const scratch = (await call("createTab", { url: `${fixture.url.origin}/scratch` })).tab as ChromeTabInfo;
  await call("attach", { tabId: scratch.id });
  await worker.evaluate((tabId) => (globalThis as any).chrome.tabs.remove(tabId), scratch.id);
  await until("tabRemoved", () => removed.includes(scratch.id));
  await until("cdpDetach", () => detaches.some(([tabId]) => tabId === scratch.id));
  expect(pauses).toEqual([]);

  // Pause detaches every debugger; resume restores work.
  expect((await attachedTargets()).length).toBeGreaterThan(0);
  expect(await call("pause")).toEqual({ ok: true });
  expect(pauses).toEqual(["pausing:requested", "paused:requested"]);
  expect(await attachedTargets()).toEqual([]);
  await expect(call("cdp", { tabId: main.id, method: "Page.enable" })).rejects.toThrow("Browser session is paused.");
  expect(await call("resume")).toEqual({ ok: true });
  expect(await evaluate(main.id, "location.pathname")).toBe("/oopif");

  // Turn end: unmarked agent tab closed, user tab released, deliverable ungrouped, handoff retained.
  const handoff = (await call("createTab", { url: `${fixture.url.origin}/handoff` })).tab as ChromeTabInfo;
  await call("markTab", { tabId: popupTab.id, mark: "deliverable" });
  await call("markTab", { tabId: handoff.id, mark: "handoff" });
  pauses.length = 0;
  expect(await call("end")).toEqual({ ok: true, retained: [handoff.id] });
  expect(pauses).toEqual(["pausing:settlement", "paused:settlement"]);
  const after = await workerTabs();
  const byId = new Map(after.map((t) => [t.id, t]));
  expect(byId.has(main.id)).toBe(false);
  expect(byId.get(popupTab.id)?.groupId).toBe(-1);
  expect(byId.has(userTab.id)).toBe(true);
  expect(byId.has(handoff.id)).toBe(true);
  expect(await attachedTargets()).toEqual([]);
  expect((await call("listTabs")).tabs.map((t: ChromeTabInfo) => t.id)).toEqual([handoff.id]);
  await expect(call("cdp", { tabId: handoff.id, method: "Page.enable" })).rejects.toThrow("turn has ended");
  run = crypto.randomUUID();
  expect(await call("begin", { name: "Relay test" })).toEqual({ ok: true, tabs: [handoff.id], paused: false });
  expect(await evaluate(handoff.id, "location.pathname")).toBe("/handoff");
  // The released user tab is claimable again; the deliverable now belongs to the user.
  expect((await call("userTabs")).tabs.map((t: any) => t.id)).toEqual(expect.arrayContaining([userTab.id, popupTab.id]));
  await call("markTab", { tabId: handoff.id, mark: "handoff" }); // marks are turn-scoped
  expect(await call("end", { discard: true })).toEqual({ ok: true, retained: [] });
  expect((await workerTabs()).some((t) => t.id === handoff.id)).toBe(true);
  expect(await attachedTargets()).toEqual([]);

  // Disconnect from the popup revokes the connection.
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByRole("button", { name: "Disconnect", exact: true }).click();
  await until("disconnect", () => !bridge.profiles().length);
  console.log("PASS: real Chromium relay: pairing, begin, createTab+url, attach, cdp, cdpBatch, CDP timeout without detach, cdpEvent forwarding, password/captcha pages unguarded, OOPIF child session via flattened auto-attach, popup adoption, userTabs/claimTab, chrome passthrough, cdpDetach/tabRemoved on human close, pause/resume detach, turn end (closed/released/deliverable/handoff retained), discard, disconnect.");
} finally {
  await Promise.race([context?.close(), delay(5000)]);
  xvfb?.kill();
  if (xvfb) await xvfb.exited;
  await bridge.close();
  await fixture.stop(true);
  await childFixture.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
