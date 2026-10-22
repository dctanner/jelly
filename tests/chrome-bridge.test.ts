import { test, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { connect, type Socket } from "node:net";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeBridge } from "../src/server/chrome-bridge";
import { ChromeSessions } from "../src/server/chrome-sessions";
import { BrowserSessions } from "../src/server/browser-sessions";
import {
  ChromeFrames,
  chromeFrame,
  chromeOrigin,
  chromeRequest,
  CHROME_MAX_FRAME,
  CHROME_PROTOCOL,
  CHROME_METHODS,
  defaultChromeSelection,
} from "../src/shared/chrome-protocol";
import { Store } from "../src/server/store";
import {
  chromeDenyRegexes,
  chromeInternetDenyRegexes,
} from "../src/shared/chrome-policy";
import { interventionTools } from "../src/server/agent-tools";
import type { Interventions } from "../src/server/interventions";
async function waitFor(ready: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!ready()) {
    if (Date.now() >= deadline)
      throw new Error("Chrome fixture acknowledgement timed out");
    await Bun.sleep(5);
  }
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-chrome-"));
  const bridge = new ChromeBridge(dir, "test-instance");
  await bridge.ready;
  const config = JSON.parse(
    readFileSync(join(bridge.directory, "pairing.json"), "utf8"),
  );
  const extensionId = "a".repeat(32);
  writeFileSync(join(bridge.directory, "extension-id"), extensionId, {
    mode: 0o600,
  });
  const sockets: Socket[] = [];
  const peer = async (overrides = {}) => {
    const socket = connect(config.socket);
    sockets.push(socket);
    const frames = new ChromeFrames();
    const messages: any[] = [];
    socket.on("error", () => {});
    socket.on("data", (chunk) =>
      messages.push(...frames.push(Buffer.from(chunk))),
    );
    socket.write(
      chromeFrame({
        type: "hello",
        version: CHROME_PROTOCOL,
        capabilities: CHROME_METHODS,
        instance: "test-instance",
        grant: config.grant,
        extensionId,
        profile: crypto.randomUUID(),
        generation: crypto.randomUUID(),
        ...overrides,
      }),
    );
    await waitFor(() => messages.length > 0 || socket.destroyed);
    return { socket, messages };
  };
  return {
    dir,
    bridge,
    config,
    peer,
    close: async () => {
      for (const s of sockets) s.destroy();
      await bridge.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("Chrome framing is incremental, bounded and rejects invalid JSON/methods", () => {
  const parser = new ChromeFrames(),
    frame = chromeFrame({ ok: true });
  expect(parser.push(frame.subarray(0, 2))).toEqual([]);
  expect(parser.push(frame.subarray(2))).toEqual([{ ok: true }]);
  expect(parser.push(Buffer.concat([frame, frame]))).toHaveLength(2);
  const large = Buffer.alloc(4);
  large.writeUInt32LE(CHROME_MAX_FRAME + 1);
  expect(() => parser.push(large)).toThrow();
  expect(() => chromeFrame("x".repeat(CHROME_MAX_FRAME))).toThrow();
  expect(
    chromeRequest({
      jsonrpc: "2.0",
      id: "id",
      instance: "i",
      generation: "g",
      session: "s",
      run: "r",
      method: "Runtime.evaluate",
      params: {},
    }),
  ).toBe(false);
});
test("Chrome production policy allows local/private web endpoints but protects exact control endpoints", () => {
  const protectedOrigins = ["http://127.0.0.1:5173", "https://JELLY.example.:443", "http://[::1]:5173", "http://control.local"];
  const rules = chromeInternetDenyRegexes(protectedOrigins).map(p => new RegExp(p, "i"));
  const blocked = (url: string) => rules.some(r => r.test(new URL(url).href));
  for (const url of [
    "http://localhost:8080", "https://localhost./", "http://machine/",
    "https://box.home.arpa/", "https://127.0.0.1.nip.io/", "https://box.tailnet.ts.net/",
    "http://127.0.0.1:8080/", "http://2130706433:8080/", "http://10.0.0.1/",
    "http://172.31.1.1/", "http://192.168.1.1/", "http://169.254.169.254/",
    "http://100.91.31.77/", "http://[::1]:8080/", "http://[fc00::1]/",
    "http://[::ffff:127.0.0.1]/", "https://example.com/", "https://1.1.1.1/",
    "https://jelly.example:444/", "http://jelly.example/", "https://jelly.example.evil/",
  ]) {
    expect(chromeOrigin(url, protectedOrigins)).toMatch(/^https?:/);
    expect(blocked(url)).toBe(false);
    expect(blocked(url.replace(/^http/, "ws"))).toBe(false);
  }
  for (const url of [
    "http://127.0.0.1:5173/", "http://2130706433:5173/", "http://0x7f000001:5173/",
    "http://[0:0:0:0:0:0:0:1]:5173/", "https://JELLY.EXAMPLE.:443/path",
    "https://jelly.example/", "http://control.local.:80/",
  ]) {
    expect(() => chromeOrigin(url, protectedOrigins)).toThrow("Jelly/control");
    expect(blocked(url)).toBe(true);
    expect(blocked(url.replace(/^http/, "ws"))).toBe(true);
  }
  for (const url of ["file:///tmp/file", "chrome://settings/", "https://user:pass@example.com/", "http://evil@127.0.0.1:5173/", "http://127.0.0.1:5173@evil/"]) {
    expect(() => chromeOrigin(url, protectedOrigins)).toThrow();
    expect(blocked(url)).toBe(true);
  }
  expect(() => chromeOrigin("ws://localhost/")).toThrow(); // navigation is HTTP(S) only
  expect(chromeOrigin("HTTP://LOCALHOST.:80/path")).toBe("http://localhost");
  const approved = chromeDenyRegexes(["http://localhost:8080", "http://[::1]:8080"]).map(p => new RegExp(p));
  expect(approved.some(r => r.test("http://localhost:8080/app"))).toBe(false);
  expect(approved.some(r => r.test("http://localhost:8081/app"))).toBe(true);
  expect(approved.some(r => r.test("http://localhost:8080.evil/app"))).toBe(true);
});

test("Chrome bridge authenticates profile/generation, isolates requests and rejects stale connections", async () => {
  const f = await fixture();
  try {
    expect(statSync(f.bridge.directory).mode & 0o777).toBe(0o700);
    expect(statSync(f.config.socket).mode & 0o777).toBe(0o600);
    for (const bad of [
      { grant: "wrong" },
      { instance: "wrong" },
      { extensionId: "b".repeat(32) },
      { version: 99 },
      { capabilities: [] },
    ]) {
      const p = await f.peer(bad);
      expect(p.socket.destroyed).toBe(true);
    }
    const profile = crypto.randomUUID(),
      generation = crypto.randomUUID();
    const p = await f.peer({ profile, generation });
    expect(p.messages[0].type).toBe("paired");
    const other = await f.peer();
    const pending = f.bridge.call(
      profile,
      generation,
      "session",
      "run",
      "snapshot",
      { tab: "cap" },
    );
    await waitFor(() => p.messages.length >= 2);
    const req = p.messages[1];
    expect(req.session).toBe("session");
    expect(other.messages).toHaveLength(1);
    p.socket.write(
      chromeFrame({
        jsonrpc: "2.0",
        id: req.id,
        generation,
        result: { text: "fixture" },
      }),
    );
    expect(await pending).toEqual({ text: "fixture" });
    await expect(
      f.bridge.call(profile, crypto.randomUUID(), "s", "r", "click", {}),
    ).rejects.toThrow("disconnected");
    const indeterminate = f.bridge.call(
      profile,
      generation,
      "s",
      "r",
      "click",
      {},
    );
    void indeterminate.catch(() => {});
    await waitFor(() => p.messages.length >= 3);
    p.socket.destroy();
    await expect(indeterminate).rejects.toThrow("indeterminate");
  } finally {
    await f.close();
  }
});
test("Chrome selection persists and disconnected profiles never fall back to a managed browser", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-chrome-store-"));
  const store = new Store(join(dir, "test.sqlite"));
  const chrome = new ChromeSessions(dir, "instance");
  try {
    expect(store.browserSelection()).toEqual(defaultChromeSelection());
    const selected = { chromeProfile: crypto.randomUUID(), chromeOrigins: ["https://example.com"] };
    store.setBrowserSelection(selected);
    expect(store.browserSelection()).toEqual(selected);
    const router = new BrowserSessions(chrome);
    const first = router.forRun("a", "r1", selected, "Agent");
    expect(() => first.get("a")).toThrow("disconnected");
    expect(() => router.forRun("b", "r2", selected, "Agent").get("b")).toThrow("disconnected");
    expect(() => first.get("child")).toThrow("Child/foreign");
  } finally {
    await chrome.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Jelly native installer/uninstaller preserves unrelated hosts and rejects another instance", async () => {
  const f = await fixture();
  const root = join(f.dir, "disposable-chrome");
  const manifestDir = join(root, "NativeMessagingHosts");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, "unrelated.json"), "unrelated fixture");
  const run = async (args: string[]) => {
    const process = Bun.spawn(
      [
        Bun.which("bun")!,
        "scripts/install-chrome-host.ts",
        "--data-dir",
        f.dir,
        "--chrome-config",
        root,
        ...args,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    return await process.exited;
  };
  try {
    expect(await run(["--extension-id", "a".repeat(32)])).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(manifestDir, "org.jelly.browser.json"), "utf8"),
    );
    expect(manifest.allowed_origins).toEqual([
      `chrome-extension://${"a".repeat(32)}/`,
    ]);
    expect(statSync(manifest.path).mode & 0o777).toBe(0o700);
    expect(
      statSync(join(f.bridge.directory, "native-host/config.json")).mode &
        0o777,
    ).toBe(0o600);
    writeFileSync(
      join(manifestDir, "org.jelly.browser.json"),
      JSON.stringify({ ...manifest, path: "/another/instance/launch" }),
    );
    expect(await run(["--uninstall"])).not.toBe(0);
    writeFileSync(
      join(manifestDir, "org.jelly.browser.json"),
      JSON.stringify(manifest),
    );
    expect(await run(["--uninstall"])).toBe(0);
    expect(existsSync(join(manifestDir, "org.jelly.browser.json"))).toBe(false);
    expect(readFileSync(join(manifestDir, "unrelated.json"), "utf8")).toBe(
      "unrelated fixture",
    );
  } finally {
    await f.close();
  }
});

