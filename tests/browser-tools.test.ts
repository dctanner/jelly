import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import { Computer } from "../src/server/computer";
import { mkdtempSync, rmSync, writeFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBrowserUploadFiles } from "../src/server/browser-upload";
import type { EventEmitter } from "node:events";
let browser: Browser;
const directory = mkdtempSync(join(tmpdir(), "jelly-browser-tools-test-"));
beforeAll(async () => {
  browser = await chromium.launch({
    executablePath: process.env.JELLY_BROWSER_PATH ?? "/usr/bin/google-chrome",
    headless: true,
  });
});
afterAll(async () => {
  await browser?.close();
  rmSync(directory, { recursive: true, force: true });
});
async function fixture() {
  const context = await browser.newContext({
    viewport: { width: 640, height: 480 },
  });
  const computer = new Computer(directory);
  const internal = computer as unknown as {
    status: string;
    context: BrowserContext;
    trackPage(page: Page): void;
    tail: Promise<unknown>;
  };
  internal.status = "ready";
  internal.context = context;
  context.on("page", (page) => internal.trackPage(page));
  const page = await context.newPage();
  await page.setContent(
    '<h1>Visible fixture</h1><input id="normal" value="PRIVATE_VALUE"><input type="password" value="PASSWORD_VALUE"><input type="hidden" value="HIDDEN_VALUE"><button onclick="this.textContent=\'Clicked\'">Go</button><div hidden>HIDDEN_TEXT</div>',
  );
  return { computer, context, page, internal };
}
type Snapshot = {
  pageId: string;
  observationId: string;
  text: string;
  viewport: { width: number; height: number };
  elements: { ref: string; tag: string; type: string }[];
};
const snapshot = (c: Computer) => c.action("snapshot") as Promise<Snapshot>;
test("real Chromium snapshot bounds, avoids values, and uses exact node references", async () => {
  const f = await fixture();
  try {
    const s = await snapshot(f.computer);
    expect(s.viewport).toMatchObject({ width: 640, height: 480 });
    expect(JSON.stringify(s)).not.toMatch(
      /PRIVATE_VALUE|PASSWORD_VALUE|HIDDEN_VALUE|HIDDEN_TEXT/,
    );
    const field = s.elements.find(
      (e) => e.tag === "input" && e.type !== "password",
    )!;
    await f.computer.action("fill", { ref: field.ref, text: "Updated" });
    expect(await f.page.locator("#normal").inputValue()).toBe("Updated");
    await expect(
      f.computer.action("fill", {
        ref: s.elements.find((e) => e.type === "password")!.ref,
        text: "no",
      }),
    ).rejects.toThrow("request_browser_login");
    const button = s.elements.find((e) => e.tag === "button")!;
    await expect(f.computer.action("click", { ref: button.ref, x: 1, y: 1 })).rejects.toThrow("reference OR coordinates");
    await expect(f.computer.action("click", { x: 1 })).rejects.toThrow();
    await expect(f.computer.action("click", {})).rejects.toThrow();
    await f.page.locator("button").evaluate((el) => {
      el.outerHTML = "<button>Replacement</button>";
    });
    await expect(
      f.computer.action("click", { ref: button.ref }),
    ).rejects.toThrow();
    await f.page.setContent("<p>" + "bounded ".repeat(4000) + "</p>");
    expect((await snapshot(f.computer)).text.length).toBeLessThanOrEqual(12000);
  } finally {
    await f.computer.close();
  }
});
test("references are session-local and navigation/tab changes expire them; popup IDs stay session scoped", async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    const s = await snapshot(a.computer),
      ref = s.elements[0]!.ref;
    await expect(b.computer.action("click", { ref })).rejects.toThrow(
      "foreign",
    );
    await expect(
      b.computer.action("tabs", { operation: "select", pageId: s.pageId }),
    ).rejects.toThrow("Unknown");
    await a.computer.action("tabs", { operation: "new" });
    await expect(a.computer.action("click", { ref })).rejects.toThrow("Stale");
    await a.computer.action("tabs", { operation: "select", pageId: s.pageId });
    const fresh = await snapshot(a.computer);
    await a.page.goto("about:blank#navigation");
    await expect(
      a.computer.action("click", { ref: fresh.elements[0]!.ref }),
    ).rejects.toThrow();
    await a.page.evaluate(() => window.open("about:blank"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const tabs = (await a.computer.action("tabs", { operation: "list" })) as {
      tabs: { pageId: string; active: boolean }[];
    };
    expect(tabs.tabs.length).toBe(3);
    await a.computer.action("tabs", {
      operation: "close",
      pageId: tabs.tabs.find((t) => t.active)!.pageId,
    });
  } finally {
    await a.computer.close();
    await b.computer.close();
  }
});
test("diagnostics redact arbitrary secrets and never return cached events during human control", async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => {
      for (let i = 0; i < 70; i++)
        console.error(
          "password=SECRET https://user:pass@example.com/?token=SECRET",
        );
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const diagnostics = (await f.computer.action("diagnostics")) as {
      entries: unknown[];
    };
    expect(diagnostics.entries.length).toBe(50);
    expect(JSON.stringify(diagnostics)).not.toContain("SECRET");
    await f.computer.take("human");
    await expect(f.computer.action("diagnostics")).rejects.toThrow("person");
    await f.page.evaluate(() => console.error("human private error"));
    await f.computer.release("human");
    expect(
      ((await f.computer.action("diagnostics")) as { entries: unknown[] })
        .entries,
    ).toEqual([]);
  } finally {
    await f.computer.close();
  }
});
test("bounded waits, cancellation and queued ownership generation checks", async () => {
  const f = await fixture();
  try {
    expect(
      await f.computer.action("wait_for", {
        condition: "text",
        text: "Visible",
      }),
    ).toEqual({ matched: true });
    expect(
      await f.computer.action("wait_for", {
        condition: "text",
        text: "absent",
        timeoutMs: 0,
      }),
    ).toEqual({ matched: false });
    await expect(
      f.computer.action("wait_for", { condition: "ready", timeoutMs: 10001 }),
    ).rejects.toThrow("Timeout");
    const controller = new AbortController();
    const waiting = f.computer
      .action(
        "wait_for",
        { condition: "text", text: "never", timeoutMs: 10000 },
        controller.signal,
      )
      .catch(() => "discarded");
    setTimeout(() => controller.abort(), 30);
    expect(await waiting).toBe("discarded");
    let resume!: () => void;
    f.internal.tail = new Promise((resolve) => {
      resume = () => resolve(undefined);
    });
    const queued = f.computer
      .action("scroll", { y: 100 })
      .catch(() => "discarded");
    const taking = f.computer.take("human");
    resume();
    expect(await queued).toBe("discarded");
    await taking;
    await f.computer.release("human");
  } finally {
    await f.computer.close();
  }
});

