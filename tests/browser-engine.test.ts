import { afterAll, beforeAll, expect, test } from "bun:test";
import { BrowserEngine } from "../src/server/browser/engine";
import { DirectChromePort } from "./fixtures/direct-chrome-port";

const html = (body: string) => new Response(`<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`, { headers: { "Content-Type": "text/html" } });
const child = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: () => html(`<h2 id="ct">Child frame</h2><button onclick="document.getElementById('ct').textContent='Child clicked'">Child button</button>`),
});
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req) {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/form":
        return html(`
          <h1 id="h">Counter 0</h1>
          <button onclick="let h=document.getElementById('h');h.textContent='Counter '+(+h.textContent.split(' ')[1]+1)">Increment</button>
          <form action="/done" method="get">
            <label>Email <input name="email" type="email"></label>
            <label>Password <input name="password" type="password"></label>
            <label>Country <select name="country"><option value="uk">United Kingdom</option><option value="fr">France</option></select></label>
            <label><input type="checkbox" name="agree"> Agree</label>
            <textarea aria-label="Notes"></textarea>
            <button type="submit">Send</button>
          </form>
          <div style="height:3000px"></div><p>Bottom text</p>`);
      case "/done":
        return html(`<h1>Done ${url.searchParams.get("email")} ${url.searchParams.get("country")} ${url.searchParams.get("agree") ?? "no"}</h1><a href="/form">Back to form</a>`);
      case "/frames":
        return html(`<h1>Frames host</h1><iframe src="http://localhost:${child.port}/" width="400" height="200"></iframe>`);
      case "/dialog":
        return html(`<h1 id="r">No answer</h1><button onclick="document.getElementById('r').textContent = confirm('Proceed?') ? 'Yes' : 'No'">Ask</button>`);
      case "/shadow":
        return html(`<div id="host"></div><script>const r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<button>Shadow action</button><span id=s>idle</span>';r.querySelector('button').onclick=()=>r.getElementById('s').textContent='shadow clicked'</script>`);
      case "/covered":
        return html(`<button id="b" onclick="this.textContent='Covered clicked'">Covered</button><div style="position:fixed;inset:0;background:rgba(0,0,0,.1)"></div>`);
      case "/list":
        return html(`<ul>${Array.from({ length: 80 }, (_, i) => `<li><a href="/item/${i}">Item number ${i}</a></li>`).join("")}</ul><button onclick="document.querySelector('li a').textContent='Changed first'">Mutate</button>`);
    }
    return new Response("not found", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
let port: DirectChromePort;
let engine: BrowserEngine;
const h = (op: string, args: Record<string, unknown> = {}) => engine.execute(op, args) as Promise<any>;
const state = async (tab: number, disableDiffing = false) => (await h("tab.ax.get", { tab, mode: "state", disableDiffing })).state as string;
const act = (tab: number, action: Record<string, unknown>) => h("tab.ax.action", { tab, action });
const idx = (text: string, re: RegExp) => {
  const m = re.exec(text);
  if (!m) throw new Error(`No match for ${re} in:\n${text}`);
  return Number(m[1]);
};

beforeAll(async () => {
  port = new DirectChromePort();
  await port.start();
  engine = new BrowserEngine(port);
});
afterAll(async () => {
  engine.dispose();
  await port.stop();
  server.stop(true);
  child.stop(true);
});

test("state has Codex header, stable indices and diffs after a click", async () => {
  const tab = (await h("tabs.new", { url: `${base}/form` })).id;
  const full = await state(tab);
  expect(full).toStartWith(`Browser tab: ${tab}, Title: "Fixture", URL: "${base}/form".`);
  expect(full).toContain("AXWebArea Fixture");
  expect(full).toContain("The focused UI element is");
  const button = idx(full, /(\d+) button Increment/);
  await act(tab, { kind: "click", target: button });
  const after = await state(tab);
  expect(after).toMatch(/Counter 1/);
  // Indices stay stable across captures.
  expect(after.includes(`${button} button Increment`) || !after.includes("button Increment")).toBe(true);
  // Small pages always return the full tree (a diff must save ≥1000 chars and ≥30%).
  expect(await state(tab)).toContain("AXWebArea Fixture");
  await h("tab.goto", { tab, url: `${base}/list` });
  await state(tab);
  expect(await state(tab)).toContain("There has been no change in the accessibility tree.");
}, 30000);

test("set_value, type_text, checkbox, select and Return submit navigate and settle", async () => {
  const tab = (await h("tabs.new", { url: `${base}/form` })).id;
  const s = await state(tab);
  const email = idx(s, /(\d+) text field[^\n]*Email/);
  const password = idx(s, /(\d+) (?:secure )?text field[^\n]*Password/);
  const country = idx(s, /(\d+) [^\n]*(?:pop up button|combo box)[^\n]*Country/);
  const agree = idx(s, /(\d+) checkbox[^\n]*Agree/);
  await act(tab, { kind: "set_value", element_index: email, value: "a@b" });
  await act(tab, { kind: "type_text", element_index: email, text: ".co" });
  await act(tab, { kind: "set_value", element_index: password, value: "hunter2" });
  await act(tab, { kind: "set_value", element_index: country, value: "France" });
  await act(tab, { kind: "click", target: agree });
  expect(await h("tab.evaluate", { tab, expression: "document.querySelector('[name=password]').value" })).toBe("hunter2");
  await act(tab, { kind: "press_key", element_index: email, key: "Return" });
  const done = await state(tab);
  expect(done).toContain("Done a@b.co fr on");
  expect(done).toContain(`${base}/done`);
}, 30000);

test("stale index from a previous page fails with fresh state attached", async () => {
  const tab = (await h("tabs.new", { url: `${base}/form` })).id;
  const s = await state(tab);
  const button = idx(s, /(\d+) button Increment/);
  await h("tab.goto", { tab, url: `${base}/done?email=x&country=y` });
  const err = await act(tab, { kind: "click", target: button }).catch((e) => e as Error);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/previous page|stale or missing/);
  expect((err as Error).message).toContain("Browser tab:");
}, 30000);

