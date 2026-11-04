import { chromium, type BrowserContext } from "playwright-core";
import { expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Diagnostic qualification only. This extension has NO nativeMessaging/debugger
// permission or Jelly connection, so the probe cannot pair with a live instance.
// It records only fixed URL classes from disposable local fixtures, never URLs.
const dir = mkdtempSync(join(tmpdir(), "jelly-error-document-"));
const empty = Bun.listen({
  hostname: "127.0.0.1", port: 0,
  socket: { data(socket) { socket.end(); } },
});
const denied = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: () => new Response("Blocked local child", { headers: { "X-Frame-Options": "DENY" } }),
});
const sameSiteFailure = `http://127.0.0.1:${empty.port}/failed`;
const crossSiteFailure = `http://localhost:${empty.port}/failed`;
const blockedChild = `http://localhost:${denied.port}/blocked`;
const fixture = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/healthy-child") return new Response("<h2>Healthy local child</h2>", { headers: { "Content-Type": "text/html" } });
    const src = path === "/same-site" ? sameSiteFailure : path === "/xfo" ? blockedChild : path === "/late" ? "/healthy-child" : crossSiteFailure;
    const onload = path === "/late" ? `onload="this.onload=null;this.src='${crossSiteFailure}'"` : "";
    return new Response(`<h1>Disposable failed-frame probe</h1><iframe src="${src}" ${onload}></iframe>`, { headers: { "Content-Type": "text/html" } });
  },
});
let context: BrowserContext | undefined;
try {
  if (process.platform !== "darwin" && !process.env.DISPLAY)
    throw new Error("Headed probe requires DISPLAY (use xvfb-run on Linux); no test performed.");
  const extension = join(dir, "extension"), home = join(dir, "home");
  mkdirSync(extension); mkdirSync(home);
  writeFileSync(join(extension, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "Jelly local failed-frame probe", version: "1.0",
    permissions: ["tabs", "webNavigation"],
    host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
    background: { service_worker: "probe.js" },
  }));
  writeFileSync(join(extension, "probe.js"), `
    const fixtureOrigin = ${JSON.stringify(fixture.url.origin)};
    const failedOrigins = ${JSON.stringify([new URL(sameSiteFailure).origin, new URL(crossSiteFailure).origin, new URL(blockedChild).origin])};
    function classify(url) {
      if (url === "chrome-error://chromewebdata/") return "chromium_error_document";
      if (url === "about:blank") return "blank";
      try {
        const origin = new URL(url).origin;
        if (failedOrigins.includes(origin)) return "fixture_failed_http";
        if (origin === fixtureOrigin) return "fixture_http";
      } catch {}
      return "other";
    }
    globalThis.probeEvents = [];
    globalThis.probeClassify = classify;
    for (const event of ["onBeforeNavigate", "onCommitted", "onErrorOccurred", "onCompleted"])
      chrome.webNavigation[event].addListener(d => globalThis.probeEvents.push({
        event, tabId: d.tabId, frameId: d.frameId, urlClass: classify(d.url)
      }));
  `);
  context = await chromium.launchPersistentContext(join(dir, "profile"), {
    headless: false, executablePath: process.env.JELLY_EXTENSION_BROWSER_PATH ?? chromium.executablePath(),
    ignoreDefaultArgs: ["--disable-extensions"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), LANG: "C.UTF-8", ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}) },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-first-run", "--no-default-browser-check"],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  for (const scenario of ["same-site", "cross-site", "xfo", "late"]) {
    await worker.evaluate(() => { (globalThis as any).probeEvents = []; });
    const page = await context.newPage();
    await page.goto(`${fixture.url.origin}/${scenario}`);
    let result: any;
    for (let i = 0; i < 100; i++) {
      result = await worker.evaluate(async () => {
        const api = (globalThis as any).chrome;
        const all = (globalThis as any).probeEvents;
        const top = all.find((e: any) => e.event === "onCommitted" && e.frameId === 0 && e.urlClass === "fixture_http");
        if (!top) return null;
        const events = all.filter((e: any) => e.tabId === top.tabId && e.frameId > 0)
          .map((e: any) => ({ event: e.event, urlClass: e.urlClass }));
        const frames = (await api.webNavigation.getAllFrames({ tabId: top.tabId }))
          .filter((f: any) => f.frameId > 0)
          .map((f: any) => ({ urlClass: (globalThis as any).probeClassify(f.url), errorOccurred: f.errorOccurred }));
        return { events, frames };
      });
      if (result?.events.some((e: any) => e.event === "onErrorOccurred") && result.frames.some((f: any) => f.errorOccurred)) break;
      await page.waitForTimeout(50);
    }
    expect(result.events).toContainEqual({ event: "onErrorOccurred", urlClass: "fixture_failed_http" });
    expect(result.frames).toContainEqual({ urlClass: "fixture_failed_http", errorOccurred: true });
    if (scenario === "late") expect(result.events).toContainEqual({ event: "onCommitted", urlClass: "fixture_http" });
    // These tested failures do not establish the live browser_internal commit.
    // A change here means requalify browser behavior, NOT relax internal policy.
    expect(result.events.some((e: any) => e.event === "onCommitted" && e.urlClass === "chromium_error_document")).toBe(false);
    console.log(`PASS ${scenario}: ${JSON.stringify(result)}`);
    await page.close();
  }
} finally {
  await context?.close();
  empty.stop(true);
  await denied.stop(true);
  await fixture.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
