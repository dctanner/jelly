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
import {
  ChromeFrames,
  chromeFrame,
  chromeRequest,
  chromeParamsError,
  CHROME_MAX_FRAME,
  CHROME_MAX_REQUEST,
  CHROME_PROTOCOL,
  CHROME_METHODS,
} from "../src/shared/chrome-protocol";

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

const reply = (p: { socket: Socket }, generation: string, id: string, body: Record<string, unknown>) =>
  p.socket.write(chromeFrame({ jsonrpc: "2.0", id, generation, ...body }));

test("Chrome framing is incremental, linear for large chunked frames, and bounded", () => {
  const parser = new ChromeFrames(),
    frame = chromeFrame({ ok: true });
  expect(parser.push(frame.subarray(0, 2))).toEqual([]);
  expect(parser.push(frame.subarray(2))).toEqual([{ ok: true }]);
  expect(parser.push(Buffer.concat([frame, frame]))).toHaveLength(2);
  // Thousands of small notifications in one chunk are not a "flood".
  expect(parser.push(Buffer.concat(Array.from({ length: 5000 }, () => frame)))).toHaveLength(5000);
  // A 20 MiB extension->host result arriving in 64 KiB pieces.
  const big = chromeFrame({ data: "x".repeat(20 * 1024 * 1024) });
  const values: unknown[] = [];
  const started = performance.now();
  for (let i = 0; i < big.length; i += 65536) values.push(...parser.push(big.subarray(i, i + 65536)));
  expect(values).toHaveLength(1);
  expect((values[0] as { data: string }).data.length).toBe(20 * 1024 * 1024);
  expect(performance.now() - started).toBeLessThan(5000);
  const large = Buffer.alloc(4);
  large.writeUInt32LE(CHROME_MAX_FRAME + 1);
  expect(() => new ChromeFrames().push(large)).toThrow();
  expect(CHROME_MAX_FRAME).toBe(32 * 1024 * 1024);
  expect(() => chromeFrame("x".repeat(CHROME_MAX_FRAME))).toThrow();
  expect(() => chromeFrame("x".repeat(CHROME_MAX_REQUEST), CHROME_MAX_REQUEST)).toThrow("too large");
});

test("protocol v9 validates envelopes and params with specific errors", () => {
  const base = { jsonrpc: "2.0", id: "i", instance: "i", generation: "g", session: "s", run: "r" };
  const ok = (method: string, params: Record<string, unknown>) => chromeRequest({ ...base, method, params });
  expect(CHROME_PROTOCOL).toBe(9);
  expect(ok("Runtime.evaluate", {})).toBe(false);
  expect(ok("begin", { name: "Task", agent: "a" })).toBe(true);
  expect(ok("begin", { name: "Task", protected: [] })).toBe(false);
  expect(ok("createTab", {})).toBe(true);
  expect(ok("createTab", { url: "chrome://settings/" })).toBe(true); // no URL policy
  expect(ok("claimTab", { tabId: 7 })).toBe(true);
  expect(ok("claimTab", { tabId: "7" })).toBe(false);
  expect(ok("markTab", { tabId: 7, mark: null })).toBe(true);
  expect(ok("markTab", { tabId: 7, mark: "temporary" })).toBe(false);
  expect(ok("cdp", { tabId: 1, method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "Control" } })).toBe(true);
  expect(ok("cdp", { tabId: 1, sessionId: "child", method: "Runtime.evaluate", timeoutMs: 60000 })).toBe(true);
  expect(ok("cdp", { tabId: 1, method: "evaluate" })).toBe(false);
  expect(ok("cdp", { tabId: 1, method: "Runtime.evaluate", params: [] })).toBe(false);
  expect(ok("cdpBatch", { tabId: 1, commands: [{ method: "Input.insertText", params: { text: "a" } }] })).toBe(true);
  expect(ok("cdpBatch", { tabId: 1, commands: [] })).toBe(false);
  expect(ok("cdpBatch", { tabId: 1, commands: Array.from({ length: 2001 }, () => ({ method: "Page.enable" })) })).toBe(false);
  expect(chromeParamsError("cdpBatch", { tabId: 1, commands: [{ method: "Page.enable" }, { method: "bad" }] })).toContain("command 1");
  expect(ok("chrome", { namespace: "cookies", method: "getAll", args: [{}] })).toBe(true);
  expect(ok("chrome", { namespace: "debugger", method: "attach", args: [] })).toBe(false);
  expect(chromeParamsError("closeTab", { tabId: 1, extra: true })).toContain("unexpected parameter(s) extra");
  for (const method of CHROME_METHODS) expect(typeof method).toBe("string");
});