test("reference click, secret-name rejection, failed requests and in-flight handoff", async () => {
  const f = await fixture();
  try {
    let s = await snapshot(f.computer);
    await f.computer.action("click", { ref: s.elements.find(e => e.tag === "button")!.ref });
    expect(await f.page.locator("button").innerText()).toBe("Clicked");
    await f.page.locator("#normal").evaluate(el => el.setAttribute("name", "api_token"));
    await expect(f.computer.action("fill", { ref: s.elements[0]!.ref, text: "blocked" })).rejects.toThrow("request_browser_login");
    await f.context.route("https://fixture.invalid/**", route => route.abort());
    await f.page.evaluate(() => { void fetch("https://fixture.invalid/?secret=PRIVATE").catch(() => {}); });
    await new Promise(resolve => setTimeout(resolve, 100));
    const diagnostic = JSON.stringify(await f.computer.action("diagnostics"));
    expect(diagnostic).toContain("requestfailed");
    expect(diagnostic).not.toContain("PRIVATE");
    const waiting = f.computer.action("wait_for", { condition: "text", text: "never appears", timeoutMs: 10000 }).catch(() => "discarded");
    await new Promise(resolve => setTimeout(resolve, 30));
    const taking = f.computer.take("human");
    expect(await waiting).toBe("discarded");
    await taking;
    await f.computer.release("human");
    await expect(f.computer.action("click", { ref: s.elements[0]!.ref })).rejects.toThrow("Stale");
    await f.computer.action("scroll", { x: 0, y: 100 });
    await expect(f.computer.action("scroll", { y: 10001 })).rejects.toThrow("10000");
  } finally { await f.computer.close(); }
});

