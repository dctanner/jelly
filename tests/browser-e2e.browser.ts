// End-to-end: browser_js REPL → BrowserEngine → ChromeSessions → ChromeBridge →
// native host → real v9 extension in headed Chromium. Mirrors how agents use it.
import { chromium, type BrowserContext } from "playwright-core";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "bun:test";
import { ChromeSessions } from "../src/server/chrome-sessions";
import { BrowserRepl } from "../src/server/browser/repl";

const dir = mkdtempSync(join(tmpdir(), "jelly-browser-e2e-"));
const html = (body: string) => new Response(`<!doctype html><title>E2E</title>${body}`, { headers: { "Content-Type": "text/html" } });
const child = Bun.serve({ hostname: "localhost", port: 0, fetch: () => html(`<button onclick="this.textContent='Frame clicked'">Frame button</button>`) });
const site = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/done") return html(`<h1>Signed in as ${url.searchParams.get("user")} (${url.searchParams.get("password")?.length} char password)</h1>`);
    if (url.pathname === "/popup") return html(`<h1>Popup page</h1>`);
    return html(`
      <h1>Login</h1>
      <form action="/done"><input name="user" aria-label="Username"><input name="password" type="password" aria-label="Password"><button>Sign in</button></form>
      <iframe src="http://localhost:${child.port}/" width="300" height="80" title="captcha"></iframe>
      <a href="/popup" target="_blank">Open popup</a>`);
  },
});
const sessions = new ChromeSessions(join(dir, "data"), "e2e-instance");
let context: BrowserContext | undefined;
const delay = (ms = 100) => new Promise((r) => setTimeout(r, ms));
async function command(args: string[]) {
  const p = Bun.spawn(args, { stdout: "ignore", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`${args.join(" ")} failed`);
}
const text = (r: Awaited<ReturnType<BrowserRepl["run"]>>) => r.items.filter((i) => i.type === "text").map((i) => (i as { text: string }).text).join("\n");

try {
  await sessions.bridge.ready;
  const extension = join(dir, "extension");
  await command([process.execPath, "scripts/build-chrome-extension.ts", extension]);
  const home = join(dir, "home"), config = join(home, ".config");
  mkdirSync(config, { recursive: true });
  if (!process.env.DISPLAY && process.platform !== "darwin") throw new Error("Headed Chrome needs DISPLAY.");
  context = await chromium.launchPersistentContext(join(dir, "profile"), {
    timeout: 30000,
    ignoreDefaultArgs: ["--disable-extensions"],
    executablePath: process.env.JELLY_EXTENSION_BROWSER_PATH ?? chromium.executablePath(),
    headless: false,
    viewport: { width: 1000, height: 700 },
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: config, ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}) },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-first-run", "--no-default-browser-check"],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const id = new URL(worker.url()).host;
  for (const target of [...["google-chrome", "chromium", "google-chrome-for-testing"].map((p) => join(config, p)), join(dir, "profile")])
    await command([process.execPath, "scripts/install-chrome-host.ts", "--data-dir", join(dir, "data"), "--extension-id", id, "--chrome-config", target]);
  const popup = await context.newPage();
  for (let i = 0; i < 450 && !sessions.bridge.profiles().length; i++) {
    if (i === 50) await popup.goto(`chrome-extension://${id}/popup.html#connect`);
    await delay();
  }
  const profile = sessions.bridge.profiles()[0];
  if (!profile) throw new Error("Extension never paired.");
  const agent = "agent-e2e", run = crypto.randomUUID();
  const port = sessions.allocate(agent, run, { chromeProfile: profile.id }, "E2E agent");
  const repl = new BrowserRepl((op, args, signal) => port.engine.execute(op, args, signal));
  const timings: string[] = [];
  const cell = async (label: string, code: string) => {
    const started = performance.now();
    const r = await repl.run(code, { timeoutMs: 60000 });
    timings.push(`${label}: ${Math.round(performance.now() - started)} ms`);
    if (r.error) throw new Error(`${label}: ${r.error}\n${text(r)}`);
    return r;
  };

  // 1. Open + observe in one call.
  let r = await cell("open+state", `await browser.nameSession("🔎 E2E"); const tab = await browser.tabs.new(${JSON.stringify(site.url.href)}); await tab.ax.write();`);
  let state = text(r);
  expect(state).toContain("AXWebArea E2E");
  expect(state).toContain("button Sign in");
  // Cross-origin iframe content is part of the state (may need one settle round).
  if (!state.includes("Frame button")) state = text(await cell("full state", `await tab.ax.write("state", {disableDiffing: true})`));
  expect(state).toContain("Frame button");
  const index = (re: RegExp) => { const m = re.exec(state); if (!m) throw new Error(`no ${re} in\n${state}`); return Number(m[1]); };
  const user = index(/(\d+) text field[^\n]*Username/), password = index(/(\d+) (?:secure )?text field[^\n]*Password/), frameButton = index(/(\d+) button Frame button/);

  // 2. Batched actions: password entry is allowed, OOPIF click, submit with Return, one state read.
  r = await cell("batch login", `
    await tab.ax.click(${frameButton});
    await tab.ax.setValue(${user}, "jelly");
    await tab.ax.typeText(${password}, "s3cret!");
    await tab.ax.pressKey(${password}, "Return");
    await tab.ax.write();`);
  expect(text(r)).toContain("Signed in as jelly (7 char password)");

  // 3. Screenshot of a background tab (JPEG image item) and a no-change read.
  r = await cell("screenshot", `await tab.ax.write("screenshot")`);
  const image = r.items.find((i) => i.type === "image") as { mimeType: string; data: string } | undefined;
  expect(image?.mimeType).toBe("image/jpeg");
  expect(Buffer.from(image!.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");

  // 4. Popups join the session; persistent REPL handles; evaluate + raw CDP + chrome passthrough.
  r = await cell("popup", `
    await tab.back(); await tab.ax.write("state", {disableDiffing: true});
    const before = (await browser.tabs.list()).length;
    await tab.evaluate(() => document.querySelector('a').click());
    await sleep(500);
    const tabs = await browser.tabs.list();
    console.log("tabs", before, "->", tabs.length);
    const popupTab = tabs.find((t) => t.id !== tab.id);
    await popupTab.ax.write();
    console.log("cdp", (await tab.cdp.send("Runtime.evaluate", {expression: "1+1", returnByValue: true})).result.value);
    console.log("chrome", (await browser.chrome.tabs.query({})).length > 0);`);
  expect(text(r)).toContain("tabs 1 -> 2");
  expect(text(r)).toContain("Popup page");
  expect(text(r)).toContain("cdp 2");
  expect(text(r)).toContain("chrome true");

  // 5. Playwright-style locators through the real extension (InjectedScript injected per frame).
  r = await cell("playwright", `
    await tab.goto(${JSON.stringify(site.url.href)});
    const pw = tab.playwright;
    await pw.getByLabel("Username").fill("pw-user");
    await pw.frameLocator("iframe").getByRole("button", { name: "Frame button" }).click();
    console.log(await pw.getByLabel("Username").inputValue(), await pw.frameLocator("iframe").getByRole("button").innerText());
    await pw.expectNavigation(() => pw.getByRole("button", { name: "Sign in" }).click());
    console.log(await pw.locator("h1").innerText());
    await tab.back();
    const r = await pw.getByRole("button", { name: "Sign in" }).evaluate((el) => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
    const shot = await pw.elementScreenshot(r);
    display(shot);
    console.log("annotated", shot.elements[0].ariaName, shot.mimeType);`);
  expect(text(r)).toContain("annotated Sign in image/jpeg");
  expect(r.items.some((i) => i.type === "image")).toBe(true);
  expect(text(r)).toContain("pw-user Frame clicked");
  expect(text(r)).toContain("Signed in as pw-user");

  // 6. Turn end: unmarked agent tabs close; deliverable survives.
  await cell("mark", `await tab.markDeliverable();`);
  await sessions.settle(agent, run);
  const remaining = await (await context.newPage()).evaluate(() => 0);
  void remaining;
  const pages = context.pages().map((p) => p.url());
  expect(pages.some((u) => u.includes("/popup"))).toBe(false);
  expect(pages.some((u) => u.startsWith(site.url.origin) && !u.includes("/popup"))).toBe(true);
  repl.close();
  console.log(`Timings (REPL cell round trips through the real extension):\n  ${timings.join("\n  ")}`);
  console.log("PASS: browser_js end to end through the real extension: open+AX state, OOPIF capture and click, password entry, batched actions with settle across navigation, background-tab JPEG screenshot, history, popup adoption, Playwright locators incl. cross-origin frameLocator, expectNavigation and elementScreenshot, evaluate, raw CDP, chrome.* passthrough, turn-end cleanup with deliverable.");
} finally {
  await Promise.race([context?.close(), delay(5000)]);
  await sessions.close();
  site.stop(true);
  child.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
