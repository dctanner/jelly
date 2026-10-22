import { expect, test } from "bun:test";
import { connect } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";
import { ChromeSessions } from "../src/server/chrome-sessions";
import { CHROME_METHODS, CHROME_PROTOCOL, ChromeFrames, chromeFrame } from "../src/shared/chrome-protocol";
import { ownedBusProxyArgs, ownedBusProxyAlive, allowOwnedStaleProfile, ownedConfigHash, ownedProcess, profileLocks, privateJson, OwnedChromeDesktop, authBindingAlive, type OwnedChromeConfig } from "../src/server/owned-chrome-desktop";
import { startApp } from "./fixtures/app";

test("owned Chrome bus routing grants only Secret Service, never desktop portal or wildcard names", () => {
  expect(ownedBusProxyArgs("unix:path=/synthetic/bus", "/synthetic/socket")).toEqual([
    "unix:path=/synthetic/bus", "/synthetic/socket", "--filter", "--talk=org.freedesktop.secrets",
  ]);
  expect(ownedBusProxyAlive(undefined as any, "/synthetic")).toBe(false);
  expect(ownedBusProxyAlive({ process: ownedProcess(process.pid), path: "/synthetic/bus-test/socket", socket: [] }, "/synthetic")).toBe(false);
});

async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) { if (Date.now() > end) throw new Error("Deferred fixture timed out"); await Bun.sleep(10); }
}
async function pendingFixture(acknowledge = true) {
  const dir = mkdtempSync(join(tmpdir(), "jelly-owned-peer-"));
  const chrome = new ChromeSessions(dir, "owned-test");
  await chrome.bridge.ready;
  const auth = join(dir, "auth"); writeFileSync(auth, "synthetic", { mode: 0o600 });
  const config = JSON.parse(await Bun.file(join(chrome.bridge.directory, "pairing.json")).text());
  writeFileSync(join(chrome.bridge.directory, "extension-id"), "a".repeat(32), { mode: 0o600 });
  // Fixture-only attestor: production requires exact owned launcher/native parent.
  chrome.bridge.attestDesktop = (_d, parent) => parent === "fixture-owned-parent" ? { available: true, display: ":3998", auth } : null;
  chrome.setHumanDesktop(true);
  const profile = crypto.randomUUID(), generation = crypto.randomUUID(), messages: any[] = [];
  const frames = new ChromeFrames();
  const socket = connect(config.socket);
  socket.on("error", () => {});
  socket.on("data", data => {
    for (const message of frames.push(Buffer.from(data)) as any[]) {
      messages.push(message);
      if (message.type === "pending" && acknowledge)
        socket.write(chromeFrame({ type: "pendingReady", generation }));
    }
  });
  socket.write(chromeFrame({ type: "hello", version: CHROME_PROTOCOL, capabilities: CHROME_METHODS, instance: "owned-test", grant: config.grant,
    extensionId: "a".repeat(32), profile, generation, desktop: { available: false }, ownedParent: "fixture-owned-parent" }));
  await until(() => messages.length > 0);
  return { chrome, socket, profile, generation, messages, close: async () => { socket.destroy(); await chrome.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("owned native attestation pairs immediately during human use without browser freeze or publication handback", async () => {
  const f = await pendingFixture();
  try {
    expect(f.messages[0].type).toBe("paired");
    expect(f.chrome.bridge.profiles().map(p => p.id)).toEqual([f.profile]);
    expect(() => f.chrome.allocate("a", "run", { chromeProfile: f.profile, chromeOrigins: ["https://example.com"] }, "A")).not.toThrow();
    expect(f.chrome.humanState()).toBe(true);
    expect(f.messages.filter(m => m.method)).toEqual([]);
    expect(f.chrome.bridge.desktop(f.profile, f.generation).available).toBe(true);
  } finally { await f.close(); }
});

test("a newly paired owned peer still rejects forged-generation events", async () => {
  const f = await pendingFixture();
  try {
    f.socket.write(chromeFrame({ jsonrpc: "2.0", id: "forged", generation: "foreign", result: {} }));
    await until(() => f.chrome.bridge.profiles().length === 0);
    expect(f.chrome.humanState()).toBe(true);
  } finally { await f.close(); }
});

test("owned private records refuse unsafe permissions and do not read public path parameters", () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-owned-config-test-"));
  const path = join(dir, "config.json");
  try {
    writeFileSync(path, '{"fixture":true}', { mode: 0o600 });
    expect(privateJson<{ fixture: boolean }>(path)).toEqual({ fixture: true });
    chmodSync(path, 0o644);
    expect(() => privateJson(path)).toThrow("Unsafe owned Chrome");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("owned stale admission requires recorded artifact identity and conclusively absent PID, never just a mismatched start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-owned-stale-test-"));
  const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  try {
    // Synthetic symlinks only, not an actual Chrome profile or IPC cookie.
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
      symlinkSync(name === "SingletonLock" ? `${hostname()}-${child.pid}` : "synthetic", join(dir, name));
    const browser = ownedProcess(child.pid);
    const config = { root: dir, previous: { unit: "fixture.service", browser, locks: profileLocks(dir) } } as OwnedChromeConfig;
    expect(allowOwnedStaleProfile(config, dir)).toBe(false);
    child.kill("SIGTERM"); await child.exited;
    expect(allowOwnedStaleProfile(config, dir)).toBe(true);
    expect(allowOwnedStaleProfile({ ...config, previous: null }, dir)).toBe(false);
    rmSync(join(dir, "SingletonCookie"));
    symlinkSync("different-synthetic", join(dir, "SingletonCookie"));
    expect(allowOwnedStaleProfile(config, dir)).toBe(false);
  } finally { if (child.exitCode === null) { child.kill(); await child.exited; } rmSync(dir, { recursive: true, force: true }); }
});

test("unknown host/owner or reused live PID never qualifies as owned stale", () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-owned-stale-test-"));
  try {
    symlinkSync(`${hostname()}-${process.pid}`, join(dir, "SingletonLock"));
    const config = { root: dir, previous: { unit: "fixture.service", browser: { ...ownedProcess(process.pid), start: "old-unrelated-generation" }, locks: profileLocks(dir) } } as OwnedChromeConfig;
    expect(allowOwnedStaleProfile(config, dir)).toBe(false);
    rmSync(join(dir, "SingletonLock"));
    symlinkSync("different-host-99999999", join(dir, "SingletonLock"));
    config.previous!.browser.pid = 99999999;
    config.previous!.locks = profileLocks(dir);
    expect(allowOwnedStaleProfile(config, dir)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("structured predecessor unit proof rejects flattened unsafe switches, hidden root overrides and identity changes without host queries", async () => {
  const child = Bun.spawn(["/usr/bin/python3", "tests/connected-chrome-unit.py"], { stdout: "pipe", stderr: "pipe" });
  const result = await child.exited;
  const output = await new Response(child.stderr).text();
  expect(result).toBe(0);
  expect(output).toContain("Ran 8 tests");
  expect(output).toContain("OK");
  expect(await new Response(child.stdout).text()).toBe("");
});

test("pre-pair Take requires private cookie/CSRF/origin and accepts no executable/profile/display/auth paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-owned-api-"));
  const app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
  try {
    const agentId = app.store.agents()[0]!.id;
    const bootstrap = await fetch(new URL("/api/control-session", app.server.url));
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!, csrf = (await bootstrap.json()).csrf;
    const post = (headers: Record<string, string>, body: unknown = { agentId }) => fetch(new URL("/api/chrome/share/take-owned", app.server.url), {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    expect((await post({})).status).toBe(401);
    expect((await post({ cookie })).status).toBe(403);
    expect((await post({ cookie, "x-jelly-csrf": csrf, Origin: "https://foreign.invalid" })).status).toBe(403);
    for (const key of ["root", "profile", "binary", "display", "auth", "bus"])
      expect((await post({ cookie, "x-jelly-csrf": csrf }, { agentId, [key]: "/arbitrary" })).status).toBe(400);
    expect(app.service.chromeShare.state().status).toBe("idle");
    expect(app.service.chrome.humanState()).toBe(false);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

async function setupFixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-owned-setup-test-")), root = join(dir, "existing"), instance = "owned-dir-test";
  mkdirSync(join(root, "Default"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "chrome-bridge"), { mode: 0o700 });
  writeFileSync(join(dir, "chrome-bridge/pairing.json"), JSON.stringify({ instance }), { mode: 0o600 });
  const owned = new OwnedChromeDesktop(dir, instance);
  const setup = async (...extra: string[]) => {
    const child = Bun.spawn([process.execPath, "scripts/setup-connected-chrome-desktop.ts", "--data-dir", dir, "--chrome-root", root,
      "--profile", "Default", "--unit-dir", join(dir, "units"), ...extra], { stdout: "ignore", stderr: "ignore" });
    return child.exited;
  };
  return { dir, root, owned, setup };
}

test("failed predecessor attestation writes no installation and ordinary retry succeeds; unknown artifacts remain", async () => {
  const f = await setupFixture();
  try {
    // Nonexistent fixture PID fails before any bus/unit query.
    expect(await f.setup("--previous-pid", "99999999", "--previous-unit", "fixture.service", "--previous-invocation", "a".repeat(32))).not.toBe(0);
    expect(existsSync(f.owned.directory)).toBe(false);
    expect(await f.setup()).toBe(0);
    expect(f.owned.config().rootIdentity.ino).toBeTruthy();
    const sentinel = join(f.owned.directory, "unknown-owner-artifact");
    writeFileSync(sentinel, "preserve");
    expect(await f.setup()).not.toBe(0);
    expect(existsSync(sentinel)).toBe(true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("launcher refuses missing/replaced/symlink selected root or profile without creating a different profile", async () => {
  const f = await setupFixture();
  try {
    expect(await f.setup()).toBe(0);
    writeFileSync(join(f.root, "Default/legitimate-content-change"), "fixture");
    expect(f.owned.config()).toBeTruthy(); // directory ctime is deliberately NOT bound
    for (const path of [f.root, join(f.root, "Default")]) {
      for (const mode of ["missing", "replacement", "symlink"]) {
        const old = path + ".saved";
        renameSync(path, old);
        try {
          if (mode === "replacement") mkdirSync(path, { mode: 0o700 });
          if (mode === "symlink") symlinkSync(old, path);
          const launch = Bun.spawn([join(f.owned.directory, "launch")], { stdout: "ignore", stderr: "ignore" });
          expect(await launch.exited).not.toBe(0);
          if (mode === "missing") expect(existsSync(path)).toBe(false);
          expect(existsSync(join(f.owned.directory, "Xauthority"))).toBe(false);
          expect(existsSync(join(f.owned.directory, "desktop.json"))).toBe(false);
        } finally {
          if (mode !== "missing") rmSync(path, { recursive: true, force: true });
          renameSync(old, path);
        }
      }
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("versioned protected-service fast auth guard uses process stamps and exact kernel endpoint, no helper fork/exe fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-owned-auth-cache-"));
  const path = join(dir, "control");
  const { createServer } = await import("node:net");
  const { lstatSync, readFileSync } = await import("node:fs");
  const server = createServer(); await new Promise<void>(done => server.listen(path, done));
  try {
    const p = ownedProcess(process.pid), st = lstatSync(path, { bigint: true });
    const row = readFileSync("/proc/net/unix", "utf8").split("\n").map(v => v.trim().split(/\s+/)).find(v => v[7] === path)!;
    const binding = { version: 2, kind: "systemd-socket", pid: p.pid, start: p.start, exe: "/protected/metadata/not-readable",
      control: path, bus: "unix:path=/private-fixture", owner: ":fixture", socket: [String(st.dev), String(st.ino), String(st.ctimeNs)],
      kernelInode: row[6], manager: { pid: p.pid, start: p.start, owner: ":manager" } };
    expect(authBindingAlive(binding)).toBe(true);
    expect(authBindingAlive({ ...binding, version: 1, kind: "direct" })).toBe(false);
    expect(authBindingAlive({ ...binding, start: "different" })).toBe(false);
    expect(authBindingAlive({ ...binding, manager: { ...binding.manager, start: "different" } })).toBe(false);
    expect(authBindingAlive({ ...binding, kernelInode: "0" })).toBe(false);
  } finally { await new Promise<void>(done => server.close(() => done())); rmSync(dir, { recursive: true, force: true }); }
});


test("cleanup record needs original private config/generation/binding but not living Chrome; launcher preserves latched evidence", async () => {
  const f = await setupFixture();
  try {
    expect(await f.setup()).toBe(0);
    const binding = { display: ":3999", auth: join(f.owned.directory, "Xauthority"), socketPath: "/tmp/.X11-unix/X3999",
      socketDev: "1", socketIno: "2", socketCtime: "3", authHash: "a".repeat(64) };
    const generation = crypto.randomUUID();
    const record = { version: 1, instance: f.owned.instance, configHash: ownedConfigHash(f.owned.config()), generation, binding };
    const path = join(f.owned.directory, "desktop.json");
    writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
    expect(f.owned.cleanupRecord(generation, binding)).toEqual(record as any);
    expect(() => f.owned.record()).toThrow();
    expect(() => f.owned.cleanupRecord(crypto.randomUUID(), binding)).toThrow();
    expect(() => f.owned.cleanupRecord(generation, { ...binding, authHash: "b".repeat(64) })).toThrow();
    chmodSync(path, 0o644);
    expect(() => f.owned.cleanupRecord(generation, binding)).toThrow();
    chmodSync(path, 0o600);
    writeFileSync(join(f.dir, "chrome-bridge/desktop-share.json"), "{}", { mode: 0o600 });
    const launch = Bun.spawn([join(f.owned.directory, "launch")], { stdout: "ignore", stderr: "ignore" });
    const code = await Promise.race([launch.exited, Bun.sleep(5000).then(() => { launch.kill("SIGKILL"); return -1; })]);
    expect(code).not.toBe(-1); expect(code).not.toBe(0);
    expect(existsSync(binding.auth)).toBe(false);
    expect(f.owned.cleanupRecord(generation, binding)).toEqual(record as any);
    renameSync(join(f.root, "Default"), join(f.root, "OldDefault"));
    mkdirSync(join(f.root, "Default"));
    expect(() => f.owned.cleanupRecord(generation, binding)).toThrow();
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
