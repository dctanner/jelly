import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { OWNED_BUS_PROXY, OwnedChromeDesktop, directoryIdentity, ownedProcess, profileLocks, privateJson, validateOwnedConfig, type OwnedChromeConfig } from "../src/server/owned-chrome-desktop";

// Owner-only installation. Validation/attestation precede installation writes.
// Never starts/stops units or unlinks Chrome profile/Singleton artifacts.
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const allowed = ["--data-dir", "--chrome-root", "--profile", "--chrome-binary", "--wm-binary", "--home", "--bus", "--keyring-control", "--unit-dir", "--previous-pid", "--previous-unit", "--previous-invocation"];
const dataDir = option("--data-dir"), root = option("--chrome-root"), profile = option("--profile");
if (!dataDir || !root || !profile || !/^[A-Za-z0-9 _-]{1,80}$/.test(profile) || args.length % 2 || args.some((v, i) => i % 2 === 0 && !allowed.includes(v)))
  throw new Error("Select the existing instance/root/profile using owner CLI options.");
const instance = privateJson<{ instance: string }>(join(resolve(dataDir), "chrome-bridge/pairing.json")).instance;
const desktop = new OwnedChromeDesktop(dataDir, instance);
const present = (path: string) => { try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } };
if (present(desktop.directory)) throw new Error("Owned desktop installation exists; never overwrite unknown/active artifacts.");
const config: OwnedChromeConfig = {
  version: 1, instance, dataDir: resolve(dataDir), root: resolve(root), profile,
  rootIdentity: directoryIdentity(resolve(root)), profileIdentity: directoryIdentity(join(resolve(root), profile)),
  binary: resolve(option("--chrome-binary") ?? "/usr/bin/google-chrome"),
  wm: resolve(option("--wm-binary") ?? "/usr/bin/openbox"), home: resolve(option("--home") ?? homedir()),
  bus: option("--bus") ?? process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${process.getuid?.()}/bus`,
  keyringControl: option("--keyring-control") ? resolve(option("--keyring-control")!) : null,
  previous: null,
};
validateOwnedConfig(config, instance, dataDir);
if (!existsSync(OWNED_BUS_PROXY)) throw new Error("Owned Chrome requires /usr/bin/xdg-dbus-proxy; install it separately before setup.");
const previousPid = option("--previous-pid"), previousUnit = option("--previous-unit"), invocation = option("--previous-invocation");
if (previousPid || previousUnit || invocation) {
  if (!previousPid || !previousUnit || !/^[A-Za-z0-9_.@-]+\.service$/.test(previousUnit) || !invocation || !/^[0-9a-f]{32}$/.test(invocation))
    throw new Error("Expected live predecessor PID, exact unit and recorded InvocationID are required.");
  const browser = ownedProcess(Number(previousPid));
  const check = Bun.spawn(["/usr/bin/python3", resolve(import.meta.dir, "connected-chrome-unit.py"), JSON.stringify({
    unit: previousUnit, ...browser, invocation, root: config.root, profile: config.profile, home: config.home, binary: config.binary,
    rootIdentity: config.rootIdentity, profileIdentity: config.profileIdentity,
  })], { stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
  const code = await Promise.race([check.exited, Bun.sleep(5000).then(() => -1)]);
  if (code !== 0) { check.kill(); await check.exited; throw new Error("Predecessor unit/root listener ownership is not proven."); }
  const proof = JSON.parse(await new Response(check.stdout).text());
  const locks = profileLocks(config.root);
  if (Object.keys(locks).length !== 3 || proof.invocation !== invocation ||
      JSON.stringify(proof.browser) !== JSON.stringify(browser) || JSON.stringify(ownedProcess(browser.pid)) !== JSON.stringify(browser) ||
      JSON.stringify(proof.rootProof?.locks) !== JSON.stringify(locks) ||
      readlinkSync(join(config.root, "SingletonLock")) !== `${hostname()}-${browser.pid}`)
    throw new Error("Predecessor changed during attestation.");
  config.previous = { unit: previousUnit, invocation, browser, locks, rootProof: proof.rootProof };
}
validateOwnedConfig(config, instance, dataDir);
const unit = `jelly-owned-chrome-${instance.replaceAll("-", "")}.service`;
const unitDir = resolve(option("--unit-dir") ?? join(homedir(), ".config/systemd/user")), unitPath = join(unitDir, unit);
if (present(unitPath)) throw new Error("Unit already exists; no artifact was replaced.");
mkdirSync(unitDir, { recursive: true, mode: 0o700 });
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const systemdQuote = (s: string) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
const staged = mkdtempSync(join(desktop.directory, "../.owned-x11-install-"));
const stagingIdentity = lstatSync(staged);
let installed = false;
let reservation: { dev: number; ino: number } | null = null;
const created = new Map<string, string>();
const inode = (path: string) => { const s = lstatSync(path); return `${s.dev}:${s.ino}`; };
try {
  writeFileSync(join(staged, "config.json"), JSON.stringify(config), { mode: 0o600, flag: "wx" });
  writeFileSync(join(staged, "runner.lock"), "", { mode: 0o600, flag: "wx" });
  writeFileSync(join(staged, "launch"), `#!/bin/sh\nexec /usr/bin/flock --nonblock --no-fork ${quote(join(desktop.directory, "runner.lock"))} ${quote(process.execPath)} ${quote(resolve(import.meta.dir, "connected-chrome-desktop.ts"))} --config ${quote(desktop.configPath)}\n`, { mode: 0o700, flag: "wx" });
  validateOwnedConfig(config, instance, dataDir);
  // Reserve exclusively: rename may replace ONLY our just-created empty dir.
  const stagedIdentity = lstatSync(staged);
  for (const n of readdirSync(staged)) created.set(n, inode(join(staged, n)));
  mkdirSync(desktop.directory, { mode: 0o700 });
  reservation = lstatSync(desktop.directory);
  renameSync(staged, desktop.directory);
  installed = true;
  reservation = stagedIdentity;
  writeFileSync(unitPath, `[Unit]\nDescription=Jelly owned virtual-X11 Connected Chrome\n[Service]\nType=simple\nExecStart=${systemdQuote(join(desktop.directory, "launch"))}\nRestart=no\nKillMode=control-group\nTimeoutStopSec=15\nStandardOutput=null\nStandardError=null\n[Install]\nWantedBy=default.target\n`, { mode: 0o600, flag: "wx" });
} catch (error) {
  // Only installer-created known files; never remove unknown existing artifacts.
  if (reservation && inode(desktop.directory) === `${reservation.dev}:${reservation.ino}` &&
      readdirSync(desktop.directory).every(n => installed && created.get(n) === inode(join(desktop.directory, n))))
    rmSync(desktop.directory, { recursive: true });
  throw error;
} finally {
  if (existsSync(staged) && inode(staged) === `${stagingIdentity.dev}:${stagingIdentity.ino}` &&
      readdirSync(staged).every(n => ["config.json", "runner.lock", "launch"].includes(n))) rmSync(staged, { recursive: true });
}
console.log(`Configured ${unit}; NOT started or enabled. Parent must freshly verify exact predecessor generation/listener, controlled exit and profile-lock exclusion before explicitly starting the new unit. Never delete Chrome locks.`);