test("Chrome DNR deny rules match unapproved redirect origins, port changes and lookalikes", () => {
  const rules = chromeDenyRegexes([
    "https://example.com",
    "https://example.org:8443",
  ]).map((r) => new RegExp(r));
  const denied = (url: string) => rules.some((r) => r.test(url));
  for (const url of [
    "https://example.com/",
    "https://example.com/path?x=1",
    "https://example.org:8443/",
  ])
    expect(denied(url)).toBe(false);
  for (const url of [
    "http://example.com/",
    "https://example.com:8443/",
    "https://example.com.evil.test/",
    "https://example.org/",
    "https://other.test/",
    "http://127.0.0.1:5173/",
    "file:///etc/passwd",
  ])
    expect(denied(url)).toBe(true);
});

test("Approved DNR matches canonical dotted origins without admitting lookalikes or control endpoints", () => {
  const origins = ["http://localhost:8080", "https://example.com", "https://example.com.child", "https://example.com.child:8443"];
  const protectedOrigins = ["http://control.local:5173", "https://control.local"];
  const rules = [...chromeDenyRegexes([...origins, ...protectedOrigins]), ...chromeInternetDenyRegexes(protectedOrigins)].map(r => new RegExp(r));
  // Like DNR, match the browser's parsed URL: host case/default ports normalize,
  // but DNS trailing dots remain in the serialized URL.
  const denied = (url: string) => rules.some(r => r.test(new URL(url).href));
  for (const url of ["http://LOCALHOST.:8080/app", "http://localhost...:8080/", "https://EXAMPLE.COM.:443/", "https://example.com.child./", "https://example.com.child.:8443/"])
    expect(denied(url)).toBe(false);
  for (const url of ["http://localhost.:8081/", "https://example.com.evil/", "https://example.com..child/", "https://example.com.child.:9443/", "https://example.com.:444/", "http://user@localhost.:8080/", "http://CONTROL.LOCAL.:5173/", "https://CONTROL.LOCAL.:443/"])
    expect(denied(url)).toBe(true);
  for (const url of ["http://CONTROL.LOCAL.:5173/", "https://CONTROL.LOCAL.:443/"])
    expect(() => chromeOrigin(url, protectedOrigins)).toThrow("Jelly/control");
});