test("text wait rejects an observation invalidated by navigation before delivery", async () => {
  const f = await fixture();
  const evaluate = f.page.evaluate.bind(f.page);
  try {
    await f.page.setContent("<p>OLD_DOCUMENT_MARKER</p>");
    let intercepted = false;
    f.page.evaluate = (async (...args: any[]) => {
      const result = await (evaluate as any)(...args);
      if (!intercepted && result?.text?.includes("OLD_DOCUMENT_MARKER")) {
        intercepted = true;
        await f.page.goto("data:text/html,<p>NEW_DOCUMENT_MARKER</p>");
      }
      return result;
    }) as typeof f.page.evaluate;
    await expect(f.computer.action("wait_for", {
      condition: "text", text: "OLD_DOCUMENT_MARKER", timeoutMs: 0,
    })).rejects.toThrow("Page changed");
    expect(intercepted).toBe(true);
    expect(await f.page.locator("body").innerText()).toContain("NEW_DOCUMENT_MARKER");
  } finally { await f.computer.close(); }
});

test("snapshot and labels exclude offscreen text ranges and hidden descendants", async () => {
  const f = await fixture();
  try {
    await f.page.setContent(`<button>Visible label<span aria-hidden="true">ARIA_SECRET</span><span hidden>HIDDEN_SECRET</span><span contenteditable>EDIT_SECRET</span></button><p style="width:200px;line-height:24px">Visible paragraph ${"line<br>".repeat(50)}OFFSCREEN_MARKER</p>`);
    const s = await snapshot(f.computer);
    expect(s.text).toContain("Visible paragraph");
    expect(JSON.stringify(s)).not.toMatch(/ARIA_SECRET|HIDDEN_SECRET|EDIT_SECRET|OFFSCREEN_MARKER/);
    expect((s.elements.find(e => e.tag === "button") as any).label).toBe("Visible label");
    await f.page.setContent(`<p style="width:100px;line-height:24px">START ${"word ".repeat(500)}TEXT_NODE_OFFSCREEN</p>`);
    expect((await snapshot(f.computer)).text).not.toContain("TEXT_NODE_OFFSCREEN");
  } finally { await f.computer.close(); }
});

test("upload selects real image/video files through a hidden chooser and fires change", async () => {
  const f = await fixture();
  const image = join(directory, "kiwi.png");
  const video = join(directory, "kiwi.mp4");
  writeFileSync(image, Buffer.from("89504e470d0a1a0a", "hex"));
  writeFileSync(video, Buffer.from("000000146674797069736f6d0000000069736f6d", "hex"));
  try {
    await f.page.setContent(`<button onclick="document.querySelector('input').click()">Upload media</button>
      <input type="file" multiple hidden onchange="document.querySelector('output').textContent = this.files.length">
      <output></output>`);
    const s = await snapshot(f.computer);
    expect(s.elements.some(e => e.type === "file")).toBe(false);
    expect(await f.computer.action("upload", {
      ref: s.elements.find(e => e.tag === "button")!.ref, paths: [image, video],
    })).toMatchObject({
      ok: true, files: [{ name: "kiwi.png", size: 8 }, { name: "kiwi.mp4", size: 20 }],
    });
    expect(await f.page.locator("output").innerText()).toBe("2");
    const uploaded = await f.page.locator("input").evaluate(async el =>
      Promise.all(Array.from((el as HTMLInputElement).files!).map(async file => ({
        name: file.name, size: file.size, type: file.type,
        bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
      }))));
    expect(uploaded[0]).toMatchObject({ name: "kiwi.png", type: "image/png", bytes: [137, 80, 78, 71, 13, 10, 26, 10] });
    expect(uploaded[1]).toMatchObject({ name: "kiwi.mp4", type: "video/mp4", size: 20 });
    expect((f.page as unknown as EventEmitter).listenerCount("filechooser")).toBe(0);
  } finally { await f.computer.close(); }
});