test("Chrome bridge authenticates profile/generation, isolates requests and rejects stale connections", async () => {
  const f = await fixture();
  try {
    expect(statSync(f.bridge.directory).mode & 0o777).toBe(0o700);
    expect(statSync(f.config.socket).mode & 0o777).toBe(0o600);
    for (const bad of [{ grant: "wrong" }, { instance: "wrong" }, { extensionId: "b".repeat(32) }, { version: 8 }, { capabilities: [] }]) {
      const p = await f.peer(bad);
      expect(p.socket.destroyed).toBe(true);
    }
    const profile = crypto.randomUUID(),
      generation = crypto.randomUUID();
    const p = await f.peer({ profile, generation });
    expect(p.messages[0].type).toBe("paired");
    expect(p.messages[0].version).toBe(9);
    const other = await f.peer();
    const pending = f.bridge.call(profile, generation, "session", "run", "cdp", { tabId: 1, method: "Runtime.evaluate" });
    await waitFor(() => p.messages.length >= 2);
    const req = p.messages[1];
    expect(req).toMatchObject({ session: "session", run: "run", method: "cdp", params: { tabId: 1, method: "Runtime.evaluate" } });
    expect(other.messages).toHaveLength(1);
    reply(p, generation, req.id, { result: { result: { type: "number", value: 2 } } });
    expect(await pending).toEqual({ result: { type: "number", value: 2 } });
    await expect(f.bridge.call(profile, crypto.randomUUID(), "s", "r", "listTabs", {})).rejects.toThrow("disconnected");
    const indeterminate = f.bridge.call(profile, generation, "s", "r", "listTabs", {});
    void indeterminate.catch(() => {});
    await waitFor(() => p.messages.length >= 3);
    p.socket.destroy();
    await expect(indeterminate).rejects.toThrow("indeterminate");
  } finally {
    await f.close();
  }
});

test("bridge rejects with the extension's real error message, truncated to 2000 chars", async () => {
  const f = await fixture();
  try {
    const profile = crypto.randomUUID(), generation = crypto.randomUUID();
    const p = await f.peer({ profile, generation });
    const call = () => f.bridge.call(profile, generation, "s", "r", "cdp", { tabId: 1, method: "DOM.getDocument" });
    let pending = call().catch((e: Error) => e);
    await waitFor(() => p.messages.length === 2);
    reply(p, generation, p.messages[1].id, { error: { code: -32000, message: 'Timed out running CDP command "DOM.getDocument" after 10000ms.' } });
    let error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Timed out running CDP command "DOM.getDocument" after 10000ms.');
    pending = call().catch((e: Error) => e);
    await waitFor(() => p.messages.length === 3);
    reply(p, generation, p.messages[2].id, { error: { code: -32000, message: "y".repeat(5000) } });
    error = await pending;
    expect((error as Error).message.length).toBe(2001);
    pending = call().catch((e: Error) => e);
    await waitFor(() => p.messages.length === 4);
    reply(p, generation, p.messages[3].id, { error: { code: -32000 } });
    expect(((await pending) as Error).message).toBe("Chrome extension request failed.");
    expect(p.socket.destroyed).toBe(false);
  } finally { await f.close(); }
});