test("ChromeSessions pins unrestricted access and sends its scope to the extension", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-chrome-internet-"));
  const chrome = new ChromeSessions(dir, "instance");
  const profile = crypto.randomUUID();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  chrome.bridge.profiles = () => [
    { id: profile, generation: crypto.randomUUID(), connected: true },
  ];
  chrome.bridge.call = async (
    _profile,
    _generation,
    _session,
    _run,
    method,
    params,
  ) => {
    calls.push({ method, params });
    return method === "open" ? { pageId: crypto.randomUUID() } : { ok: true };
  };
  chrome.protectOrigins(["http://jelly.example.com:3100", "http://127.0.0.1:5173", "https://[::1]"]);
  const selection = {
    chromeProfile: profile,
    chromeOrigins: [],
    chromeSiteScope: "internet" as const,
  };
  try {
    const browser = chrome.allocate("agent", "run", selection, "Agent");
    await browser.action("open", { url: "http://unlisted.example/path" });
    await browser.action("open", { url: "https://another.example/path" });
    expect(calls[0]?.params).toMatchObject({
      siteScope: "internet",
      origins: [],
    });
    expect(chrome.state("agent").task?.siteScope).toBe("internet");
    await browser.action("open", { url: "http://localhost/" });
    await browser.action("open", { url: "http://127.0.0.1:8080/" });
    await browser.action("open", { url: "https://[::1]:8080/" });
    for (const url of ["http://2130706433:5173/", "https://[0:0:0:0:0:0:0:1]:443/", "ws://127.0.0.1:5173/", "https://user:pass@localhost/", "file:///tmp/test"])
      await expect(browser.action("open", { url })).rejects.toThrow();
    await browser.action("open", { url: "https://jelly.example.com:444/" });
    await expect(
      browser.action("open", { url: "http://jelly.example.com:3100/" }),
    ).rejects.toThrow();
    await chrome.settle("agent", "run");
    const next = chrome.allocate(
      "agent",
      "next",
      {
        ...selection,
        chromeSiteScope: "approved",
        chromeOrigins: ["https://approved.example"],
      },
      "Agent",
    );
    await next.action("open", { url: "https://still-unlisted.example/" });
    expect(
      calls.filter((c) => c.method === "begin").at(-1)?.params.siteScope,
    ).toBe("internet");
    await chrome.settle("agent", "next");
  } finally {
    await chrome.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ChromeSessions pins profile/scope and exact caps; pause, unsupported tools and loss fail closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-chrome-sessions-"));
  const chrome = new ChromeSessions(dir, "instance");
  const calls: {
    method: string;
    run: string;
    profile: string;
    params: Record<string, unknown>;
  }[] = [];
  const profile = crypto.randomUUID(),
    generation = crypto.randomUUID();
  chrome.bridge.profiles = () => [{ id: profile, generation, connected: true }];
  chrome.bridge.call = async (
    profile,
    _generation,
    _session,
    run,
    method,
    params,
  ) => {
    calls.push({ method, run, profile, params });
    return method === "open"
      ? { pageId: crypto.randomUUID() }
      : method === "screenshot"
        ? { image: "aW1hZ2U=" }
        : { ok: true };
  };
  const selection = {
    chromeProfile: profile,
    chromeOrigins: ["https://example.com"],
  };
  try {
    const browser = chrome.allocate("a", "run1", selection, "Agent");
    await browser.action("open", { url: "https://example.com/" });
    await expect(
      browser.action("open", { url: "https://outside.example/" }),
    ).rejects.toThrow("scope");
    await expect(
      browser.action("tabs", { operation: "select", pageId: "foreign" }),
    ).rejects.toThrow("foreign");
    for (const operation of [
      "upload",
      "type",
      "key",
      "wait_for",
      "diagnostics",
    ])
      await expect(browser.action(operation, {})).rejects.toThrow(
        "Unavailable",
      );
    await expect(browser.action("click", { x: 1, y: 2 })).rejects.toThrow(
      "exact",
    );
    await browser.reserveLogin("handoff", "https://example.com/login");
    expect(await browser.action("snapshot", {})).toMatchObject({ humanUsing: true });
    expect(chrome.state("a").task?.handoff).toBe("handoff");
    expect(chrome.done("a", "handoff")).toBe("handoff");
    const tools = interventionTools(
      { get: () => browser },
      {} as Interventions,
      "a",
      "run1",
      dir,
    );
    const shot = await tools
      .find((t) => t.name === "browser_screenshot")!
      .execute("id", {}, undefined, undefined, {} as never);
    expect(shot.content).toEqual([
      { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      { type: "text", text: '{"humanUsing":false}' },
    ]);
    await browser.keepTab();
    await chrome.settle("a", "run1");
    expect(calls.at(-1)?.method).toBe("end");
    const next = chrome.allocate(
      "a",
      "run2",
      {
        ...selection,
        chromeProfile: "different",
        chromeOrigins: ["https://elsewhere.example"],
      },
      "Agent",
    );
    await next.action("open", { url: "https://example.com/followup" });
    expect(calls.at(-1)?.profile).toBe(profile);
    expect(calls.at(-1)?.run).toBe("run2");
    chrome.bridge.onLoss(profile);
    await expect(next.action("snapshot", {})).rejects.toThrow("expired");
  } finally {
    await chrome.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Chrome bridge retains large requests until socket drain and authenticates tab-removal events", async () => {
  const f = await fixture();
  try {
    const profile = crypto.randomUUID(),
      generation = crypto.randomUUID();
    const p = await f.peer({ profile, generation });
    const removals: unknown[][] = [];
    f.bridge.onTabRemoved = (...args) => removals.push(args);
    const payload = "x".repeat(700000);
    const pending = f.bridge.call(
      profile,
      generation,
      "session",
      "run",
      "fill",
      { text: payload },
    );
    await waitFor(() => p.messages.length >= 2);
    expect(p.messages[1]?.params.text).toBe(payload);
    p.socket.write(
      chromeFrame({
        jsonrpc: "2.0",
        id: p.messages[1].id,
        generation,
        result: { ok: true },
      }),
    );
    expect(await pending).toEqual({ ok: true });
    p.socket.write(
      chromeFrame({
        type: "tabRemoved",
        generation,
        session: "session",
        run: "run",
        tab: "cap",
      }),
    );
    await waitFor(() => removals.length > 0);
    expect(removals).toEqual([[profile, generation, "session", "run", "cap"]]);
    p.socket.write(
      chromeFrame({
        type: "tabRemoved",
        generation: "stale",
        session: "session",
        run: "run",
        tab: "cap",
      }),
    );
    await waitFor(() => p.socket.destroyed);
    expect(removals).toHaveLength(1);
    expect(p.socket.destroyed).toBe(true);
  } finally {
    await f.close();
  }
});

test("ChromeSessions forgets human-closed tabs, rejects foreign removal and opens a replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-chrome-removal-"));
  const chrome = new ChromeSessions(dir, "instance");
  const profile = crypto.randomUUID(),
    generation = crypto.randomUUID();
  chrome.bridge.profiles = () => [{ id: profile, generation, connected: true }];
  let session = "",
    lastTab: unknown,
    closeDuringOpen = false;
  const owned = new Set<string>();
  chrome.bridge.call = async (
    _profile,
    _generation,
    sid,
    run,
    method,
    params,
  ) => {
    session = sid;
    if (
      method === "open" ||
      (method === "tabs" && params.operation === "new")
    ) {
      lastTab = params.tab;
      if (method === "open" && params.tab && !owned.has(String(params.tab)))
        throw new Error("stale");
      const pageId = crypto.randomUUID();
      if (closeDuringOpen)
        chrome.bridge.onTabRemoved(profile, generation, sid, run, pageId);
      else owned.add(pageId);
      return { pageId };
    }
    if (method === "tabs")
      return { tabs: [...owned].map((pageId) => ({ pageId })) };
    return { ok: true };
  };
  try {
    const browser = chrome.allocate(
      "a",
      "run",
      {
        chromeProfile: profile,
        chromeOrigins: ["https://example.com"],
      },
      "Agent",
    );
    const opened = await browser.action("open", { url: "https://example.com" });
    const cap = String(opened.pageId);
    for (const args of [
      ["foreign", generation, session, "run", cap],
      [profile, "stale", session, "run", cap],
      [profile, generation, "foreign", "run", cap],
      [profile, generation, session, "old-run", cap],
    ])
      chrome.bridge.onTabRemoved(
        ...(args as [string, string, string, string, string]),
      );
    expect(chrome.state("a").task?.active).toBe(cap);
    owned.delete(cap);
    chrome.bridge.onTabRemoved(profile, generation, session, "run", cap);
    expect(chrome.state("a").task).toMatchObject({ active: null, tabs: [] });
    expect(await browser.action("tabs", { operation: "list" })).toEqual({
      tabs: [], humanUsing: false,
    });
    await browser.action("open", { url: "https://example.com" });
    expect(lastTab).toBeNull();
    expect(chrome.state("a").task?.tabs).toHaveLength(1);
    closeDuringOpen = true;
    await expect(
      browser.action("tabs", { operation: "new", url: "https://example.com" }),
    ).rejects.toThrow("closed during");
    expect(chrome.state("a").task?.tabs).toHaveLength(1);
  } finally {
    await chrome.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Chrome bridge fails stalled socket writes after a bounded drain wait", async () => {
  const f = await fixture();
  try {
    const profile = crypto.randomUUID(),
      generation = crypto.randomUUID();
    const p = await f.peer({ profile, generation });
    p.socket.pause();
    const pending = f.bridge.call(
      profile,
      generation,
      "session",
      "run",
      "fill",
      { text: "x".repeat(700000) },
    );
    await expect(pending).rejects.toThrow("indeterminate");
    expect(f.bridge.profiles()).toEqual([]);
  } finally {
    await f.close();
  }
}, 12000);

