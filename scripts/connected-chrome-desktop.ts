import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { bindChromeDesktop, ChromeDesktopError } from "../src/server/chrome-desktop";
import { OwnedChromeDesktop, allowOwnedStaleProfile, profileLocks, ownedConfigHash, ownedProcess, sameOwnedProcess, privateJson, OWNED_BUS_PROXY, ownedBusProxyArgs, ownedBusProxyAlive, type OwnedBusProxy, type OwnedChromeConfig, type OwnedProcess } from "../src/server/owned-chrome-desktop";

// Runs only in the independent owner-installed user service, never in Jelly's
// process tree. No CDP/Playwright/AgentBrowser, profile copying or automatic retry.
const configPath = process.argv[3];
if (process.argv[2] !== "--config" || process.argv.length !== 4 || !configPath) process.exit(1);
const config = privateJson<OwnedChromeConfig>(configPath);
const owned = new OwnedChromeDesktop(config.dataDir, config.instance);
if (owned.configPath !== configPath) process.exit(1);
owned.config();
const directory = owned.directory;
const children: { child: ChildProcess; identity?: OwnedProcess }[] = [];
let closing = false;
let proxyCleanup: { directory: string; dev: number; ino: number; socket?: OwnedBusProxy } | undefined;
async function stop(code = 0) {
  if (closing) return;
  closing = true;
  for (const { child, identity } of [...children].reverse()) {
    if (!identity || !sameOwnedProcess(identity) || child.exitCode !== null || child.signalCode) continue;
    child.kill("SIGTERM");
    for (let i = 0; i < 100 && sameOwnedProcess(identity); i++) await Bun.sleep(25);
    if (sameOwnedProcess(identity)) child.kill("SIGKILL");
  }
  if (proxyCleanup) {
    try {
      const d = lstatSync(proxyCleanup.directory);
      if (d.isDirectory() && d.dev === proxyCleanup.dev && d.ino === proxyCleanup.ino) {
        if (proxyCleanup.socket && existsSync(proxyCleanup.socket.path)) {
          const s = lstatSync(proxyCleanup.socket.path, { bigint: true });
          if (s.isSocket() && JSON.stringify([String(s.dev), String(s.ino), String(s.ctimeNs)]) === JSON.stringify(proxyCleanup.socket.socket))
            rmSync(proxyCleanup.socket.path);
        }
        rmdirSync(proxyCleanup.directory); // never recursively remove unknown nodes
      }
    } catch {} // changed/missing artifacts remain operator-owned, never guessed
  }
  // Record deliberately remains: server cannot mistake a dead/reused process
  // for a clean restart. A future launch writes a new generation after checks.
  process.exit(code);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
try {
  // Never unlink Chrome artifacts. Native Chrome may handle ONLY its exact
  // recorded same-host stale owner, after every original PID is absent.
  if (!allowOwnedStaleProfile(config, directory)) throw new Error("Profile ownership is not proven.");
  owned.assertNoShareLatch();
  if (!existsSync(OWNED_BUS_PROXY)) throw new ChromeDesktopError("Owned Chrome requires /usr/bin/xdg-dbus-proxy; operator installation is required.");
  const field = (b: Buffer) => { const n = Buffer.alloc(2); n.writeUInt16BE(b.length); return Buffer.concat([n, b]); };
  const auth = join(directory, "Xauthority");
  // Refuse symlinks/foreign existing auth before replacing our stopped service's
  // own generation. The record/auth/socket hash makes old cleanup fail closed.
  if (existsSync(auth)) { const st = lstatSync(auth); if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.()) throw new Error(); }
  writeFileSync(auth, Buffer.concat([Buffer.from([255,255]), field(Buffer.alloc(0)), field(Buffer.alloc(0)), field(Buffer.from("MIT-MAGIC-COOKIE-1")), field(randomBytes(16))]), { mode: 0o600 });
  chmodSync(auth, 0o600);
  const binary = [join(config.dataDir, "runtime/usr/bin/Xvfb"), "/usr/bin/Xvfb"].find(existsSync);
  if (!binary) throw new Error();
  const xvfb = spawn(binary, ["-displayfd", "3", "-screen", "0", "1280x900x24", "-nolisten", "tcp", "-auth", auth], {
    env: { PATH: "/usr/bin:/bin", HOME: directory, LANG: "C.UTF-8", LD_LIBRARY_PATH: join(config.dataDir, "runtime/usr/lib/x86_64-linux-gnu") },
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  const xchild = { child: xvfb, identity: undefined as OwnedProcess | undefined }; children.push(xchild);
  xvfb.on("error", () => void stop());
  const display = await new Promise<string>((done, reject) => {
    const timer = setTimeout(() => reject(new Error()), 10000); let text = "";
    xvfb.once("exit", () => { clearTimeout(timer); reject(new Error()); });
    xvfb.stdio[3]!.on("data", (b: Buffer) => { text += b.toString(); if (/^[0-9]+\n$/.test(text)) { clearTimeout(timer); done(":" + text.trim()); } });
  });
  xchild.identity = ownedProcess(xvfb.pid!);
  const binding = bindChromeDesktop({ available: true, display, auth });
  const wmConfig = join(directory, "openbox.xml");
  writeFileSync(wmConfig, '<openbox_config xmlns="http://openbox.org/3.4/rc"><focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus><theme><name>Clearlooks</name></theme></openbox_config>', { mode: 0o600 });
  const manager = spawn(config.wm, ["--sm-disable", "--config-file", wmConfig], {
    env: { PATH: "/usr/bin:/bin", HOME: directory, LANG: "C.UTF-8", DISPLAY: display, XAUTHORITY: auth }, stdio: "ignore",
  });
  const wmChild = { child: manager, identity: undefined as OwnedProcess | undefined }; children.push(wmChild);
  manager.on("error", () => void stop(1));
  for (let i = 0; i < 100; i++) {
    if (manager.exitCode !== null || manager.signalCode) throw new Error();
    try { const identity = ownedProcess(manager.pid!); if (identity.exe.endsWith("/openbox")) { wmChild.identity = identity; break; } } catch {}
    await Bun.sleep(25);
  }
  if (!wmChild.identity) throw new Error();
  let authBinding: Record<string, unknown> | null = null;
  if (config.keyringControl) {
    const check = Bun.spawn(["/usr/bin/python3", resolve(import.meta.dir, "connected-chrome-os-auth.py"), "--attest", config.keyringControl, config.bus], { stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
    const result = await Promise.race([check.exited, Bun.sleep(5000).then(() => -1)]);
    if (result !== 0) { check.kill(); throw new Error(); }
    authBinding = JSON.parse(await new Response(check.stdout).text());
  }
  // Only this browser sees the filtered bus. Authentication attestation above
  // deliberately continues to use the original same-user session bus.
  const proxyDirectory = mkdtempSync(join(directory, "bus-"));
  chmodSync(proxyDirectory, 0o700);
  const proxyDirectoryStamp = lstatSync(proxyDirectory);
  proxyCleanup = { directory: proxyDirectory, dev: proxyDirectoryStamp.dev, ino: proxyDirectoryStamp.ino };
  const proxyPath = join(proxyDirectory, "socket");
  if (Buffer.byteLength(proxyPath) > 100) throw new ChromeDesktopError("Owned Chrome private bus socket path is too long.");
  const proxy = spawn(OWNED_BUS_PROXY, ownedBusProxyArgs(config.bus, proxyPath), {
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: "ignore",
  });
  const proxyChild = { child: proxy, identity: undefined as OwnedProcess | undefined }; children.push(proxyChild);
  proxy.on("error", () => void stop(1));
  proxy.once("exit", () => void stop(1));
  let busProxy: OwnedBusProxy | undefined;
  for (let i = 0; i < 200; i++) {
    if (proxy.exitCode !== null || proxy.signalCode) throw new Error();
    try {
      proxyChild.identity = ownedProcess(proxy.pid!);
      if (proxyChild.identity.exe !== OWNED_BUS_PROXY) throw new Error();
      const s = lstatSync(proxyPath);
      if (!s.isSocket() || s.uid !== process.getuid!()) throw new Error();
      chmodSync(proxyPath, 0o600);
      const stamp = lstatSync(proxyPath, { bigint: true });
      busProxy = { process: proxyChild.identity, path: proxyPath, socket: [String(stamp.dev), String(stamp.ino), String(stamp.ctimeNs)] };
      if (ownedBusProxyAlive(busProxy, directory)) { proxyCleanup.socket = busProxy; break; }
      busProxy = undefined;
    } catch {}
    await Bun.sleep(25);
  }
  if (!busProxy || !ownedBusProxyAlive(busProxy, directory)) throw new ChromeDesktopError("Owned Chrome private bus routing is unavailable.");
  // Socket replacement/loss is as fatal as process loss. Never retry routing or
  // fall back to the shared desktop's portal. The record remains cleanup proof.
  setInterval(() => { if (!ownedBusProxyAlive(busProxy!, directory)) void stop(1); }, 250);
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: config.home, LANG: "C.UTF-8", DISPLAY: display, XAUTHORITY: auth,
    XDG_SESSION_TYPE: "x11", DBUS_SESSION_BUS_ADDRESS: `unix:path=${proxyPath}`, XDG_CONFIG_HOME: join(config.home, ".config") };
  // Prevent ambient Wayland/debug/loader flags; ordinary Chrome retains its
  // native extension and normal password-store/keyring behavior.
  // The display/auth setup awaited external processes. Revalidate the exact
  // selected directories and exclusion again immediately before native launch.
  if (ownedConfigHash(owned.config()) !== ownedConfigHash(config) || !allowOwnedStaleProfile(config, directory)) throw new Error();
  const chromeArgs = [`--user-data-dir=${config.root}`, `--profile-directory=${config.profile}`, "--ozone-platform=x11", "--no-first-run", "--window-size=1280,900", "--window-position=0,0"];
  // A racing unrelated owner receives no URL or Connect request. A forwarded
  // launch exits and fails our direct-child/exclusive-lock checks below.
  owned.assertNoShareLatch();
  const chrome = spawn(config.binary, [...chromeArgs, "--no-startup-window"], { env, stdio: "ignore" });
  const browser = { child: chrome, identity: undefined as OwnedProcess | undefined }; children.push(browser);
  chrome.on("error", () => void stop());
  for (let i = 0; i < 100; i++) {
    if (chrome.exitCode !== null || chrome.signalCode) throw new Error();
    try { const identity = ownedProcess(chrome.pid!); if (/\/(chrome|chromium)$/.test(identity.exe)) { browser.identity = identity; break; } } catch {}
    await Bun.sleep(25);
  }
  if (!browser.identity) throw new Error();
  // Chromium's own lock wins any external race. Never attach to/kill a process
  // that merely received a forwarded launch; only our still-live direct child.
  let locks: ReturnType<typeof profileLocks> | null = null;
  for (let i = 0; i < 200 && !locks; i++) {
    if (!sameOwnedProcess(browser.identity)) throw new Error();
    try {
      const snapshot = profileLocks(config.root);
      if (Object.keys(snapshot).length === 3 && readlinkSync(join(config.root, "SingletonLock")) === `${hostname()}-${browser.identity.pid}`) locks = snapshot;
    } catch {}
    if (!locks) await Bun.sleep(25);
  }
  if (!locks) throw new ChromeDesktopError("Owned Chrome identity and exclusive profile lock could not be verified.");
  const record = { version: 1, instance: config.instance, generation: crypto.randomUUID(), configHash: ownedConfigHash(config),
    runner: ownedProcess(process.pid), server: xchild.identity, manager: wmChild.identity, chrome: browser.identity, binding, profileLocks: locks, auth: authBinding, busProxy };
  owned.assertNoShareLatch();
  writeFileSync(join(directory, "desktop.next"), JSON.stringify(record), { mode: 0o600 });
  renameSync(join(directory, "desktop.next"), join(directory, "desktop.json"));
  owned.record();
  xvfb.once("exit", () => void stop());
  manager.once("exit", () => void stop());
  chrome.once("exit", () => void stop());
  // The fixed popup URI is requested only after direct-child/profile/display
  // ownership is proven. No arbitrary URL or queued automation is forwarded.
  owned.record();
  owned.assertNoShareLatch();
  const popup = spawn(config.binary, [...chromeArgs, "chrome-extension://mikadpfmkipiafkemjplldmfckomphcf/popup.html"], { env, stdio: "ignore" });
  const popupExit = await new Promise<boolean>(done => {
    const timer = setTimeout(() => done(false), 5000);
    popup.once("error", () => { clearTimeout(timer); done(false); });
    popup.once("exit", code => { clearTimeout(timer); done(code === 0); });
  });
  if (!popupExit) throw new Error();
  owned.record();
  // Independent service persists across Jelly restarts and viewer handbacks.
  await new Promise(() => {});
} catch (error) {
  if (error instanceof ChromeDesktopError) console.error(error.message);
  await stop(1);
}