test("menu-item uploads keep the exact transient chooser input even after the site detaches it", async () => {
  const f = await fixture();
  const source = join(directory, "transient-upload.mp4");
  writeFileSync(source, "authorized transient video fixture");
  try {
    await f.page.setContent(`<div role="menuitem" onclick="
      const input = document.createElement('input'); input.type = 'file';
      input.hidden = true; window.originalUpload = input;
      input.onchange = () => document.querySelector('output').textContent = input.files.length;
      document.body.append(input); input.click(); input.remove();
      const decoy = document.createElement('input'); decoy.type = 'file';
      decoy.id = 'replacement'; decoy.hidden = true; document.body.append(decoy);
    ">Upload cover or video<span hidden>HIDDEN_UPLOAD_SECRET</span></div><output></output>`);
    const s = await snapshot(f.computer);
    const target = s.elements.find(e => (e as { label?: string }).label === "Upload cover or video")!;
    expect(target).toBeDefined();
    expect(JSON.stringify(s)).not.toContain("HIDDEN_UPLOAD_SECRET");
    await f.computer.action("upload", { ref: target.ref, paths: [source] });
    expect(await f.page.locator("output").innerText()).toBe("1");
    expect(await f.page.evaluate(async () => {
      const input = (window as unknown as { originalUpload: HTMLInputElement }).originalUpload;
      return { attached: input.isConnected, text: await input.files![0]!.text() };
    })).toEqual({ attached: false, text: "authorized transient video fixture" });
    expect(await f.page.locator("#replacement").evaluate(el => (el as HTMLInputElement).files!.length)).toBe(0);
    expect((f.page as unknown as EventEmitter).listenerCount("filechooser")).toBe(0);
  } finally { await f.computer.close(); }
});

test("transient chooser inputs do not bypass human ownership checks", async () => {
  const f = await fixture();
  const source = join(directory, "transient-handoff.txt");
  writeFileSync(source, "authorized fixture");
  let taking: Promise<unknown> | undefined;
  try {
    await f.page.setContent(`<button onclick="
      const input = document.createElement('input'); input.type = 'file';
      window.originalUpload = input; document.body.append(input); input.click(); input.remove();
    ">Upload</button>`);
    f.page.once("filechooser", () => { taking = f.computer.take("human"); });
    const ref = (await snapshot(f.computer)).elements[0]!.ref;
    await expect(f.computer.action("upload", { ref, paths: [source] })).rejects.toThrow();
    await taking;
    expect(await f.page.evaluate(() =>
      (window as unknown as { originalUpload: HTMLInputElement }).originalUpload.files!.length)).toBe(0);
    expect((f.page as unknown as EventEmitter).listenerCount("filechooser")).toBe(0);
    await f.computer.release("human");
  } finally { await taking; await f.computer.close(); }
});

test("upload handles visible inputs and rejects wrong, stale, foreign and single-file targets", async () => {
  const a = await fixture(), b = await fixture();
  const path = join(directory, "upload.txt");
  writeFileSync(path, "public upload");
  try {
    await a.page.setContent('<input type="file">');
    const ref = (await snapshot(a.computer)).elements[0]!.ref;
    await expect(b.computer.action("upload", { ref, paths: [path] })).rejects.toThrow("foreign");
    await expect(a.computer.action("upload", { ref, paths: [path, path] })).rejects.toThrow("one file");
    await a.computer.action("upload", { ref, paths: [path] });
    expect(await a.page.locator("input").evaluate(el => (el as HTMLInputElement).files![0]!.name)).toBe("upload.txt");
    await a.page.locator("input").evaluate(el => el.outerHTML = '<input type="file">');
    await expect(a.computer.action("upload", { ref, paths: [path] })).rejects.toThrow("changed");
    const next = (await snapshot(a.computer)).elements[0]!.ref;
    await a.page.goto("about:blank#new");
    await expect(a.computer.action("upload", { ref: next, paths: [path] })).rejects.toThrow("Stale");
  } finally { await a.computer.close(); await b.computer.close(); }
});