test("ChromeSessions retains handoffs across runs and reuses them without explicit resume or retargeting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-chrome-handoff-"));
  const chrome = new ChromeSessions(dir, "handoff-instance");
  const profile = crypto.randomUUID(),
    generation = crypto.randomUUID(),
    cap = crypto.randomUUID();
  chrome.bridge.profiles = () => [{ id: profile, generation, connected: true }];
  const calls: any[] = [];
  chrome.bridge.call = async (p, g, s, r, method, params) => {
    calls.push({ p, g, s, r, method, params });
    if (method === "open") return { pageId: cap };
    if (method === "end") return { retained: params.discard ? [] : [cap] };
    if (method === "begin" && r === "second") return { paused: true, tabs: [cap] };
    return { ok: true };
  };
  const selection = {
    chromeProfile: profile,
    chromeOrigins: ["https://example.com"],
  };
  try {
    const first = chrome.allocate("agent", "first", selection, "Researcher");
    await first.action("open", { url: "https://example.com" });
    await first.keepTab("handoff");
    await chrome.settle("agent", "first");
    expect(chrome.state("agent").task).toMatchObject({
      paused: false,
      tabs: [cap],
    });
    await expect(chrome.control("agent", "resume")).rejects.toThrow(
      "active native",
    );
    chrome.allocate("agent", "no-browser-run", selection, "Researcher");
    await chrome.settle("agent", "no-browser-run");
    expect(chrome.state("agent").task).toMatchObject({
      paused: false,
      tabs: [cap],
    });
    const second = chrome.allocate(
      "agent",
      "second",
      { ...selection, chromeProfile: "foreign" },
      "Researcher",
    );
    await second.action("snapshot", {});
    await expect(first.action("snapshot", {})).rejects.toThrow("expired");
    await second.action("snapshot", {});
    expect(calls.at(-1)).toMatchObject({
      p: profile,
      r: "second",
      params: { tab: cap },
    });
    await chrome.settle("agent", "second");
    await chrome.control("agent", "close");
    expect(calls.at(-1)).toMatchObject({
      method: "end",
      params: { discard: true },
    });
    expect(chrome.state("agent").task).toBeNull();
    const third = chrome.allocate("agent", "third", selection, "Researcher");
    await third.action("open", { url: "https://example.com" });
    await third.keepTab("handoff");
    await chrome.settle("agent", "third");
    chrome.bridge.onTabRemoved(
      profile,
      generation,
      calls.at(-1).s,
      "third",
      cap,
    );
    expect(chrome.state("agent").task?.tabs).toEqual([]);
  } finally {
    await chrome.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Chrome protocol bounds exact input, rejects browser shortcuts, and authenticates added-tab events", async () => {
  const base = {
    jsonrpc: "2.0",
    id: "i",
    instance: "i",
    generation: "g",
    session: "s",
    run: "r",
  };
  expect(
    chromeRequest({
      ...base,
      method: "key",
      params: { tab: "cap", ref: "node", key: "Enter" },
    }),
  ).toBe(true);
  for (const params of [
    { tab: "cap", key: "Enter" },
    { tab: "cap", ref: "node", key: "Control+l" },
  ])
    expect(chromeRequest({ ...base, method: "key", params })).toBe(false);
  expect(
    chromeRequest({
      ...base,
      method: "wait_for",
      params: { tab: "cap", condition: "ready", timeoutMs: 10001 },
    }),
  ).toBe(false);
  const f = await fixture();
  try {
    const profile = crypto.randomUUID(),
      generation = crypto.randomUUID();
    const p = await f.peer({ profile, generation });
    const added: unknown[][] = [];
    f.bridge.onTabAdded = (...args) => added.push(args);
    p.socket.write(
      chromeFrame({
        type: "tabAdded",
        generation,
        session: "session",
        run: "run",
        tab: "cap",
      }),
    );
    await waitFor(() => added.length > 0);
    expect(added).toEqual([[profile, generation, "session", "run", "cap"]]);
    p.socket.write(
      chromeFrame({
        type: "tabAdded",
        generation: "stale",
        session: "session",
        run: "run",
        tab: "cap",
      }),
    );
    await waitFor(() => p.socket.destroyed);
    expect(added).toHaveLength(1);
    expect(p.socket.destroyed).toBe(true);
  } finally {
    await f.close();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function pauseFixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-chrome-pause-"));
  const chrome = new ChromeSessions(dir, "pause-instance");
  await chrome.bridge.ready;
  const profile = crypto.randomUUID(),
    generation = crypto.randomUUID();
  chrome.bridge.profiles = () => [{ id: profile, generation, connected: true }];
  const browser = chrome.allocate(
    "agent",
    "run",
    {
      chromeProfile: profile,
      chromeOrigins: ["https://example.com"],
    },
    "Agent",
  );
  return {
    chrome,
    browser,
    profile,
    generation,
    close: async () => {
      await chrome.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("ChromeSessions pause revokes authority but never reports human-safe before delayed drain acknowledgement", async () => {
  for (const operation of ["screenshot", "fill"]) {
    const f = await pauseFixture();
    const admitted = deferred<unknown>(),
      ack = deferred<unknown>();
    const calls: string[] = [];
    let session = "";
    f.chrome.bridge.call = async (_p, _g, s, _r, method) => {
      session = s;
      calls.push(method);
      if (method === "open") return { pageId: "owned-tab" };
      if (method === operation) return admitted.promise;
      if (method === "pause") return ack.promise;
      return { ok: true };
    };
    try {
      await f.browser.action("open", { url: "https://example.com" });
      await expect(f.chrome.control("agent", "focus")).rejects.toThrow(
        "not acknowledged",
      );
      const pending = f.browser.action(
        operation,
        operation === "fill" ? { ref: "ref", text: "fixture" } : {},
      );
      const outcome = pending.catch(() => "revoked");
      await waitFor(() => calls.at(-1) === operation);
      expect(calls.at(-1)).toBe(operation);
      const pausing = f.chrome.control("agent", "pause");
      expect(f.chrome.state("agent").task).toMatchObject({
        paused: false,
        pauseState: "pausing",
        connected: true,
      });
      await expect(f.chrome.control("agent", "focus")).rejects.toThrow(
        "not acknowledged",
      );
      await expect(f.chrome.control("agent", "resume")).rejects.toThrow(
        "not acknowledged",
      );
      // Even the earlier extension event cannot finish a still-pending server RPC.
      f.chrome.bridge.onPauseState(
        f.profile,
        f.chrome.state().profiles[0]!.generation,
        session,
        "run",
        "paused",
      );
      expect(f.chrome.state("agent").task?.paused).toBe(false);
      admitted.reject(new Error("revoked"));
      expect(await outcome).toBe("revoked");
      await expect(f.browser.action("snapshot")).rejects.toThrow("paused");
      ack.resolve({ ok: true });
      await pausing;
      expect(f.chrome.state("agent").task).toMatchObject({
        paused: true,
        pauseState: "paused",
      });
      await f.chrome.control("agent", "focus");
      await f.chrome.control("agent", "resume");
      expect(f.chrome.state("agent").task).toMatchObject({
        paused: false,
        pauseState: "active",
      });
    } finally {
      await f.close();
    }
  }
});

test("ChromeSessions login status is advisory; Done/cancel during delayed preparation never resurrects a request", async () => {
  const f = await pauseFixture(), opened = deferred<unknown>();
  const calls: string[] = [];
  f.chrome.bridge.call = async (_p, _g, _s, _r, method) => {
    calls.push(method);
    if (method === "open") return opened.promise;
    return { ok: true };
  };
  try {
    const login = f.browser.reserveLogin("request", "https://example.com/login");
    await waitFor(() => calls.includes("open"));
    expect(f.chrome.state("agent").task).toMatchObject({ paused: false, humanUsing: true, handoff: "request" });
    expect(() => f.chrome.done("agent", "other")).toThrow("no longer current");
    expect(f.chrome.done("agent", "request")).toBe("request");
    opened.resolve({ pageId: "login-tab" });
    await login;
    expect(f.chrome.state("agent").task).toMatchObject({ humanUsing: false, handoff: null });
    expect(calls).not.toContain("pause");
    expect(await f.browser.action("snapshot")).toMatchObject({ humanUsing: false });
    await f.browser.reserveLogin("new", "https://example.com/login");
    f.browser.cancelLogin("request");
    expect(f.chrome.state("agent").task?.handoff).toBe("new");
    expect(await f.browser.action("snapshot")).toMatchObject({ humanUsing: true });
    f.chrome.bridge.onLoss(f.profile);
    expect(f.chrome.done("agent", "new")).toBe("new");
    await expect(f.browser.action("snapshot")).rejects.toThrow("expired");
  } finally { opened.resolve({ pageId: "login-tab" }); await f.close(); }
});

test("ChromeSessions failed and disconnected pauses never advertise private-safe state", async () => {
  for (const disconnected of [false, true]) {
    const f = await pauseFixture();
    const ack = deferred<unknown>();
    f.chrome.bridge.call = async (_p, _g, _s, _r, method) => {
      if (method === "pause") return ack.promise;
      return method === "open" ? { pageId: "owned-tab" } : { ok: true };
    };
    try {
      await f.browser.action("open", { url: "https://example.com" });
      const pausing = f.chrome.control("agent", "pause");
      const failed = pausing.then(
        () => "unexpected success",
        () => "rejected",
      );
      if (disconnected) {
        f.chrome.bridge.onLoss(f.profile);
        ack.resolve({ ok: true });
      } else ack.reject(new Error("detach failed"));
      expect(await failed).toBe("rejected");
      expect(f.chrome.state("agent").task).toMatchObject({
        paused: false,
        pauseState: disconnected ? "disconnected" : "failed",
        connected: !disconnected,
      });
      await expect(f.chrome.control("agent", "focus")).rejects.toThrow();
      await expect(f.chrome.control("agent", "resume")).rejects.toThrow();
    } finally {
      await f.close();
    }
  }
});

test("ChromeSessions invalidates human-safe state before Resume dispatch and keeps failed ACKs unsafe", async () => {
  for (const fail of [false, true]) {
    const f = await pauseFixture();
    const ack = deferred<unknown>();
    let extensionActive = false;
    f.chrome.bridge.call = async (_p, _g, _s, _r, method) => {
      if (method === "resume") {
        extensionActive = true;
        return ack.promise;
      }
      return method === "open" ? { pageId: "login-tab" } : { ok: true };
    };
    try {
      await f.browser.reserveLogin("handoff", "https://example.com/login");
      await f.chrome.control("agent", "pause"); // A real native/security pause, not human-use status.
      const resume = f.chrome.control("agent", "resume");
      const outcome = resume.then(
        (value) => value,
        () => "rejected",
      );
      expect(extensionActive).toBe(true);
      expect(f.chrome.state("agent").task).toMatchObject({
        paused: false,
        pauseState: "resuming",
        handoff: "handoff",
      });
      await expect(f.chrome.control("agent", "focus")).rejects.toThrow();
      await expect(f.chrome.control("agent", "resume")).rejects.toThrow();
      await expect(f.browser.action("snapshot")).rejects.toThrow("paused");
      if (fail) ack.reject(new Error("uncertain resume"));
      else ack.resolve({ ok: true });
      expect(await outcome).toBe(fail ? "rejected" : null);
      expect(f.chrome.state("agent").task).toMatchObject({
        paused: false,
        pauseState: fail ? "failed" : "active",
      });
    } finally {
      ack.resolve({ ok: true });
      await f.close();
    }
  }
});

test("ChromeSessions cannot restore active authority from a late Resume ACK after a new pause", async () => {
  const f = await pauseFixture();
  const ack = deferred<unknown>();
  let session = "";
  f.chrome.bridge.call = async (_p, _g, s, _r, method) => {
    session = s;
    if (method === "resume") return ack.promise;
    return method === "open" ? { pageId: "owned-tab" } : { ok: true };
  };
  try {
    await f.browser.action("open", { url: "https://example.com" });
    await f.chrome.control("agent", "pause");
    const resumed = f.chrome.control("agent", "resume").catch(() => "revoked");
    // Acknowledgement from a different run/profile cannot affect this task.
    for (const [p, g, s, run] of [
      ["foreign", f.generation, session, "run"],
      [f.profile, "stale", session, "run"],
      [f.profile, f.generation, "foreign", "run"],
      [f.profile, f.generation, session, "old-run"],
    ])
      f.chrome.bridge.onPauseState(p!, g!, s!, run!, "paused");
    expect(f.chrome.state("agent").task?.pauseState).toBe("resuming");
    f.chrome.bridge.onPauseState(
      f.profile,
      f.generation,
      session,
      "run",
      "paused",
    );
    expect(f.chrome.state("agent").task).toMatchObject({
      paused: false,
      pauseState: "failed",
    });
    await f.chrome.control("agent", "pause");
    ack.resolve({ ok: true });
    expect(await resumed).toBe("revoked");
    expect(f.chrome.state("agent").task).toMatchObject({
      paused: true,
      pauseState: "paused",
    });
    await expect(f.browser.action("snapshot")).rejects.toThrow("paused");
  } finally {
    ack.resolve({ ok: true });
    await f.close();
  }
});

test("Chrome bridge binds all pause states to an authenticated generation and run", async () => {
  const f = await fixture();
  try {
    const profile = crypto.randomUUID(),
      generation = crypto.randomUUID();
    const p = await f.peer({ profile, generation });
    const states: unknown[][] = [];
    f.bridge.onPauseState = (...args) => states.push(args);
    for (const state of ["pausing", "failed", "paused"])
      p.socket.write(
        chromeFrame({
          type: "pauseState",
          generation,
          session: "session",
          run: "run",
          state,
        }),
      );
    await waitFor(() => states.length === 3);
    expect(states).toEqual(
      ["pausing", "failed", "paused"].map((state) => [
        profile,
        generation,
        "session",
        "run",
        state,
      ]),
    );
    p.socket.write(
      chromeFrame({
        type: "pauseState",
        generation: "stale",
        session: "session",
        run: "run",
        state: "paused",
      }),
    );
    await waitFor(() => p.socket.destroyed);
    expect(p.socket.destroyed).toBe(true);
    expect(states).toHaveLength(3);
  } finally {
    await f.close();
  }
});

test("intentional disconnect survives dropped final frames and bridge restart; only authenticated explicit reconnect clears", async () => {
  const f = await fixture();
  let restarted: ChromeBridge | undefined;
  try {
    const profile = crypto.randomUUID();
    const first = await f.peer({ profile });
    expect(first.messages[0].type).toBe("paired");
    expect(f.bridge.canReconnect(profile, first.messages[0].generation)).toBe(true);
    f.bridge.disconnect(profile);
    expect(f.bridge.canReconnect(profile, first.messages[0].generation)).toBe(false);
    await waitFor(() => first.socket.destroyed);
    expect(JSON.parse(readFileSync(join(f.bridge.directory, "disconnected-profiles.json"), "utf8"))).toEqual([profile]);
    // No reliance on receiving the denial frame: closing immediately cannot clear intent.
    const denied = await f.peer({ profile });
    denied.socket.destroy();
    expect(f.bridge.profiles()).toHaveLength(0);
    await f.bridge.close();
    restarted = new ChromeBridge(f.dir, "test-instance");
    await restarted.ready;
    const unauthenticated = await f.peer({ profile, explicitReconnect: true, grant: "wrong" });
    expect(unauthenticated.messages).toEqual([]);
    const stillBlocked = await f.peer({ profile });
    expect(stillBlocked.messages[0]?.type).toBe("reconnectRequired");
    expect(restarted.profiles()).toHaveLength(0);
    const reconnect = await f.peer({ profile, explicitReconnect: true });
    expect(reconnect.messages[0]?.type).toBe("paired");
    expect(restarted.canReconnect(profile, reconnect.messages[0].generation)).toBe(true);
    expect(JSON.parse(readFileSync(join(f.bridge.directory, "disconnected-profiles.json"), "utf8"))).toEqual([]);
  } finally {
    if (restarted) await restarted.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("malformed durable disconnect state fails closed; missing state is valid", async () => {
  const f = await fixture();
  await f.bridge.close();
  try {
    writeFileSync(join(f.bridge.directory, "disconnected-profiles.json"), "{}", { mode: 0o600 });
    expect(() => new ChromeBridge(f.dir, "test-instance")).toThrow("Invalid Chrome disconnect state");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("failed durable replacement revokes current socket and closes all future admission", async () => {
  const f = await fixture();
  try {
    const profile = crypto.randomUUID();
    const first = await f.peer({ profile });
    // A directory at the destination forces atomic rename failure without OS permission assumptions.
    mkdirSync(join(f.bridge.directory, "disconnected-profiles.json"));
    expect(() => f.bridge.disconnect(profile)).toThrow();
    await waitFor(() => first.socket.destroyed);
    const retry = await f.peer({ profile, explicitReconnect: true });
    expect(retry.messages).toEqual([]);
    expect(f.bridge.profiles()).toEqual([]);
  } finally { await f.close(); }
});

test("failed task settlement uses the same durable reconnect-required policy as explicit disconnect", async () => {
  const f = await pauseFixture();
  try {
    f.chrome.bridge.call = async (_p, _g, _s, _r, method) => {
      if (method === "end") throw new Error("fixture lost cleanup acknowledgement");
      return method === "open" ? { pageId: "owned-tab" } : { ok: true };
    };
    await f.browser.action("open", { url: "https://example.com" });
    await f.chrome.settle("agent", "run");
    expect(JSON.parse(readFileSync(join(f.chrome.bridge.directory, "disconnected-profiles.json"), "utf8"))).toEqual([f.profile]);
  } finally { await f.close(); }
});

test("v6 client cannot pair or clear v7 durable disconnect intent", async () => {
  const f = await fixture();
  try {
    const profile = crypto.randomUUID();
    f.bridge.disconnect(profile);
    const old = await f.peer({ profile, version: 6, explicitReconnect: true });
    expect(old.messages).toEqual([]);
    expect(f.bridge.profiles()).toEqual([]);
    expect(JSON.parse(readFileSync(join(f.bridge.directory, "disconnected-profiles.json"), "utf8"))).toEqual([profile]);
  } finally { await f.close(); }
});

test("interrupted disconnect transaction never falls back to older permissive state", async () => {
  const f = await fixture();
  await f.bridge.close();
  try {
    writeFileSync(join(f.bridge.directory, "disconnected-profiles.json"), "[]", { mode: 0o600 });
    const interrupted = join(f.bridge.directory, "disconnected-profiles.json.0123456789abcdef");
    writeFileSync(interrupted, JSON.stringify([crypto.randomUUID()]), { mode: 0o600 });
    expect(() => new ChromeBridge(f.dir, "test-instance")).toThrow("Interrupted Chrome disconnect state needs repair");
    expect(existsSync(interrupted)).toBe(true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});


test("capacity overflow durably refuses restart even with an older valid full profile store", async () => {
  const f = await fixture();
  await f.bridge.close();
  const path = join(f.bridge.directory, "disconnected-profiles.json");
  const previous = Array.from({ length: 1024 }, () => crypto.randomUUID());
  writeFileSync(path, JSON.stringify(previous), { mode: 0o600 });
  const full = new ChromeBridge(f.dir, "test-instance");
  await full.ready;
  try {
    const profile = crypto.randomUUID();
    const current = await f.peer({ profile });
    expect(current.messages[0]?.type).toBe("paired");
    expect(() => full.disconnect(profile)).toThrow("state is full");
    await waitFor(() => current.socket.destroyed);
    const marker = join(full.directory, "disconnected-profiles.json.overflow");
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ blockedAll: true, profile });
    expect(statSync(marker).mode & 0o777).toBe(0o600);
    expect(statSync(marker).size).toBeLessThan(128);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(previous);
    // Repeated overflow never grows the store or replaces global denial evidence.
    expect(() => full.disconnect(crypto.randomUUID())).toThrow();
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ blockedAll: true, profile });
    const retry = await f.peer({ profile, explicitReconnect: true });
    expect(retry.messages).toEqual([]);
    await full.close();
    expect(() => new ChromeBridge(f.dir, "test-instance")).toThrow("Interrupted Chrome disconnect state needs repair");
    expect(existsSync(marker)).toBe(true);
  } finally {
    await full.close().catch(() => {});
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("recoverable pre-rename failure preserves intent and refuses restart over a valid older file", async () => {
  const f = await fixture();
  const path = join(f.bridge.directory, "disconnected-profiles.json");
  const previous = crypto.randomUUID();
  f.bridge.disconnect(previous);
  const profile = crypto.randomUUID();
  const current = await f.peer({ profile });
  const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("fixture recoverable rename failure"); });
  try {
    expect(() => f.bridge.disconnect(profile)).toThrow("fixture recoverable rename failure");
  } finally { rename.mockRestore(); }
  try {
    await waitFor(() => current.socket.destroyed);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([previous]);
    const pending = fs.readdirSync(f.bridge.directory).filter(name => /^disconnected-profiles\.json\.[a-f0-9]{16}$/.test(name));
    expect(pending).toHaveLength(1);
    const intent = join(f.bridge.directory, pending[0]!);
    expect(JSON.parse(readFileSync(intent, "utf8"))).toEqual([previous, profile]);
    const retry = await f.peer({ profile, explicitReconnect: true });
    expect(retry.messages).toEqual([]);
    await f.bridge.close();
    // The rename fault is gone, but startup cannot discard the failed intent.
    expect(() => new ChromeBridge(f.dir, "test-instance")).toThrow("Interrupted Chrome disconnect state needs repair");
    expect(existsSync(intent)).toBe(true);
  } finally {
    await f.bridge.close().catch(() => {});
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("total intent-write failure still revokes live authority and refuses running admission", async () => {
  const f = await fixture();
  const profile = crypto.randomUUID();
  const current = await f.peer({ profile });
  const write = spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("fixture filesystem cannot write"); });
  try {
    expect(() => f.bridge.disconnect(profile)).toThrow("fixture filesystem cannot write");
  } finally { write.mockRestore(); }
  try {
    await waitFor(() => current.socket.destroyed);
    expect(f.bridge.profiles()).toEqual([]);
    const retry = await f.peer({ profile, explicitReconnect: true });
    expect(retry.messages).toEqual([]);
    // No claim of restart durability when the filesystem accepted no evidence.
    expect(fs.readdirSync(f.bridge.directory).some(name => name.startsWith("disconnected-profiles.json"))).toBe(false);
  } finally { await f.close(); }
});

test("native Mac handback releases only its own pauses, never independent security faults", async () => {
  const f = await pauseFixture();
  f.chrome.bridge.call = async (_p, _g, _s, _r, method) => method === "open" ? { pageId: "owned" } : { ok: true };
  try {
    await f.browser.action("open", { url: "https://example.com" });
    await f.chrome.pauseForNativeHandoff();
    await expect(f.browser.action("snapshot")).rejects.toThrow("paused");
    await f.chrome.finishNativeHandoff();
    expect(await f.browser.action("snapshot")).toMatchObject({ humanUsing: false });
    await f.chrome.control("agent", "pause"); // Independent security pause.
    await f.chrome.pauseForNativeHandoff();
    await f.chrome.finishNativeHandoff();
    await expect(f.browser.action("snapshot")).rejects.toThrow("paused");
  } finally { await f.close(); }
});

test("settlement preserves human-used tabs and sign-in identity even when no tab survives", async () => {
  const f = await pauseFixture();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  f.chrome.bridge.call = async (_p, _g, _s, _r, method, params) => {
    calls.push({ method, params });
    if (method === "open") return { pageId: "human-tab" };
    if (method === "end") return { retained: [] }; // Human closed it during settlement.
    return { ok: true };
  };
  try {
    await f.browser.reserveLogin("login", "https://example.com");
    await f.browser.keepTab("deliverable");
    const marked = calls.length;
    await f.chrome.settle("agent", "run");
    expect(calls.slice(marked)).toEqual([
      { method: "pause", params: {} },
      { method: "end", params: {} },
    ]);
    expect(f.chrome.state("agent").task).toMatchObject({ handoff: "login", humanUsing: true, tabs: [], paused: false });
    expect(f.chrome.done("agent", "login")).toBe("login");
    expect(f.chrome.humanState()).toBe(false);
  } finally { await f.close(); }
});