test("cross-origin iframe content is observable and clickable", async () => {
  const tab = (await h("tabs.new", { url: `${base}/frames` })).id;
  let s = "";
  for (let i = 0; i < 20 && !s.includes("Child button"); i++) {
    s = await state(tab, true);
    if (!s.includes("Child button")) await Bun.sleep(100);
  }
  const button = idx(s, /(\d+) button Child button/);
  await act(tab, { kind: "click", target: button });
  expect(await state(tab, true)).toContain("Child clicked");
}, 30000);

test("open shadow DOM is observable and clickable; covered elements fall back to el.click()", async () => {
  const tab = (await h("tabs.new", { url: `${base}/shadow` })).id;
  const s = await state(tab);
  await act(tab, { kind: "click", target: idx(s, /(\d+) button Shadow action/) });
  expect(await state(tab)).toContain("shadow clicked");
  await h("tab.goto", { tab, url: `${base}/covered` });
  const c = await state(tab);
  await act(tab, { kind: "click", target: idx(c, /(\d+) button Covered/) });
  expect(await state(tab)).toContain("Covered clicked");
}, 30000);

test("JS confirm dialogs render as a synthetic tree and are handled by index", async () => {
  const tab = (await h("tabs.new", { url: `${base}/dialog` })).id;
  const s = await state(tab);
  const err = await act(tab, { kind: "click", target: idx(s, /(\d+) button Ask/) }).then(() => null, (e) => e as Error);
  if (err) expect(err.message).toContain("dialog");
  const d = await state(tab);
  expect(d).toContain("Proceed?");
  await act(tab, { kind: "click", target: idx(d, /(\d+) button OK/) });
  expect(await state(tab, true)).toContain("Yes");
}, 30000);

test("scroll, screenshots in CSS pixels, and diffs on link-heavy pages", async () => {
  const tab = (await h("tabs.new", { url: `${base}/form` })).id;
  await state(tab);
  // Match the CSS visual viewport: non-overlay scrollbars occupy part of
  // innerWidth/innerHeight on Linux, but are not part of the captured page.
  const vp = await h("tab.evaluate", { tab, expression: "({w: Math.round(visualViewport.width), h: Math.round(visualViewport.height)})" });
  await act(tab, { kind: "scroll", target: [100, 100], direction: "down", pages: 1 });
  await Bun.sleep(200);
  expect(await h("tab.evaluate", { tab, expression: "scrollY" })).toBeGreaterThan(100);
  const shot = await h("tab.screenshot", { tab });
  expect(shot.mimeType).toBe("image/jpeg");
  expect(shot.width).toBe(vp.w);
  expect(shot.height).toBe(vp.h);
  expect(Buffer.from(shot.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
  await h("tab.goto", { tab, url: `${base}/list` });
  const list = await state(tab);
  await act(tab, { kind: "click", target: idx(list, /(\d+) button Mutate/) });
  const diff = await state(tab);
  expect(diff).toContain("The following is a diff from the previous accessibility tree");
  expect(diff).toContain("Changed first");
  expect(diff.length).toBeLessThan(list.length / 2);
}, 30000);