test("per-request timeout and abort reject only that request; the connection survives", async () => {
  const f = await fixture();
  try {
    const profile = crypto.randomUUID(), generation = crypto.randomUUID();
    const p = await f.peer({ profile, generation });
    const slow = f.bridge.call(profile, generation, "s", "r", "cdp", { tabId: 1, method: "Page.navigate" }, undefined, 50);
    await expect(slow).rejects.toThrow('Chrome request "cdp" timed out after 50ms');
    const controller = new AbortController();
    const aborted = f.bridge.call(profile, generation, "s", "r", "listTabs", {}, controller.signal);
    await waitFor(() => p.messages.length === 3);
    controller.abort(new Error("caller gave up"));
    await expect(aborted).rejects.toThrow("caller gave up");
    // Late replies to settled requests are ignored; the socket is intact.
    reply(p, generation, p.messages[1].id, { result: { late: true } });
    reply(p, generation, p.messages[2].id, { result: { late: true } });
    const next = f.bridge.call(profile, generation, "s", "r", "listTabs", {});
    await waitFor(() => p.messages.length === 4);
    reply(p, generation, p.messages[3].id, { result: { tabs: [] } });
    expect(await next).toEqual({ tabs: [] });
    expect(p.socket.destroyed).toBe(false);
    expect(f.bridge.profiles()).toHaveLength(1);
  } finally { await f.close(); }
});

test("bridge allows 256 concurrent requests and refuses oversized requests without disconnecting", async () => {
  const f = await fixture();
  try {
    const profile = crypto.randomUUID(), generation = crypto.randomUUID();
    const p = await f.peer({ profile, generation });
    const calls = Array.from({ length: 256 }, (_, i) =>
      f.bridge.call(profile, generation, "s", "r", "cdp", { tabId: 1, method: "Runtime.evaluate", params: { expression: String(i) } }));
    await expect(f.bridge.call(profile, generation, "s", "r", "listTabs", {})).rejects.toThrow("busy");
    await waitFor(() => p.messages.length === 257);
    // Responses may arrive in any order.
    for (const m of p.messages.slice(1).reverse()) reply(p, generation, m.id, { result: m.params.params.expression });
    expect(await Promise.all(calls)).toEqual(Array.from({ length: 256 }, (_, i) => String(i)));
    await expect(f.bridge.call(profile, generation, "s", "r", "cdp",
      { tabId: 1, method: "Runtime.evaluate", params: { expression: "x".repeat(CHROME_MAX_REQUEST) } })).rejects.toThrow("too large");
    expect(p.socket.destroyed).toBe(false);
  } finally { await f.close(); }
});

test("Chrome bridge retains large requests until socket drain", async () => {
  const f = await fixture();
  try {
    const profile = crypto.randomUUID(), generation = crypto.randomUUID();
    const p = await f.peer({ profile, generation });
    const payload = "x".repeat(900000);
    const pending = f.bridge.call(profile, generation, "session", "run", "cdp", { tabId: 1, method: "Input.insertText", params: { text: payload } });
    await waitFor(() => p.messages.length >= 2);
    expect(p.messages[1]?.params.params.text).toBe(payload);
    reply(p, generation, p.messages[1].id, { result: {} });
    expect(await pending).toEqual({});
  } finally { await f.close(); }
});

test("Chrome bridge fails stalled socket writes after a bounded drain wait", async () => {
  const f = await fixture();
  try {
    const profile = crypto.randomUUID(), generation = crypto.randomUUID();
    const p = await f.peer({ profile, generation });
    p.socket.pause();
    const pending = f.bridge.call(profile, generation, "session", "run", "cdp",
      { tabId: 1, method: "Input.insertText", params: { text: "x".repeat(900000) } });
    await expect(pending).rejects.toThrow("indeterminate");
    expect(f.bridge.profiles()).toEqual([]);
  } finally { await f.close(); }
}, 12000);

