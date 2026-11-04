import { chromium, type BrowserContext } from "playwright-core";
import { expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChromeBridge } from "../src/server/chrome-bridge";

// Two disposable extensions, a private fixture native host and local web pages.
// The helper simulates injected privacy UI without identifying any user extension.
const dir = mkdtempSync(join(tmpdir(), "jelly-opaque-extension-"));
const fixture = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const html = path === "/nested"
      ? '<h2>NESTED_WEB_SENTINEL</h2><button>Nested action</button>'
      : path === "/sibling"
        ? '<h2>SIBLING_WEB_SENTINEL</h2><button>Sibling action</button>'
        : path === "/reset" ? '<h1>Controlled new document</h1><button>Reset action</button>'
        : '<h1>Local auth fixture</h1><input id="email" type="email" aria-label="Fixture email"><button onclick="document.querySelector(\'h1\').textContent=\'Main clicked\'">Main action</button><iframe src="/sibling" style="width:300px;height:100px"></iframe>';
    return new Response(html, { headers: { "Content-Type": "text/html" } });
  },
});
const bridge = new ChromeBridge(join(dir, "data"), "opaque-fixture");
let context: BrowserContext | undefined;
const delay = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
  if (await child.exited) throw new Error(`Fixture command failed: ${args[1]}`);
}
try {
  if (process.platform !== "darwin" && !process.env.DISPLAY)
    throw new Error("Headed fixture requires DISPLAY (use xvfb-run on Linux); no test performed.");
  await bridge.ready;
  const extension = join(dir, "jelly"), helper = join(dir, "helper"), home = join(dir, "home"), profileDir = join(dir, "profile");
  mkdirSync(helper); mkdirSync(home);
  await command([process.execPath, "scripts/build-chrome-extension.ts", extension]);
  writeFileSync(join(helper, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "Disposable privacy-frame fixture", version: "1.0",
    content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"], run_at: "document_idle" }],
    web_accessible_resources: [{ resources: ["helper.html"], matches: ["http://127.0.0.1/*"] }],
  }));
  writeFileSync(join(helper, "content.js"), `
    if (location.origin === ${JSON.stringify(fixture.url.origin)} && location.pathname === "/") {
      document.querySelector("#email").addEventListener("input", () => setTimeout(() => {
        const frame = document.createElement("iframe");
        frame.id = "privacy-frame";
        frame.src = chrome.runtime.getURL("helper.html");
        frame.style = "width:300px;height:140px";
        document.body.append(frame);
      }, 500), { once: true });
      document.body.dataset.helperReady = "true";
    }
  `);
  writeFileSync(join(helper, "helper.html"), `<h2>OPAQUE_PRIVATE_SENTINEL</h2><input type="password" value="PRIVATE_FIXTURE"><iframe src="${fixture.url.origin}/nested"></iframe>`);
  const config = join(home, ".config");
  // All registrations and pairing data belong to this temporary fixture.
  for (const root of [profileDir, ...["google-chrome", "chromium", "google-chrome-for-testing"].map(p => join(config, p))])
    await command([process.execPath, "scripts/install-chrome-host.ts", "--data-dir", join(dir, "data"), "--chrome-config", root]);
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: process.env.JELLY_EXTENSION_BROWSER_PATH ?? chromium.executablePath(),
    headless: false, ignoreDefaultArgs: ["--disable-extensions"], viewport: { width: 900, height: 700 },
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: config, LANG: "C.UTF-8", ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}) },
    args: [`--disable-extensions-except=${extension},${helper}`, `--load-extension=${extension},${helper}`, "--no-first-run", "--no-default-browser-check"],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  for (let i = 0; i < 900 && !bridge.profiles().length; i++) await delay();
  expect(bridge.profiles()).toHaveLength(1);
  const peer = bridge.profiles()[0]!, session = crypto.randomUUID(), run = crypto.randomUUID();
  const pauses: unknown[] = [];
  bridge.onPauseState = (_profile, _generation, sid, _run, state, reason, navigationDiagnostic) => {
    if (sid === session) pauses.push({ state, reason, navigationDiagnostic });
  };
  const call = (method: Parameters<ChromeBridge["call"]>[4], params: Record<string, unknown> = {}) =>
    bridge.call(peer.id, peer.generation, session, run, method, params) as Promise<any>;
  await call("begin", { name: "Opaque privacy frame", protected: [] });
  const pagePromise = context.waitForEvent("page");
  const opened = await call("open", { url: fixture.url.href });
  const page = await pagePromise;
  await page.waitForURL(fixture.url.href);
  await page.waitForFunction(() => document.body.dataset.helperReady === "true");
  await page.frameLocator('iframe[src="/sibling"]').getByText("SIBLING_WEB_SENTINEL").waitFor();
  await worker.evaluate(async (url) => {
    const api = (globalThis as any).chrome;
    const tab = (await api.tabs.query({})).find((t: any) => t.url === url);
    const commits: any[] = [];
    const listener = (event: any) => {
      if (event.tabId === tab.id && event.frameId > 0 && event.url.startsWith("chrome-extension:"))
        commits.push({ frameId: event.frameId, documentId: event.documentId });
    };
    api.webNavigation.onCommitted.addListener(listener);
    (globalThis as any).opaqueFixtureCommits = { commits, cleanup: () => api.webNavigation.onCommitted.removeListener(listener) };
  }, fixture.url.href);
  const before = await call("snapshot", { tab: opened.pageId });
  expect(before.text).toContain("SIBLING_WEB_SENTINEL");
  const input = before.elements.find((el: any) => el.label === "Fixture email");
  expect(await call("fill", { tab: opened.pageId, ref: input.ref, text: "fixture@example.test" })).toEqual({ ok: true });
  const pending = await call("snapshot", { tab: opened.pageId });
  const oldSibling = pending.elements.find((el: any) => el.label.trim() === "Sibling action").ref;
  // Read only Chrome's metadata here, not the privacy document or its child DOM.
  let frames: any[] = [];
  for (let i = 0; i < 100; i++) {
    frames = await worker.evaluate(async (url) => {
      const api = (globalThis as any).chrome;
      const tab = (await api.tabs.query({})).find((t: any) => t.url === url);
      return (await api.webNavigation.getAllFrames({ tabId: tab.id })).map((f: any) => ({
        frameId: f.frameId, parentFrameId: f.parentFrameId, documentId: f.documentId,
        kind: f.frameId === 0 ? "main" : f.url.startsWith("chrome-extension:") ? "opaque" : new URL(f.url).pathname === "/nested" ? "nested" : "sibling",
      }));
    }, fixture.url.href);
    if (frames.some(f => f.kind === "nested") && await worker.evaluate(() => (globalThis as any).opaqueFixtureCommits.commits.length > 0)) break;
    await delay();
  }
  const commits = await worker.evaluate(() => (globalThis as any).opaqueFixtureCommits.commits);
  const opaque = commits[0], nested = frames.find(f => f.kind === "nested");
  expect(opaque).toBeDefined(); expect(nested).toBeDefined();
  expect(nested.parentFrameId).toBe(opaque.frameId);
  expect(frames.some(f => f.frameId === opaque.frameId)).toBe(false); // Actual Chrome metadata gap.
  await delay();
  // Pre-fix source reproduces the exact live extension_other/internal_v2 pause.
  expect(pauses).toEqual([]);
  await worker.evaluate(() => {
    const api = (globalThis as any).chrome;
    const original = api.scripting.executeScript.bind(api.scripting);
    (globalThis as any).opaqueFixtureInjection = { docs: [] as string[], restore: () => { api.scripting.executeScript = original; } };
    api.scripting.executeScript = (options: any) => {
      (globalThis as any).opaqueFixtureInjection.docs.push(...options.target.documentIds);
      return original(options);
    };
  });
  try {
    await expect(call("click", { tab: opened.pageId, ref: oldSibling })).rejects.toThrow();
    const partial = await call("snapshot", { tab: opened.pageId });
    expect(partial.framesOmitted).toBe(true);
    expect(partial.frames).toHaveLength(1);
    expect(partial.text).toContain("Local auth fixture");
    for (const sentinel of ["OPAQUE_PRIVATE_SENTINEL", "NESTED_WEB_SENTINEL", "SIBLING_WEB_SENTINEL", "PRIVATE_FIXTURE"])
      expect(JSON.stringify(partial)).not.toContain(sentinel);
    expect(partial.elements.some((el: any) => /Nested|Sibling/.test(el.label))).toBe(false);
    const mainRef = partial.elements.find((el: any) => el.label.trim() === "Main action").ref;
    await call("click", { tab: opened.pageId, ref: mainRef });
    expect((await call("snapshot", { tab: opened.pageId })).text).toContain("Main clicked");
    expect(await call("wait_for", { tab: opened.pageId, condition: "text_absent", text: "NESTED_WEB_SENTINEL", timeoutMs: 0 })).toEqual({ ok: false, timedOut: true });
    await expect(call("screenshot", { tab: opened.pageId })).rejects.toThrow("unsupported_frame");
    const injected = await worker.evaluate(() => (globalThis as any).opaqueFixtureInjection.docs);
    expect(injected.length).toBeGreaterThan(0);
    expect(injected.every((id: string) => id === frames.find(f => f.kind === "main").documentId)).toBe(true);
    const last = await call("snapshot", { tab: opened.pageId });
    const stale = last.elements.find((el: any) => el.label.trim() === "Main action").ref;
    await page.locator("#privacy-frame").evaluate(el => el.remove());
    await expect(call("click", { tab: opened.pageId, ref: stale })).rejects.toThrow();
    const removed = await call("snapshot", { tab: opened.pageId });
    expect(removed.framesOmitted).toBe(true); // Absence cannot prove privileged UI is gone.
    expect(removed.text).not.toContain("SIBLING_WEB_SENTINEL");
    await expect(call("screenshot", { tab: opened.pageId })).rejects.toThrow("unsupported_frame");
    await call("open", { tab: opened.pageId, url: `${fixture.url.origin}/reset` });
    await page.waitForURL(`${fixture.url.origin}/reset`);
    await page.waitForLoadState("load");
    await delay(100);
    const reset = await call("snapshot", { tab: opened.pageId });
    expect(reset.text).toContain("Controlled new document");
    expect(reset.framesOmitted).toBeUndefined();
  } finally {
    await worker.evaluate(() => {
      (globalThis as any).opaqueFixtureInjection.restore(); delete (globalThis as any).opaqueFixtureInjection;
      (globalThis as any).opaqueFixtureCommits.cleanup(); delete (globalThis as any).opaqueFixtureCommits;
    });
  }
  expect(pauses).toEqual([]);
  await call("end", { discard: true });
  console.log("PASS: real extension ancestor omitted by Chrome metadata with nested HTTP descendant; no private injection, main actions usable, stale refs/screenshots/absence claims blocked, removal stays partial until verified new document.");
} finally {
  await context?.close();
  await bridge.close();
  await fixture.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
