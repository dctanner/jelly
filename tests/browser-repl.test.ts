import { afterEach, describe, expect, test } from "bun:test";
import { BrowserRepl, type ReplResult } from "../src/server/browser/repl";
import { transformCell } from "../src/server/browser/repl-worker";
import { createBrowserApi } from "../src/server/browser/client-api";
import {
  BROWSER_GUIDANCE,
  BROWSER_JS_DESCRIPTION,
} from "../src/server/browser/repl-docs";

type Call = { op: string; args: Record<string, unknown> };

function fakeHost(
  responses: Record<string, (args: Record<string, unknown>) => unknown> = {},
) {
  const calls: Call[] = [];
  const signals: AbortSignal[] = [];
  const host = async (
    op: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => {
    calls.push({ op, args });
    signals.push(signal);
    const respond = responses[op];
    return respond ? respond(args) : undefined;
  };
  return { host, calls, signals };
}

const repls: BrowserRepl[] = [];
function makeRepl(
  responses?: Record<string, (args: Record<string, unknown>) => unknown>,
) {
  const fake = fakeHost(responses);
  const repl = new BrowserRepl(fake.host);
  repls.push(repl);
  return { repl, ...fake };
}
afterEach(() => {
  for (const repl of repls.splice(0)) repl.close();
});

const text = (result: ReplResult) =>
  result.items
    .map((item) =>
      item.type === "text" ? item.text : `[image ${item.mimeType}]`,
    )
    .join("\n");

describe("BrowserRepl cells", () => {
  test("const/let/var/function/class persist across cells", async () => {
    const { repl } = makeRepl();
    const first = await repl.run(
      "const a = 1; let { b, c: [d] } = { b: 2, c: [3] }; var e = 4;\nfunction f(x) { return x * 2 }\nclass K { v = 9 }",
    );
    expect(first).toEqual({ items: [] });
    expect(text(await repl.run("f(a) + b + d + e + new K().v"))).toBe("20");
    // reassign and redeclare both work
    expect(text(await repl.run("b = 10; const a = 100; a + b"))).toBe("110");
    expect(text(await repl.run("let unset; typeof unset"))).toBe("undefined");
  });

  test("function declarations are hoisted within the cell", async () => {
    const { repl } = makeRepl();
    expect(
      text(await repl.run("const v = g();\nfunction g() { return 7 }\nv")),
    ).toBe("7");
    expect(text(await repl.run("g() + v"))).toBe("14");
  });

  test("top-level await and final expression value", async () => {
    const { repl } = makeRepl();
    const result = await repl.run(
      "const x = await new Promise((r) => setTimeout(() => r(21), 5));\nx * 2",
    );
    expect(text(result)).toBe("42");
    expect(
      text(
        await repl.run(
          "await sleep(1); ({ nested: { list: [1, 2] }, s: 'q' })",
        ),
      ),
    ).toBe("{ nested: { list: [ 1, 2 ] }, s: 'q' }");
    expect(text(await repl.run("{ a: 1 }"))).toBe("{ a: 1 }");
    expect((await repl.run("undefined")).items).toEqual([]);
    expect(text(await repl.run("'multi\\nline'"))).toBe("multi\nline");
  });

  test("captures console, display and nodeRepl.write in order", async () => {
    const { repl } = makeRepl();
    const result = await repl.run(
      [
        "console.log('one', { a: 1 });",
        "display({ data: 'AAAA', mimeType: 'image/png' });",
        "console.warn('two');",
        "nodeRepl.write('three');",
        "console.error(new Error('x').message);",
        "display('data:image/jpeg;base64,QkJC');",
        "'last'",
      ].join("\n"),
    );
    expect(result.items).toEqual([
      { type: "text", text: "one { a: 1 }" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "text", text: "two\nthree\nx" },
      { type: "image", mimeType: "image/jpeg", data: "QkJC" },
      { type: "text", text: "last" },
    ]);
  });

  test("displays Uint8Array image data as base64 and truncates long text", async () => {
    const { repl } = makeRepl();
    const result = await repl.run(
      "display({ data: new Uint8Array([66, 66, 66]), mimeType: 'image/png' }); 'x'.repeat(100005)",
    );
    expect(result.items[0]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: "QkJC",
    });
    const last = result.items[1];
    expect(last?.type).toBe("text");
    if (last?.type === "text") {
      expect(last.text.endsWith("…[truncated 5 chars]")).toBe(true);
      expect(last.text.length).toBe(100_000 + "…[truncated 5 chars]".length);
    }
  });

  test("errors report message and cell-only stack; output before the error is kept", async () => {
    const { repl } = makeRepl();
    const result = await repl.run(
      "console.log('before');\nfunction boom() { throw new TypeError('bad') }\n\nboom()",
    );
    expect(text(result)).toBe("before");
    expect(result.error).toStartWith("TypeError: bad\n");
    expect(result.error).toContain("at boom (cell-1:2:");
    expect(result.error).toContain("cell-1:4:");
    expect(result.error).not.toContain("repl-worker");
    expect(result.reset).toBeUndefined();
    // state survives errors
    expect(text(await repl.run("typeof boom"))).toBe("function");
    expect((await repl.run("throw 'plain'")).error).toBe("Uncaught 'plain'");
  });

  test("syntax errors point at the cell source", async () => {
    const { repl } = makeRepl();
    const result = await repl.run("const ok = 1;\nlet x = ;");
    expect(result.error).toBe(
      "SyntaxError: Unexpected token (2:8)\nlet x = ;\n        ^",
    );
  });

  test("timeout resets state and keeps partial output", async () => {
    const { repl } = makeRepl();
    await repl.run("const keep = 1");
    const hung = await repl.run(
      "console.log('partial'); await new Promise(() => {})",
      { timeoutMs: 300 },
    );
    expect(text(hung)).toBe("partial");
    expect(hung.reset).toBe(true);
    expect(hung.error).toContain("timed out after 300 ms");
    expect(hung.error).toContain("REPL was restarted");
    expect(text(await repl.run("typeof keep"))).toBe("undefined");
  });

  test("timeout aborts in-flight host ops", async () => {
    let aborted = false;
    const repl = new BrowserRepl(
      (_op, _args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    repls.push(repl);
    const result = await repl.run("await browser.nameSession('x')", {
      timeoutMs: 200,
    });
    expect(result.reset).toBe(true);
    expect(aborted).toBe(true);
  });

  test("hung synchronous loop is terminated", async () => {
    const { repl } = makeRepl();
    await repl.run("let before = 'set'");
    const started = Date.now();
    const result = await repl.run("console.log('spinning'); while (true) {}", {
      timeoutMs: 300,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.reset).toBe(true);
    expect(text(result)).toBe("spinning");
    expect(text(await repl.run("typeof before"))).toBe("undefined");
    expect(text(await repl.run("1 + 1"))).toBe("2");
  });

  test("abort signal resets; pre-aborted run never starts", async () => {
    const { repl } = makeRepl();
    await repl.run("const s = 1");
    const pre = new AbortController();
    pre.abort();
    const skipped = await repl.run("s", { signal: pre.signal });
    expect(skipped.reset).toBeUndefined();
    expect(text(await repl.run("s"))).toBe("1");
    const controller = new AbortController();
    const running = repl.run("await new Promise(() => {})", {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await running;
    expect(result.reset).toBe(true);
    expect(result.error).toContain("interrupted");
  });

  test("concurrent runs are queued and executed in order", async () => {
    const { repl } = makeRepl();
    await repl.run("let log = []");
    const a = repl.run("await sleep(50); log.push('a'); log.join(',')");
    const b = repl.run("log.push('b'); log.join(',')");
    expect(text(await a)).toBe("a");
    expect(text(await b)).toBe("a,b");
  });

  test("reset() and close()", async () => {
    const { repl } = makeRepl();
    await repl.run("const r = 1");
    repl.reset();
    expect(text(await repl.run("typeof r"))).toBe("undefined");
    const pending = repl.run("await new Promise(() => {})");
    await Bun.sleep(50);
    repl.reset();
    expect((await pending).reset).toBe(true);
    repl.close();
    expect((await repl.run("1")).error).toContain("closed");
  });

  test("unawaited rejections and background output are reported", async () => {
    const { repl } = makeRepl();
    const result = await repl.run(
      "Promise.reject(new Error('lost')); await sleep(20)",
    );
    // `bun run` reports it as output; under `bun test` workers treat unhandled rejections as fatal,
    // which the host turns into a reset with the error message.
    if (result.reset) expect(result.error).toContain("lost");
    else
      expect(text(result)).toContain(
        "Unhandled promise rejection: Error: lost",
      );
    await repl.run("setTimeout(() => console.log('later'), 10)");
    await Bun.sleep(40);
    expect(text(await repl.run("1"))).toContain("later");
  });

  test("host errors surface as REPL errors", async () => {
    const { repl } = makeRepl({
      "tab.goto": () => {
        throw new Error("Navigation failed: net::ERR_NAME_NOT_RESOLVED");
      },
      "tabs.get": (args) => ({ id: args.id, title: "T", url: "https://t" }),
    });
    const result = await repl.run(
      "const tab = await browser.tabs.get(4); await tab.goto('https://nope')",
    );
    expect(result.error).toStartWith(
      "Error: Navigation failed: net::ERR_NAME_NOT_RESOLVED",
    );
    expect(
      text(
        await repl.run(
          "let caught; try { await tab.goto('x') } catch (e) { caught = e }\ncaught instanceof Error",
        ),
      ),
    ).toBe("true");
  });
});

describe("client API op mapping (through the worker)", () => {
  test("every method maps to the documented op and args", async () => {
    const info = (id: number) => ({
      id,
      title: `T${id}`,
      url: `https://t/${id}`,
    });
    const { repl, calls } = makeRepl({
      "tabs.list": () => [info(1), info(2)],
      "tabs.new": () => info(3),
      "tabs.get": (args) => info(args.id as number),
      "user.openTabs": () => [
        { id: 9, title: "U", url: "https://u", lastAccessed: 1 },
      ],
      "user.claimTab": (args) => ({
        ...info(args.id as number),
        origin: "user",
      }),
      "tab.info": (args) => ({
        id: args.tab,
        title: "Fresh",
        url: "https://fresh",
      }),
      "tab.ax.get": (args) =>
        args.mode === "state"
          ? { state: "STATE" }
          : args.mode === "screenshot"
            ? { screenshot: { data: "SS", mimeType: "image/jpeg" } }
            : {
                state: "STATE",
                screenshot: { data: "SS", mimeType: "image/jpeg" },
              },
      "tab.screenshot": () => ({
        data: "QQ",
        mimeType: "image/jpeg",
        width: 10,
        height: 5,
      }),
      chrome: (args) => ({ echoed: args }),
      "tab.evaluate": () => ({ ok: 1 }),
    });
    const code = `
await browser.nameSession("🔎 test");
const listed = await browser.tabs.list();
const again = await browser.tabs.list();
console.log(listed[0] === again[0], Array.isArray(listed), listed instanceof Array);
const tab = await browser.tabs.new("https://new");
await browser.tabs.new();
const got = await browser.tabs.get("1");
console.log(got === listed[0]);
const userTabs = await browser.user.openTabs();
const claimed = await browser.user.claimTab(userTabs[0]);
await browser.user.claimTab(9);
console.log(claimed.id, claimed.lastInfo.origin);
const chromeResult = await browser.chrome.tabs.query({ active: true });
console.log(JSON.stringify(chromeResult));
console.log(tab.lastInfo.url, await tab.url(), await tab.title(), tab.lastInfo.title);
await tab.goto("https://a", { timeoutMs: 5 });
await tab.goto("https://b");
await tab.back(); await tab.forward(); await tab.reload();
await tab.show();
await tab.markDeliverable(); await tab.markHandoff(); await tab.unmark();
const shot = await tab.screenshot({ fullPage: true });
await tab.screenshot({ clip: { x: 1, y: 2, width: 3, height: 4 } });
display(shot);
console.log(JSON.stringify(await tab.evaluate("document.title")));
await tab.evaluate((a) => a + 1, 41);
await tab.evaluate(function () { return this.value }, undefined, { elementIndex: 7 });
await tab.setFiles(5, ["/tmp/a.txt", "/tmp/b.txt"]);
await tab.setFiles(5, "/tmp/c.txt");
await tab.dialog();
await tab.handleDialog(true, "yes");
await tab.handleDialog(false);
await tab.waitForLoad("networkidle", { timeoutMs: 100 });
await tab.waitForLoad();
await tab.cdp.send("Runtime.evaluate", { expression: "1" }, { sessionId: "S1" });
await tab.cdp.send("Page.enable");
await tab.cdp.events({ afterSequence: 4, methods: ["Network.requestWillBeSent"], limit: 10, timeoutMs: 50 });
console.log(await tab.ax.get());
console.log(JSON.stringify(await tab.ax.get("screenshot")));
await tab.ax.write();
await tab.ax.write("both", { disableDiffing: true });
await tab.ax.write("screenshot");
await tab.ax.click(42);
await tab.ax.click([10, 20], { mouseButton: "r", clickCount: 2, key: "super", duration: 0.5 });
await tab.ax.setValue(3, "v");
await tab.ax.typeText(null, "hello");
await tab.ax.typeText(4, "hi");
await tab.ax.paste(null, "p", { format: "md" });
await tab.ax.pressKey(null, "Return");
await tab.ax.pressKey(6, "a", { duration: 1 });
await tab.ax.scroll(8, "d", 2);
await tab.ax.scroll([1, 2], "up");
await tab.ax.selectText(9, "txt", { prefix: "a", suffix: "b", selectionType: "cursor_after" });
await tab.ax.performSecondaryAction(10, "Expand");
await tab.ax.drag([0, 0], [5, 5]);
await tab.ax.hover(11);
await tab.close();
const relisted = await browser.tabs.list();
console.log(relisted.length);
`;
    const result = await repl.run(code);
    expect(result.error).toBeUndefined();
    const T = 3;
    expect(calls).toEqual([
      { op: "nameSession", args: { name: "🔎 test" } },
      { op: "tabs.list", args: {} },
      { op: "tabs.list", args: {} },
      { op: "tabs.new", args: { url: "https://new" } },
      { op: "tabs.new", args: {} },
      { op: "tabs.get", args: { id: 1 } },
      { op: "user.openTabs", args: {} },
      { op: "user.claimTab", args: { id: 9 } },
      { op: "user.claimTab", args: { id: 9 } },
      {
        op: "chrome",
        args: { namespace: "tabs", method: "query", args: [{ active: true }] },
      },
      { op: "tab.info", args: { tab: T } },
      { op: "tab.info", args: { tab: T } },
      { op: "tab.goto", args: { tab: T, url: "https://a", timeoutMs: 5 } },
      { op: "tab.goto", args: { tab: T, url: "https://b" } },
      { op: "tab.back", args: { tab: T } },
      { op: "tab.forward", args: { tab: T } },
      { op: "tab.reload", args: { tab: T } },
      { op: "tab.show", args: { tab: T } },
      { op: "tab.mark", args: { tab: T, mark: "deliverable" } },
      { op: "tab.mark", args: { tab: T, mark: "handoff" } },
      { op: "tab.mark", args: { tab: T, mark: null } },
      { op: "tab.screenshot", args: { tab: T, fullPage: true } },
      {
        op: "tab.screenshot",
        args: { tab: T, clip: { x: 1, y: 2, width: 3, height: 4 } },
      },
      { op: "tab.evaluate", args: { tab: T, expression: "document.title" } },
      {
        op: "tab.evaluate",
        args: { tab: T, functionDeclaration: "(a) => a + 1", arg: 41 },
      },
      {
        op: "tab.evaluate",
        args: {
          tab: T,
          functionDeclaration: "function () { return this.value }",
          elementIndex: 7,
        },
      },
      {
        op: "tab.setFiles",
        args: { tab: T, element_index: 5, paths: ["/tmp/a.txt", "/tmp/b.txt"] },
      },
      {
        op: "tab.setFiles",
        args: { tab: T, element_index: 5, paths: ["/tmp/c.txt"] },
      },
      { op: "tab.dialog", args: { tab: T } },
      {
        op: "tab.handleDialog",
        args: { tab: T, accept: true, promptText: "yes" },
      },
      { op: "tab.handleDialog", args: { tab: T, accept: false } },
      {
        op: "tab.waitForLoad",
        args: { tab: T, state: "networkidle", timeoutMs: 100 },
      },
      { op: "tab.waitForLoad", args: { tab: T } },
      {
        op: "tab.cdp",
        args: {
          tab: T,
          method: "Runtime.evaluate",
          params: { expression: "1" },
          sessionId: "S1",
        },
      },
      { op: "tab.cdp", args: { tab: T, method: "Page.enable" } },
      {
        op: "tab.cdp.events",
        args: {
          tab: T,
          afterSequence: 4,
          methods: ["Network.requestWillBeSent"],
          limit: 10,
          timeoutMs: 50,
        },
      },
      { op: "tab.ax.get", args: { tab: T, mode: "state" } },
      { op: "tab.ax.get", args: { tab: T, mode: "screenshot" } },
      { op: "tab.ax.get", args: { tab: T, mode: "state" } },
      {
        op: "tab.ax.get",
        args: { tab: T, mode: "both", disableDiffing: true },
      },
      { op: "tab.ax.get", args: { tab: T, mode: "screenshot" } },
      {
        op: "tab.ax.action",
        args: { tab: T, action: { kind: "click", target: 42 } },
      },
      {
        op: "tab.ax.action",
        args: {
          tab: T,
          action: {
            kind: "click",
            target: [10, 20],
            mouseButton: "right",
            clickCount: 2,
            key: "super",
            duration: 0.5,
          },
        },
      },
      {
        op: "tab.ax.action",
        args: {
          tab: T,
          action: { kind: "set_value", element_index: 3, value: "v" },
        },
      },
      {
        op: "tab.ax.action",
        args: {
          tab: T,
          action: { kind: "type_text", element_index: null, text: "hello" },
        },
      },
      {
        op: "tab.ax.action",
        args: {
          tab: T,
          action: { kind: "type_text", element_index: 4, text: "hi" },
        },
      },
      {
        op: "tab.ax.action",
        args: {
          tab: T,
          action: {
            kind: "paste",
            element_index: null,
            text: "p",
            format: "md",
          },
        },
      },
      {
        op: "tab.ax.action",
        args: {
          tab: T,
          action: { kind: "press_key", element_index: null, key: "Return" },
        },
      },
      {
        op: "tab.ax.action",
        args: {
          tab: T,
          action: {
            kind: "press_key",
            element_index: 6,
            key: "a",
            duration: 1,
          },
        },
      },
      {
        op: "tab.ax.action",
        args: {
          tab: T,
          action: { kind: "scroll", target: 8, direction: "down", pages: 2 },
        },
      },
      {
        op: "tab.ax.action",
        args: {
          tab: T,
          action: { kind: "scroll", target: [1, 2], direction: "up" },
        },
      },
      {
        op: "tab.ax.action",
        args: {
          tab: T,
          action: {
            kind: "select_text",
            element_index: 9,
            text: "txt",
            prefix: "a",
            suffix: "b",
            selection_type: "cursor_after",
          },
        },
      },
      {
        op: "tab.ax.action",
        args: {
          tab: T,
          action: {
            kind: "perform_secondary_action",
            element_index: 10,
            action: "Expand",
          },
        },
      },
      {
        op: "tab.ax.action",
        args: { tab: T, action: { kind: "drag", from: [0, 0], to: [5, 5] } },
      },
      {
        op: "tab.ax.action",
        args: { tab: T, action: { kind: "hover", target: 11 } },
      },
      { op: "tab.close", args: { tab: T } },
      { op: "tabs.list", args: {} },
    ]);
    expect(result.items).toEqual([
      {
        type: "text",
        text: [
          "true true true",
          "true",
          "9 user",
          JSON.stringify({
            echoed: {
              namespace: "tabs",
              method: "query",
              args: [{ active: true }],
            },
          }),
          "https://t/3 https://fresh Fresh Fresh",
        ].join("\n"),
      },
      { type: "image", mimeType: "image/jpeg", data: "QQ" },
      {
        type: "text",
        // console.log lines, then write() and write("both") state text merge into one text item
        text: [
          JSON.stringify({ ok: 1 }),
          "STATE",
          JSON.stringify({ data: "SS", mimeType: "image/jpeg" }),
          "STATE",
          "STATE",
        ].join("\n"),
      },
      { type: "image", mimeType: "image/jpeg", data: "SS" },
      { type: "image", mimeType: "image/jpeg", data: "SS" },
      { type: "text", text: "2" },
    ]);
  });

  test("Tab objects display compactly and reject invalid ids", async () => {
    const { repl } = makeRepl({
      "tabs.new": () => ({ id: 3, title: "Hello", url: "https://h" }),
    });
    expect(text(await repl.run("const t = await browser.tabs.new(); t"))).toBe(
      'Tab { id: 3, title: "Hello", url: "https://h" }',
    );
    expect(
      (await repl.run("await browser.user.claimTab('abc')")).error,
    ).toStartWith("TypeError: Invalid tab id");
    expect((await repl.run("await t.ax.write('bogus')")).error).toContain(
      'mode must be "state"',
    );
  });
});

describe("in-process pieces", () => {
  test("client API works without a worker (chrome proxy is not thenable)", async () => {
    const calls: Call[] = [];
    const browser = createBrowserApi({
      call: async (op, args) => {
        calls.push({ op, args });
        return op === "chrome" ? 1 : undefined;
      },
      display: () => {},
    });
    expect(
      (browser.chrome as unknown as { then?: unknown }).then,
    ).toBeUndefined();
    expect(
      (browser.chrome.history as unknown as { then?: unknown }).then,
    ).toBeUndefined();
    await browser.chrome.history!.search!({ text: "x", maxResults: 2 });
    expect(calls).toEqual([
      {
        op: "chrome",
        args: {
          namespace: "history",
          method: "search",
          args: [{ text: "x", maxResults: 2 }],
        },
      },
    ]);
  });

  test("transformCell keeps line numbers", () => {
    const source = "const a = 1,\n  b = 2;\nclass C {}\nfunction f() {}\na + b";
    const { code, names } = transformCell(source);
    expect(names).toEqual(["a", "b", "C", "f"]);
    expect(code.split("\n").length).toBe(source.split("\n").length + 1);
    expect(code).toContain("return (a + b)");
  });

  test("docs mention the core API", () => {
    for (const name of [
      "tab.ax.write",
      "tab.ax.click",
      "browser.user.claimTab",
      "browser.chrome",
      "markDeliverable",
    ])
      expect(BROWSER_JS_DESCRIPTION).toContain(name);
    expect(BROWSER_GUIDANCE).toContain("markHandoff");
    expect(BROWSER_GUIDANCE).toContain("CAPTCHA");
  });
});