test("upload reads are bounded, regular-file-only, immutable and cancellable", async () => {
  const source = join(directory, "buffered.txt");
  writeFileSync(source, "original");
  const guard = () => {};
  for (const paths of [[], ["relative"], [source + "\0"], new Array(11).fill(source)])
    await expect(readBrowserUploadFiles(paths, guard)).rejects.toThrow("paths");
  await expect(readBrowserUploadFiles([directory], guard)).rejects.toThrow("regular");
  const files = await readBrowserUploadFiles([source], guard);
  writeFileSync(source, "changed source");
  expect(files[0]!.buffer.toString()).toBe("original");
  let checks = 0;
  await expect(readBrowserUploadFiles([source], () => {
    if (++checks > 3) throw new Error("cancelled");
  })).rejects.toThrow("cancelled");
  truncateSync(source, 51 * 1024 * 1024);
  await expect(readBrowserUploadFiles([source], guard)).rejects.toThrow("50 MiB");
});

test("buffer-backed selection survives source removal and reaches an HTTP upload endpoint", async () => {
  const f = await fixture();
  const source = join(directory, "http-upload.txt");
  writeFileSync(source, "authorized fixture bytes");
  let received = "";
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method === "POST") {
        const form = await request.formData();
        const file = form.get("asset") as File;
        received = `${file.name}:${await file.text()}`;
        return new Response("uploaded");
      }
      return new Response(`<form><input type="file" name="asset"></form>
        <button onclick="fetch('/', {method:'POST',body:new FormData(document.querySelector('form'))}).then(r=>r.text()).then(t=>document.querySelector('output').textContent=t)">Send</button><output></output>`,
        { headers: { "Content-Type": "text/html" } });
    },
  });
  try {
    await f.computer.action("open", { url: server.url.href });
    const ref = (await snapshot(f.computer)).elements.find(e => e.type === "file")!.ref;
    await f.computer.action("upload", { ref, paths: [source] });
    rmSync(source);
    await f.page.locator("button").click();
    await f.page.waitForFunction(() => document.querySelector("output")?.textContent === "uploaded");
    expect(received).toBe("http-upload.txt:authorized fixture bytes");
  } finally { server.stop(true); await f.computer.close(); }
});

test("chooser timeout removes interception without selecting anything", async () => {
  const f = await fixture();
  const path = join(directory, "no-chooser.txt");
  writeFileSync(path, "public");
  try {
    await f.page.setContent('<div role="button">Not an upload button</div>');
    const s = await snapshot(f.computer);
    expect((s.elements[0] as { label?: string }).label).toBe("Not an upload button");
    await expect(f.computer.action("upload", {
      ref: s.elements[0]!.ref, paths: [path],
    })).rejects.toThrow("No file chooser");
    expect((f.page as unknown as EventEmitter).listenerCount("filechooser")).toBe(0);
  } finally { await f.computer.close(); }
}, 10000);

test("handoff and abort cancel chooser waits, remove interception, and never select a file", async () => {
  const f = await fixture();
  const path = join(directory, "cancel-upload.txt");
  writeFileSync(path, "public");
  try {
    for (const mode of ["handoff", "abort", "navigation"] as const) {
      await f.page.setContent('<button onclick="this.textContent=\'waiting\'">Upload</button><input type="file" hidden>');
      const ref = (await snapshot(f.computer)).elements[0]!.ref;
      const controller = new AbortController();
      const pending = f.computer.action("upload", { ref, paths: [path] }, controller.signal).catch(() => "discarded");
      await f.page.waitForFunction(() => document.querySelector("button")?.textContent === "waiting");
      let taking: Promise<unknown> | undefined;
      if (mode === "handoff") taking = f.computer.take("human");
      else if (mode === "abort") controller.abort();
      else await f.page.goto("about:blank#cancel-upload");
      expect(await pending).toBe("discarded");
      expect((f.page as unknown as EventEmitter).listenerCount("filechooser")).toBe(0);
      if (mode === "handoff") {
        await taking;
        await expect(f.computer.action("upload", { ref, paths: [path] })).rejects.toThrow("person");
        await f.computer.release("human");
      }
      if (mode !== "navigation")
        expect(await f.page.locator("input").evaluate(el => (el as HTMLInputElement).files!.length)).toBe(0);
    }
  } finally { await f.computer.close(); }
});
