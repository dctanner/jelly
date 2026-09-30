import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import { Computer } from "../src/server/computer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
