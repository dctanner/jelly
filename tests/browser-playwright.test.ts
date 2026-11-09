import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserEngine } from "../src/server/browser/engine";
import { BrowserRepl } from "../src/server/browser/repl";
import { DirectChromePort } from "./fixtures/direct-chrome-port";

const html = (body: string) => new Response(`<!doctype html><html><head><title>PW</title></head><body>${body}</body></html>`, { headers: { "Content-Type": "text/html" } });
const child = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: () => html(`<label>Frame field <input></label><button onclick="this.textContent='Frame done'">Frame go</button>`),
});
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/next") return html(`<h1>Next ${url.searchParams.get("q")}</h1>`);
    if (url.pathname === "/pixel.png") return new Response(Buffer.from("89504e470d0a1a0a", "hex"), { headers: { "Content-Type": "image/png" } });
    return html(`
      <h1 id="title">Playwright fixture</h1>
      <button onclick="document.getElementById('title').textContent='Saved'">Save</button>
      <button data-testid="dup">Dup</button><button data-testid="dup">Dup</button>
      <button id="late" style="display:none" onclick="this.textContent='Late clicked'">Late</button>
      <script>setTimeout(() => document.getElementById('late').style.display = 'inline', 400)</script>
      <ul>
        <li>Apple <button onclick="this.textContent='bought apple'">Buy</button></li>
        <li>Banana <button onclick="this.textContent='bought banana'">Buy</button></li>
      </ul>
      <form action="/next">
        <label>Query <input name="q" placeholder="Search here"></label>
        <label>Colour <select name="c"><option value="r">Red</option><option value="g">Green</option></select></label>
        <label><input type="checkbox" name="ok"> Accept</label>
        <input type="file" id="file">
      </form>
      <div id="hover" onmouseover="this.textContent='hovered'">Hover me</div>
      <div id="dbl" ondblclick="this.textContent='double'">Double me</div>
      <img src="/pixel.png" alt="Pixel">
      <iframe src="http://localhost:${child.port}/" width="400" height="120"></iframe>`);
  },
});
const base = `http://127.0.0.1:${server.port}`;
let port: DirectChromePort, engine: BrowserEngine, repl: BrowserRepl;
const js = async (code: string) => {
  const r = await repl.run(code, { timeoutMs: 30000 });
  const out = r.items.map((i) => (i.type === "text" ? i.text : `[${i.mimeType}]`)).join("\n");
  if (r.error) throw new Error(`${r.error}\n${out}`);
  return out;
};
const jsError = async (code: string) => (await repl.run(code, { timeoutMs: 30000 })).error ?? "";

beforeAll(async () => {
  port = new DirectChromePort();
  await port.start();
  engine = new BrowserEngine(port);
  repl = new BrowserRepl((op, args, signal) => engine.execute(op, args, signal));
  await js(`const tab = await browser.tabs.new(${JSON.stringify(base)}); const pw = tab.playwright;`);
});
afterAll(async () => {
  repl.close();
  engine.dispose();
  await port.stop();
  server.stop(true);
  child.stop(true);
});

test("getByRole/getByText/filter/nth click with real input and read back", async () => {
  const out = await js(`
    await pw.getByRole("button", { name: "Save" }).click();
    console.log(await pw.locator("#title").textContent());
    await pw.getByRole("listitem").filter({ hasText: "Banana" }).getByRole("button").click();
    console.log(await pw.getByText("bought banana").count());
    await pw.getByTestId("dup").nth(1).click();
    console.log(await pw.locator("li").allTextContents());
    console.log(await pw.getByRole("button", { name: /buy/i }).count());`);
  expect(out).toContain("Saved");
  expect(out).toContain("1");
  expect(out).toContain("bought banana");
  expect(out).toContain("1"); // remaining Buy button
}, 30000);

test("auto-waits for visibility, reports strict-mode violations and timeouts with a call log", async () => {
  expect(await js(`await pw.locator("#late").click(); await pw.locator("#late").innerText()`)).toContain("Late clicked");
  expect(await jsError(`await pw.getByTestId("dup").click()`)).toContain("strict mode violation");
  const timeout = await jsError(`await pw.getByRole("button", { name: "Missing" }).click({ timeoutMs: 300 })`);
  expect(timeout).toContain("Timeout 300ms exceeded");
  expect(timeout).toContain("Call log");
}, 30000);