test("bridge forwards authenticated cdpEvent, cdpDetach, tabAdded, tabRemoved and pauseState notifications", async () => {
  const f = await fixture();
  try {
    const profile = crypto.randomUUID(), generation = crypto.randomUUID();
    const p = await f.peer({ profile, generation });
    const seen: unknown[][] = [];
    f.bridge.onCdpEvent = (...args) => seen.push(["cdpEvent", ...args]);
    f.bridge.onCdpDetach = (...args) => seen.push(["cdpDetach", ...args]);
    f.bridge.onTabAdded = (...args) => seen.push(["tabAdded", ...args]);
    f.bridge.onTabRemoved = (...args) => seen.push(["tabRemoved", ...args]);
    f.bridge.onPauseState = (...args) => seen.push(["pauseState", ...args]);
    const route = { generation, session: "s", run: "r" };
    const tab = { id: 9, title: "Popup", url: "https://example.com/", windowId: 1, active: false, origin: "agent", mark: null };
    // Event bursts well beyond the old 256/s limit are fine.
    const burst = Array.from({ length: 2000 }, (_, i) =>
      chromeFrame({ type: "cdpEvent", ...route, tabId: 3, method: "Network.dataReceived", params: { i } }));
    p.socket.write(Buffer.concat([
      ...burst,
      chromeFrame({ type: "cdpEvent", ...route, tabId: 3, sessionId: "child", method: "Page.loadEventFired", params: { timestamp: 1 } }),
      chromeFrame({ type: "cdpDetach", ...route, tabId: 3, reason: "canceled_by_user" }),
      chromeFrame({ type: "tabAdded", ...route, tab }),
      chromeFrame({ type: "tabRemoved", ...route, tabId: 9 }),
      chromeFrame({ type: "pauseState", ...route, state: "paused", reason: "native_handoff" }),
      chromeFrame({ type: "pauseState", ...route, state: "failed", reason: "PRIVATE raw" }),
      chromeFrame({ type: "someFutureNotification", ...route }),
    ]));
    await waitFor(() => seen.length === 2006);
    const head = [profile, generation, "s", "r"];
    expect(seen[1999]).toEqual(["cdpEvent", ...head, { tabId: 3, method: "Network.dataReceived", params: { i: 1999 } }]);
    expect(seen.slice(2000)).toEqual([
      ["cdpEvent", ...head, { tabId: 3, sessionId: "child", method: "Page.loadEventFired", params: { timestamp: 1 } }],
      ["cdpDetach", ...head, 3, "canceled_by_user"],
      ["tabAdded", ...head, tab],
      ["tabRemoved", ...head, 9],
      ["pauseState", ...head, "paused", "native_handoff"],
      ["pauseState", ...head, "failed", undefined],
    ]);
    p.socket.write(chromeFrame({ type: "tabRemoved", ...route, generation: "stale", tabId: 9 }));
    await waitFor(() => p.socket.destroyed);
    expect(seen).toHaveLength(2006);
  } finally { await f.close(); }
});

test("malformed notifications are rejected", async () => {
  const f = await fixture();
  try {
    for (const bad of [
      { type: "cdpEvent", tabId: "3", method: "Page.loadEventFired" },
      { type: "cdpEvent", tabId: 3 },
      { type: "cdpDetach", tabId: 3 },
      { type: "tabAdded", tab: "cap" },
      { type: "tabRemoved", tab: "cap" },
      { type: "pauseState", state: "PRIVATE" },
    ]) {
      const p = await f.peer({ generation: crypto.randomUUID() });
      p.socket.write(chromeFrame({ ...bad, generation: p.messages[0].generation, session: "s", run: "r" }));
      await waitFor(() => p.socket.destroyed);
    }
  } finally { await f.close(); }
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
