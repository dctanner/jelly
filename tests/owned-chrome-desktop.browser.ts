import { chromium } from "playwright-core";
import { expect } from "bun:test";
import { mkdtempSync, mkdirSync, lstatSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startApp } from "./fixtures/app";
import { openChromeViewer } from "./fixtures/chrome-viewer";
import { OwnedChromeDesktop, sameOwnedProcess } from "../src/server/owned-chrome-desktop";

// This child runs inside the private activation-free keyring fixture. The normal
// Chrome analogue is ordinary headed native Chrome: NO CDP/Playwright attachment.
const fixtureRoot = process.env.FIXTURE_ROOT!;
if (!fixtureRoot?.startsWith("/tmp/jelly-os-auth-") || !process.env.FIXTURE_CONTROL?.startsWith(fixtureRoot)) throw new Error("Private authentication fixture required");
const dir = mkdtempSync(join(tmpdir(), "jelly-owned-chrome-test-"));
symlinkSync(resolve(".jelly/runtime"), join(dir, "runtime"));
const root = join(dir, "existing-profile"), home = join(dir, "home");
mkdirSync(join(root, "Default"), { recursive: true, mode: 0o700 });
mkdirSync(join(home, ".config"), { recursive: true, mode: 0o700 });
let app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
const instance = app.store.instance().id;
const owned = new OwnedChromeDesktop(dir, instance);
let runner: ReturnType<typeof Bun.spawn> | undefined;
let viewer: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let cookieSeen = false, siteRequests = 0, nativeClaims = 0, acceptedClaims = 0, phase = "setup";
const nativeAttestor = app.service.chrome.bridge.attestDesktop;
app.service.chrome.bridge.attestDesktop = (...args) => {
  nativeClaims++;
  const result = nativeAttestor(...args);
  if (result) acceptedClaims++;
  return result;
};
const site = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch(req) {
  siteRequests++;
  if (new URL(req.url).pathname === "/check") cookieSeen = req.headers.get("cookie")?.includes("fixture_existing_profile=retained") ?? false;
  return new Response('<body style="background:rgb(51,204,51)"><h1>Existing ordinary Chrome profile fixture</h1>', {
    headers: { "Content-Type": "text/html", "Set-Cookie": "fixture_existing_profile=retained; Path=/; Max-Age=3600; SameSite=Lax" },
  });
} });
async function command(args: string[], env: Record<string, string | undefined> = process.env) {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  if (code) throw new Error(`Fixture command failed (${code}): ${await new Response(child.stderr).text()}`);
}
async function until(check: () => boolean | Promise<boolean>, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error(`Owned fixture timed out: ${check.toString().slice(0, 160)}`); await Bun.sleep(40); }
}
async function keyringLocked() {
  const child = Bun.spawn(["/usr/bin/python3", "-c", `import importlib.util,os; s=importlib.util.spec_from_file_location('auth','${resolve("scripts/connected-chrome-os-auth.py")}'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(int(m.snapshot(os.environ['FIXTURE_CONTROL'],os.environ['DBUS_SESSION_BUS_ADDRESS'])[1]))`], { stdout: "pipe", stderr: "ignore" });
  if (await child.exited) throw new Error("Private daemon binding lost");
  return (await new Response(child.stdout).text()).trim() === "1";
}
try {
  const extension = join(dir, "extension");
  await command([process.execPath, "scripts/build-chrome-extension.ts", extension], process.env);
  for (const chromeRoot of [root, join(home, ".config/google-chrome-for-testing"), join(home, ".config/google-chrome"), join(home, ".config/chromium")])
    await command([process.execPath, "scripts/install-chrome-host.ts", "--data-dir", dir, "--chrome-config", chromeRoot]);
  // Test-only executable adds unpacked fixture loading. The installed production
  // launcher never adds these or any debugging flags to the selected normal root.
  const wrapper = join(dir, "chrome");
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  writeFileSync(wrapper, `#!/bin/sh\nexport CHROME_DEVEL_SANDBOX=/opt/google/chrome/chrome-sandbox\nexec ${quote(process.env.JELLY_FIXTURE_BROWSER!)} --disable-extensions-except=${quote(extension)} --load-extension=${quote(extension)} "$@" 2>${quote(join(dir, "fixture-chrome.log"))}\n`, { mode: 0o700 });
  const wm = join(dir, "openbox");
  const wmBinary = process.env.JELLY_FIXTURE_OPENBOX || "/usr/bin/openbox";
  if (!existsSync(wmBinary)) throw new Error("Install Openbox or provide JELLY_FIXTURE_OPENBOX for a disposable fixture package.");
  writeFileSync(wm, `#!/bin/sh\n${process.env.JELLY_FIXTURE_WM_LIBRARY ? `export LD_LIBRARY_PATH=${quote(process.env.JELLY_FIXTURE_WM_LIBRARY)}\n` : ""}${process.env.JELLY_FIXTURE_WM_DATA ? `export XDG_DATA_DIRS=${quote(process.env.JELLY_FIXTURE_WM_DATA)}\n` : ""}exec ${quote(wmBinary)} "$@"\n`, { mode: 0o700 });
  await command([process.execPath, "scripts/setup-connected-chrome-desktop.ts", "--data-dir", dir, "--chrome-root", root, "--profile", "Default", "--chrome-binary", wrapper,
    "--home", home, "--wm-binary", wm, "--bus", process.env.DBUS_SESSION_BUS_ADDRESS!, "--keyring-control", process.env.FIXTURE_CONTROL!, "--unit-dir", join(dir, "units")]);
  expect(existsSync(join(owned.directory, "desktop.json"))).toBe(false); // setup never starts a unit
  // A fixture-owned conflicting lock refuses before any X server/browser starts.
  symlinkSync("unrelated-fixture-host-99999999", join(root, "SingletonLock"));
  const refused = Bun.spawn([join(owned.directory, "launch")], { stdout: "ignore", stderr: "ignore" });
  expect(await refused.exited).toBe(1);
  expect(existsSync(join(owned.directory, "desktop.json"))).toBe(false);
  rmSync(join(root, "SingletonLock")); // only the synthetic sentinel we created
  runner = Bun.spawn([join(owned.directory, "launch")], { stdout: "ignore", stderr: "inherit" });
  await until(() => owned.available());
  let original = owned.record();
  expect(app.service.chromeShare.state().ownedDesktopAvailable).toBe(true);
  expect(await keyringLocked()).toBe(true);
  const launchAgain = Bun.spawn([join(owned.directory, "launch")], { stdout: "ignore", stderr: "ignore" });
  expect(await launchAgain.exited).not.toBe(0); // same instance runner flock
  expect(owned.record()).toEqual(original);
  const agent = app.store.agents()[0]!;
  // Sharing can open before an initialized/published extension profile exists.
  app.store.setBrowserSelection({ chromeProfile: crypto.randomUUID() });
  app.service.emit(agent.id, null, "message", { role: "user", text: "Owned private desktop fixture" });
  viewer = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
  const page = await viewer.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(app.server.url.origin);
  await page.getByTitle(`${agent.name} · idle`).click();
  await openChromeViewer(page);
  // The configured profile is unavailable. Choose the installed computer
  // explicitly; never silently retarget a configured/pinned desktop.
  await page.getByRole("button", { name: "Use installed computer" }).click();
  await page.getByText(/installed computer is available before Chrome connects/).waitFor();
  expect(await page.locator('input[type="password"]').count()).toBe(0);
  expect(await page.locator("canvas").count()).toBe(0);
  const unauthorized = await fetch(new URL("/api/chrome/share/take-owned", app.server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: agent.id }) });
  expect(unauthorized.status).toBe(401);
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page.getByText(/You’re using the computer/).waitFor({ timeout: 20000 });
  expect(app.service.chrome.humanState()).toBe(true);
  await page.waitForFunction(() => (document.querySelector(".chrome-share-screen canvas") as HTMLCanvasElement)?.width === 1280);
  const remoteClick = async (x: number, y: number) => {
    const point = await page.locator(".chrome-share-screen canvas").boundingBox();
    if (!point) throw new Error("No private viewer canvas");
    await page.mouse.click(point.x + point.width * x / 1280, point.y + point.height * y / 900);
  };
  // GTK is a separate mapped X window; native RFB pointer/keyboard, no secret
  // field in Jelly and no normal-profile CDP. Enter synthetic fixture password.
  const geometry = Bun.spawn(["/usr/bin/python3", "tests/fixtures/owned-x11-auth-window.py"], { env: { PATH: "/usr/bin:/bin", DISPLAY: original.binding.display, XAUTHORITY: original.binding.auth }, stdout: "pipe", stderr: "ignore" });
  expect(await geometry.exited).toBe(0);
  const authWindow = JSON.parse(await new Response(geometry.stdout).text());
  phase = "private-auth";
  await remoteClick(authWindow.x + 200, authWindow.y + 125);
  await page.keyboard.type("wrong-disposable-passphrase");
  await page.keyboard.press("Enter");
  await Bun.sleep(200);
  expect(await keyringLocked()).toBe(true);
  await page.keyboard.type("disposable-fixture-passphrase");
  await page.keyboard.press("Enter");
  await until(async () => !await keyringLocked());
  // Human navigation through real VNC; pairing requires no popup or Connect.
  async function humanNavigate(url: string) {
    await remoteClick(1000, 200);
    await Bun.sleep(100); // Human UI pacing only, never an input cleanup fence.
    await page.keyboard.press("Control+l");
    await Bun.sleep(100);
    await page.keyboard.type(url, { delay: 5 });
    await page.keyboard.press("Enter");
  }
  phase = "first-native-navigation";
  await humanNavigate(site.url.href);
  await until(() => siteRequests > 0);
  await page.waitForFunction(() => {
    const c = document.querySelector(".chrome-share-screen canvas") as HTMLCanvasElement;
    const d = c?.getContext("2d")?.getImageData(0, 0, c.width, c.height).data;
    return d && d.some((_, i) => i % 4 === 0 && d[i] === 51 && d[i + 1] === 204 && d[i + 2] === 51);
  });
  phase = "automatic-connect-during-human-use";
  await until(() => app.service.chrome.bridge.profiles().length === 1);
  expect(app.service.chrome.humanState()).toBe(true);
  await humanNavigate(site.url.href);
  await page.waitForFunction(() => {
    const c = document.querySelector(".chrome-share-screen canvas") as HTMLCanvasElement;
    const d = c?.getContext("2d")?.getImageData(0, 0, c.width, c.height).data;
    return d && d.some((_, i) => i % 4 === 0 && d[i] === 51 && d[i + 1] === 204 && d[i + 2] === 51);
  });
  // Foreign cookie, missing CSRF and arbitrary-path bootstrap requests refuse.
  const other = await viewer.newContext();
  const foreign = await other.newPage(); await foreign.goto(app.server.url.origin);
  const denied = await foreign.evaluate(async (agentId) => {
    const { csrf } = await (await fetch("/api/control-session")).json();
    return (await fetch("/api/chrome/share/take-owned", { method: "POST", headers: { "Content-Type": "application/json", "x-jelly-csrf": csrf }, body: JSON.stringify({ agentId, root: "/arbitrary" }) })).status;
  }, agent.id);
  expect(denied).toBe(400);
  await other.close();
  phase = "normal-handback";
  // Keep actual Shift and pointer down across handback; the fixed X11 helper
  // verifies their release after all old input/socket/auth processes have ended.
  await page.keyboard.down("Shift");
  await page.mouse.move(500, 500); await page.mouse.down();
  await page.getByRole("button", { name: "Done", exact: true }).click({ force: true });
  await page.keyboard.up("Shift"); await page.mouse.up();
  await page.getByRole("button", { name: "Take control", exact: true }).waitFor();
  await until(() => app.service.chrome.bridge.profiles().length === 1);
  expect(app.service.chrome.humanState()).toBe(false);
  expect((app.service.chromeShare as any).authProcess).toBeNull();
  expect((app.service.chromeShare as any).process).toBeNull();
  expect((app.service.chromeShare as any).runtime).toBeNull();
  expect(owned.record()).toEqual(original);
  const profile = app.service.chrome.bridge.profiles()[0]!;
  const selection = { chromeProfile: profile.id };
  // Native extension navigation only after handback; normal root cookies survive.
  const browser = app.service.chrome.allocate(agent.id, "fixture-run", selection, "Existing profile");
  await browser.action("name", { name: "Existing profile" });
  const task = (app.service.chrome as any).tasks.get(agent.id);
  // Like the existing headed extension fixture, only this direct test call
  // reaches the local synthetic site; production model URL guards stay intact.
  await app.service.chrome.bridge.call(profile.id, profile.generation, task.id, task.run, "open", { url: new URL("/check", site.url).href });
  await until(() => cookieSeen);
  await app.service.chrome.settle(agent.id, "fixture-run");
  await page.goto("about:blank");
  await app.close();
  expect([original.runner, original.chrome, original.server].every(sameOwnedProcess)).toBe(true);
  app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
  expect(owned.record()).toEqual(original); // Jelly restart never kills display/browser
  // Wait for a committed synthetic-cookie metadata row, not a guessed flush
  // delay. Never query cookie values, encryption keys or any host profile.
  await until(async () => {
    const db = [join(root, "Default/Network/Cookies"), join(root, "Default/Cookies")].find(existsSync);
    if (!db) return false;
    const query = Bun.spawn(["/usr/bin/python3", "-c", "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); sys.exit(0 if c.execute(\"select count(*) from cookies where host_key='127.0.0.2' and name='fixture_existing_profile'\").fetchone()[0] else 1)", db], { stdout: "ignore", stderr: "ignore" });
    const committed = await query.exited === 0;
    if (!committed) await Bun.sleep(200);
    return committed;
  }, 45000);
  phase = "predecessor-listener-proof";
  await command(["/usr/bin/python3", "tests/fixtures/owned-chrome-predecessor.py", JSON.stringify({
    ...original.chrome, root, profile: "Default", home, unit: "jelly-predecessor-fixture.service", invocation: "a".repeat(32),
    rootIdentity: owned.config().rootIdentity, profileIdentity: owned.config().profileIdentity,
  })]);
  phase = "private-bus-loss-relaunch";
  expect(original.busProxy?.path.startsWith(owned.directory + "/bus-")).toBe(true);
  process.kill(original.busProxy!.process.pid, "SIGTERM"); // disposable proxy ONLY
  expect(await runner!.exited).toBe(1);
  expect([original.runner, original.chrome, original.server, original.manager, original.busProxy!.process].some(sameOwnedProcess)).toBe(false);
  expect(existsSync(original.busProxy!.path)).toBe(false);
  expect(lstatSync(join(root, "SingletonLock")).isSymbolicLink()).toBe(true);
  for (const p of [original.runner, original.chrome, original.server, original.manager]) expect(existsSync(`/proc/${p.pid}`)).toBe(false);
  // No Singleton artifact is manually removed. Native Chrome must retire its
  // proven own stale state and claim the same root on a newly owned display.
  runner = Bun.spawn([join(owned.directory, "launch")], { stdout: "ignore", stderr: "inherit" });
  await until(() => owned.available());
  const reopened = owned.record();
  expect(reopened.generation).not.toBe(original.generation);
  original = reopened;
  cookieSeen = false;
  await page.goto(app.server.url.origin);
  await page.getByTitle(`${agent.name} · idle`).click();
  await openChromeViewer(page);
  await page.getByRole("button", { name: "Use installed computer" }).click();
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page.getByText(/You’re using the computer/).waitFor();
  await humanNavigate(new URL("/check", site.url).href);
  await until(() => cookieSeen);
  await until(() => app.service.chrome.bridge.profiles().length === 1);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Take control", exact: true }).waitFor();
  expect(app.service.chrome.bridge.profiles()[0]!.id).toBe(profile.id);
  expect(app.service.chrome.bridge.profiles()[0]!.generation).not.toBe(profile.generation);
  await page.goto("about:blank");
  const session = await fetch(new URL("/api/control-session", app.server.url));
  const cookie = session.headers.get("set-cookie")!.split(";")[0]!, csrf = (await session.json()).csrf;
  const headers = { "Content-Type": "application/json", cookie, "x-jelly-csrf": csrf };
  const take = await fetch(new URL("/api/chrome/share/take-owned", app.server.url), { method: "POST", headers, body: JSON.stringify({ agentId: agent.id }) });
  expect(take.status).toBe(200);
  await app.close(); // interrupted private owner -> cleanup-only on new server
  runner!.kill("SIGTERM");
  await runner!.exited; // clean obligations already persisted; original display is now gone
  app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
  expect(app.service.chromeShare.state().status).toBe("orphaned");
  expect(app.service.chrome.humanState()).toBe(true);
  expect([original.runner, original.chrome, original.server].some(sameOwnedProcess)).toBe(false);
  const cleanupSession = await fetch(new URL("/api/control-session", app.server.url));
  const cleanupCookie = cleanupSession.headers.get("set-cookie")!.split(";")[0]!, cleanupCsrf = (await cleanupSession.json()).csrf;
  const cleanup = await fetch(new URL("/api/chrome/share/release", app.server.url), { method: "POST", headers: { "Content-Type": "application/json", cookie: cleanupCookie, "x-jelly-csrf": cleanupCsrf },
    body: JSON.stringify({ generation: app.service.chromeShare.state().generation, cleanupOnly: true }) });
  expect(cleanup.status).toBe(200);
  expect(() => owned.record()).toThrow();
  runner = Bun.spawn([join(owned.directory, "launch")], { stdout: "ignore", stderr: "inherit" });
  await until(() => owned.available());
  original = owned.record();
  const finalHeaders = { "Content-Type": "application/json", cookie: cleanupCookie, "x-jelly-csrf": cleanupCsrf };
  expect((await fetch(new URL("/api/chrome/share/take-owned", app.server.url), { method: "POST", headers: finalHeaders, body: JSON.stringify({ agentId: agent.id }) })).status).toBe(200);
  const privateDaemon = original.auth as unknown as { pid: number; start: string; exe: string; control: string };
  expect(privateDaemon.control.startsWith(fixtureRoot)).toBe(true);
  expect(sameOwnedProcess({ pid: privateDaemon.pid, start: privateDaemon.start, exe: privateDaemon.exe })).toBe(true);
  process.kill(privateDaemon.pid, "SIGTERM"); // exact disposable fixture daemon ONLY
  await until(() => app.service.chromeShare.state().status === "failed");
  const failedRelease = await fetch(new URL("/api/chrome/share/release", app.server.url), { method: "POST", headers: finalHeaders,
    body: JSON.stringify({ generation: app.service.chromeShare.state().generation, cleanupOnly: true }) });
  expect(failedRelease.status).toBe(409);
  expect(app.service.chrome.humanState()).toBe(false); // Done is independent of native cleanup.
  expect(app.service.chromeShare.state().status).toBe("failed");
  expect(errors).toEqual([]);
  console.log(`PASS: auth binding v${original.auth?.version}/${original.auth?.kind}; actual private Chrome erased/flattened-environ predecessor listening-kernel proof; private keyring OS authentication via actual noVNC; zero paired profiles/direct Take; automatic pairing during advisory human use; ordinary native Chrome existing-cookie/profile/PID persistence across Jelly restart; private bus loss stops exact owned tree, refuses old generation and permits explicit stale relaunch; conflicting lock/refused paths; already-clean orphan recovery after owned Chrome/Xvfb death then explicit owned relaunch; private daemon loss retains latch; controlled owned-stale relaunch retains disk cookie and extension profile identity with new owned/connection generation, no lock deletion.`);
} catch (error) {
  console.error("Disposable fixture phase:", phase);
  console.error("Disposable share state:", app.service.chromeShare.state(), "native claim attempts/accepted:", nativeClaims, acceptedClaims);
  if (existsSync(join(dir, "fixture-chrome.log"))) console.error("Disposable Chrome startup log:", readFileSync(join(dir, "fixture-chrome.log"), "utf8").slice(-3000));
  throw error;
} finally {
  await viewer?.close();
  await app.close().catch(() => {});
  if (runner) { runner.kill("SIGTERM"); await Promise.race([runner.exited, Bun.sleep(5000)]); }
  site.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