test("forms: getByLabel/getByPlaceholder fill, selectOption, check, press Enter with expectNavigation", async () => {
  const out = await js(`
    await pw.getByPlaceholder("Search here").fill("first");
    await pw.getByLabel("Query").fill("jelly");
    console.log("value", await pw.getByLabel("Query").inputValue());
    console.log("selected", await pw.getByLabel("Colour").selectOption("Green"));
    await pw.getByLabel("Accept").check();
    console.log("checked", await pw.getByLabel("Accept").evaluate((el) => el.checked));
    await pw.expectNavigation(() => pw.getByLabel("Query").press("Enter"), { url: "**/next?**" });
    await pw.waitForURL(/next\\?q=jelly/);
    console.log(await pw.locator("h1").innerText());
    await tab.back();`);
  expect(out).toContain("value jelly");
  expect(out).toContain('selected [ "g" ]'.replace(/"/g, "'"));
  expect(out).toContain("checked true");
  expect(out).toContain("Next jelly");
}, 30000);

test("frameLocator reaches a cross-origin iframe; hover/dblclick; evaluateAll; file chooser; downloadMedia", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-pw-"));
  const file = join(dir, "upload.txt");
  writeFileSync(file, "hello");
  const out = await js(`
    await pw.locator("#title").waitFor();
    const frame = pw.frameLocator("iframe");
    await frame.getByLabel("Frame field").fill("inside");
    await frame.getByRole("button", { name: "Frame go" }).click();
    console.log(await frame.getByRole("button").innerText(), await frame.getByLabel("Frame field").inputValue());
    await pw.locator("#hover").hover();
    await pw.locator("#dbl").dblclick();
    console.log(await pw.locator("#hover, #dbl").evaluateAll((els) => els.map((e) => e.textContent).join(",")));
    const chooser = pw.waitForEvent("filechooser");
    await pw.locator("#file").click();
    await (await chooser).setFiles(${JSON.stringify(file)});
    console.log("file", await pw.locator("#file").evaluate((el) => el.files[0]?.name));
    console.log("media", await pw.getByAltText("Pixel").downloadMedia({ directory: ${JSON.stringify(dir)} }));`);
  expect(out).toContain("Frame done inside");
  expect(out).toContain("hovered,double");
  expect(out).toContain("file upload.txt");
  const media = /media (\S+)/.exec(out)![1]!;
  expect(readFileSync(media).subarray(0, 4).toString("hex")).toBe("89504e47");
}, 30000);

test("domSnapshot exposes aria refs (iframes expanded) usable as locators; elementInfo maps points to selectors", async () => {
  await js(`await tab.reload();`);
  const snap = await js(`await pw.locator("#title").waitFor(); const snap = await pw.domSnapshot(); console.log(snap);`);
  expect(snap).toMatch(/button "Save" \[ref=e\d+\]/);
  expect(snap).toMatch(/button "Frame go" \[ref=f\d+e\d+\]/);
  const ref = /button "Save" \[ref=(e\d+)\]/.exec(snap)![1];
  const frameRef = /button "Frame go" \[ref=(f\d+e\d+)\]/.exec(snap)![1];
  const out = await js(`
    await pw.locator("aria-ref=${ref}").click();
    await pw.locator("aria-ref=${frameRef}").click();
    console.log(await pw.locator("#title").innerText(), await pw.frameLocator("iframe").getByRole("button").innerText());
  `);
  expect(out).toContain("Saved Frame done");
}, 30000);

test("elementInfo (Codex shape, enters iframes) and elementScreenshot annotate the probed point", async () => {
  const out = await js(`
    const center = (l) => l.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const save = await center(pw.getByRole("button", { name: "Save" }));
    const [top] = await pw.elementInfo(save);
    console.log("top", top.tagName, top.role, top.ariaName, top.selector.candidates.length > 0, top.nodeId > 0);
    await pw.locator(top.selector.primary).click();
    console.log("clicked", await pw.locator("#title").innerText());
    console.log("all", (await pw.elementInfo({ ...save, includeNonInteractable: true })).map((e) => e.tagName).join(","));
    const ifr = await pw.locator("iframe").evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x + el.clientLeft, y: r.y + el.clientTop }; });
    const btn = await center(pw.frameLocator("iframe").getByRole("button"));
    const inFrame = (await pw.elementInfo({ x: ifr.x + btn.x, y: ifr.y + btn.y }))[0];
    console.log("frame", inFrame.tagName, JSON.stringify(inFrame.selector.frameSelectors));
    const shot = await pw.elementScreenshot(save);
    display(shot);
    console.log("shot", shot.mimeType, shot.width > 0, shot.elements.length);
    console.log("overlay gone", await tab.evaluate("document.documentElement.lastElementChild.tagName"));`);
  expect(out).toContain("top button button Save true true");
  expect(out).toContain("clicked Saved");
  expect(out).toMatch(/all button,.*body,html/);
  expect(out).toMatch(/frame button \["(iframe|internal:[^"]+)"\]/);
  expect(out).toContain("shot image/jpeg true 1");
  expect(out).toContain("[image/jpeg]");
  expect(out).toContain("overlay gone BODY");
}, 30000);

test("locator builders produce Playwright's selector strings", async () => {
  const { TabPlaywright } = await import("../src/server/browser/playwright-client");
  const calls: any[] = [];
  const pw = new TabPlaywright(7, { call: async (op, args) => { calls.push({ op, ...args }); return 0; }, display: () => {} });
  await pw.getByRole("button", { name: "Save \"it\"", exact: true }).count();
  await pw.getByText(/sub"mit/i).first().count();
  await pw.getByRole("listitem").filter({ hasText: "Banana", has: pw.locator("button") }).nth(2).count();
  await pw.frameLocator("#f").getByLabel("Email").count();
  await pw.getByTestId("x").or(pw.getByPlaceholder("p")).count();
  expect(calls.map((c) => [c.frames, c.selector])).toEqual([
    [[], 'internal:role=button[name="Save \\"it\\""s]'],
    [[], 'internal:text=/sub\\"mit/i >> nth=0'],
    [[], 'internal:role=listitem >> internal:has-text="Banana"i >> internal:has="button" >> nth=2'],
    [["#f"], 'internal:label="Email"i'],
    [[], 'internal:testid=[data-testid="x"s] >> internal:or="internal:attr=[placeholder=\\"p\\"i]"'],
  ]);
  expect(calls.every((c) => c.op === "tab.pw" && c.tab === 7 && c.action === "count")).toBe(true);
});
