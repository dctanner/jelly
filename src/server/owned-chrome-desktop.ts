import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { hostname } from "node:os";
import { bindChromeDesktop, validDesktopBinding, ChromeDesktopError, type ChromeDesktopBinding, type ChromeDesktop } from "./chrome-desktop";

export interface OwnedChromeConfig {
  version: 1;
  instance: string;
  dataDir: string;
  root: string;
  profile: string;
  rootIdentity: DirectoryIdentity;
  profileIdentity: DirectoryIdentity;
  binary: string;
  wm: string;
  home: string;
  bus: string;
  keyringControl: string | null;
  previous: { unit: string; invocation: string; browser: OwnedProcess; locks: ProfileLocks; rootProof?: Record<string, unknown> } | null;
}
export interface DirectoryIdentity { path: string; dev: string; ino: string; uid: number }
/** Contents/ctime may change normally; the selected directory itself may not. */
export function directoryIdentity(path: string): DirectoryIdentity {
  const s = lstatSync(path, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== BigInt(process.getuid!()) || realpathSync(path) !== resolve(path))
    throw new ChromeDesktopError("Select an existing canonical same-user nonsymlink Chrome directory.");
  return { path: resolve(path), dev: String(s.dev), ino: String(s.ino), uid: Number(s.uid) };
}
export function validateOwnedConfig(c: OwnedChromeConfig, instance: string, dataDir: string) {
  if (c.version !== 1 || c.instance !== instance || resolve(c.dataDir) !== resolve(dataDir) ||
      ![c.root, c.binary, c.wm, c.home].every(p => typeof p === "string" && p.startsWith("/") && resolve(p) === p) ||
      !/^[A-Za-z0-9 _-]{1,80}$/.test(c.profile) || !["chrome", "google-chrome", "google-chrome-stable", "chromium"].includes(basename(c.binary)) ||
      basename(c.wm) !== "openbox" || typeof c.bus !== "string" || !c.bus.startsWith("unix:path=/") ||
      (c.keyringControl !== null && (typeof c.keyringControl !== "string" || !c.keyringControl.startsWith("/"))) ||
      JSON.stringify(directoryIdentity(c.root)) !== JSON.stringify(c.rootIdentity) ||
      JSON.stringify(directoryIdentity(join(c.root, c.profile))) !== JSON.stringify(c.profileIdentity))
    throw new ChromeDesktopError("Owned Chrome installation/directories changed. Operator repair is required.");
}
export type ProfileLocks = Record<string, { dev: string; ino: string; ctime: string }>;
const singletonNames = ["SingletonLock", "SingletonSocket", "SingletonCookie"] as const;
/** Identity only: never read/store Chromium's SingletonCookie contents/target. */
export function profileLocks(root: string): ProfileLocks {
  const result: ProfileLocks = {};
  for (const name of singletonNames) {
    try {
      const s = lstatSync(join(root, name), { bigint: true });
      if (!s.isSymbolicLink() || s.uid !== BigInt(process.getuid!())) throw new Error("Untrusted Chrome singleton artifact.");
      result[name] = { dev: String(s.dev), ino: String(s.ino), ctime: String(s.ctimeNs) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return result;
}
function pidAbsent(pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { lstatSync(`/proc/${pid}`); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}
/** No lock removal. Only native Chrome may retire its proven own stale state. */
export function allowOwnedStaleProfile(config: OwnedChromeConfig, directory: string) {
  const current = profileLocks(config.root);
  if (!Object.keys(current).length) return true;
  const candidates: { browser: OwnedProcess; locks: ProfileLocks; owners: OwnedProcess[] }[] = [];
  if (config.previous) candidates.push({ browser: config.previous.browser, locks: config.previous.locks, owners: [config.previous.browser] });
  try {
    const old = privateJson<OwnedChromeRecord>(join(directory, "desktop.json"));
    if (old.instance === config.instance && old.configHash === ownedConfigHash(config))
      candidates.push({ browser: old.chrome, locks: old.profileLocks, owners: [old.runner, old.server, old.manager, old.chrome, ...(old.busProxy ? [old.busProxy.process] : [])] });
  } catch {}
  return candidates.some(old => {
    try {
      return old.owners.every(p => pidAbsent(p.pid)) &&
        readlinkSync(join(config.root, "SingletonLock")) === `${hostname()}-${old.browser.pid}` &&
        Object.entries(current).every(([name, identity]) => JSON.stringify(old.locks[name]) === JSON.stringify(identity));
    } catch { return false; }
  });
}
export const OWNED_BUS_PROXY = "/usr/bin/xdg-dbus-proxy";
export function ownedBusProxyArgs(bus: string, socket: string) {
  return [bus, socket, "--filter", "--talk=org.freedesktop.secrets"];
}
export interface OwnedBusProxy { process: OwnedProcess; path: string; socket: string[] }
export function ownedBusProxyAlive(proxy: OwnedBusProxy, directory: string) {
  try {
    if (!proxy || proxy.process.exe !== realpathSync(OWNED_BUS_PROXY) || !sameOwnedProcess(proxy.process) ||
        !/^bus-[A-Za-z0-9]+\/socket$/.test(proxy.path.slice(directory.length + 1)) || !proxy.path.startsWith(directory + "/")) return false;
    const parent = lstatSync(resolve(proxy.path, ".."));
    const socket = lstatSync(proxy.path, { bigint: true });
    return parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid!() && !(parent.mode & 0o077) &&
      socket.isSocket() && socket.uid === BigInt(process.getuid!()) && !(socket.mode & 0o077n) &&
      JSON.stringify([String(socket.dev), String(socket.ino), String(socket.ctimeNs)]) === JSON.stringify(proxy.socket);
  } catch { return false; }
}
export interface OwnedProcess { pid: number; start: string; exe: string }
export type AuthBinding = { version: number; kind: string; pid: number; start: string; exe: string; control: string;
  bus: string; owner: string; socket: string[]; kernelInode: string; manager?: { pid: number; start: string; owner: string } };
function sameProcessStamp(p: { pid: number; start: string }) {
  try {
    if (!Number.isSafeInteger(p.pid) || p.pid < 1 || lstatSync(`/proc/${p.pid}`).uid !== process.getuid!()) return false;
    const value = readFileSync(`/proc/${p.pid}/stat`, "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
    return fields[0] !== "Z" && fields[19] === p.start;
  } catch { return false; }
}
/** Cached attestation + cheap live process/endpoint checks, never a per-RFB fork.
 * Full bus/unit generation proofs run in GTK's watcher and at handback. */
export function authBindingAlive(auth: AuthBinding) {
  try {
    if (auth.version === 1 && auth.kind === "direct") {
      if (!sameOwnedProcess({ pid: auth.pid, start: auth.start, exe: auth.exe })) return false;
    } else if (auth.version === 2 && auth.kind === "systemd-socket") {
      if (!auth.manager || !sameProcessStamp(auth) || !sameProcessStamp(auth.manager)) return false;
    } else return false;
    const node = lstatSync(auth.control, { bigint: true });
    if (!node.isSocket() || node.uid !== BigInt(process.getuid!()) ||
        JSON.stringify([String(node.dev), String(node.ino), String(node.ctimeNs)]) !== JSON.stringify(auth.socket)) return false;
    const listeners = readFileSync("/proc/net/unix", "utf8").split("\n").map(line => line.trim().split(/\s+/))
      .filter(v => v.slice(7).join(" ") === auth.control && (parseInt(v[3], 16) & 0x10000) && v[4] === "0001" && v[5] === "01");
    return listeners.length === 1 && listeners[0][6] === auth.kernelInode;
  } catch { return false; }
}
export interface OwnedChromeRecord {
  version: 1;
  instance: string;
  configHash: string;
  generation: string;
  runner: OwnedProcess;
  server: OwnedProcess;
  manager: OwnedProcess;
  chrome: OwnedProcess;
  binding: ChromeDesktopBinding;
  profileLocks: ProfileLocks;
  auth: AuthBinding | null;
  // Optional only for pre-routing cleanup records; live admission requires it.
  busProxy?: OwnedBusProxy;
}
export function privateJson<T>(path: string): T {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 65536)
    throw new ChromeDesktopError("Unsafe owned Chrome configuration or identity record.");
  return JSON.parse(readFileSync(path, "utf8"));
}
export function ownedProcess(pid: number): OwnedProcess {
  const dir = `/proc/${pid}`;
  if (!Number.isSafeInteger(pid) || pid < 1 || lstatSync(dir).uid !== process.getuid?.()) throw new Error();
  const stat = readFileSync(join(dir, "stat"), "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (fields[0] === "Z" || !fields[19]) throw new Error();
  return { pid, start: fields[19], exe: readlinkSync(join(dir, "exe")) };
}
export function sameOwnedProcess(identity: OwnedProcess) {
  try { return JSON.stringify(ownedProcess(identity.pid)) === JSON.stringify(identity); }
  catch { return false; }
}
export function ownedConfigHash(config: OwnedChromeConfig) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
/** Private installation only: no executable, profile, bus or display paths from HTTP. */
export class OwnedChromeDesktop {
  readonly directory: string;
  readonly configPath: string;
  constructor(dataDir: string, readonly instance: string) {
    this.directory = join(resolve(dataDir), "chrome-bridge", "owned-x11");
    this.configPath = join(this.directory, "config.json");
  }
  get configured() { return existsSync(this.configPath); }
  config() {
    const directory = lstatSync(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || directory.mode & 0o077)
      throw new ChromeDesktopError("Unsafe owned Chrome runtime directory.");
    const c = privateJson<OwnedChromeConfig>(this.configPath);
    validateOwnedConfig(c, this.instance, resolve(join(this.directory, "../..")));
    return c;
  }
  /** Cleanup evidence only: never grants viewing or native process authority. */
  cleanupRecord(generation: string, binding: ChromeDesktopBinding): OwnedChromeRecord {
    const c = this.config();
    const r = privateJson<OwnedChromeRecord>(join(this.directory, "desktop.json"));
    if (r.version !== 1 || r.instance !== this.instance || r.configHash !== ownedConfigHash(c) ||
        !/^[a-f0-9-]{36}$/.test(generation) || r.generation !== generation ||
        !binding || !/^:[0-9]+(?:\.[0-9]+)?$/.test(binding.display) ||
        binding.auth !== join(this.directory, "Xauthority") ||
        binding.socketPath !== `/tmp/.X11-unix/X${binding.display.slice(1).split(".")[0]}` ||
        !/^[a-f0-9]{64}$/.test(binding.authHash) ||
        ![binding.socketDev, binding.socketIno, binding.socketCtime].every(v => typeof v === "string" && /^[0-9]+$/.test(v)) ||
        JSON.stringify(r.binding) !== JSON.stringify(binding))
      throw new ChromeDesktopError("Original owned desktop cleanup evidence changed. Keep tools paused.");
    return r;
  }
  assertNoShareLatch() {
    try { lstatSync(join(this.directory, "../desktop-share.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    throw new ChromeDesktopError("End the existing desktop share without viewing before starting owned Chrome.");
  }
  record(): OwnedChromeRecord {
    let check = "configuration";
    try {
      const c = this.config();
      const r = privateJson<OwnedChromeRecord>(join(this.directory, "desktop.json"));
      check = "process/socket identity";
      if (r.version !== 1 || r.instance !== this.instance || r.configHash !== ownedConfigHash(c) ||
          typeof r.generation !== "string" || !/^[a-f0-9-]{36}$/.test(r.generation) ||
          ![r.runner, r.server, r.manager, r.chrome].every(sameOwnedProcess) || !validDesktopBinding(r.binding) ||
          r.binding.auth !== join(this.directory, "Xauthority") || basename(r.server.exe) !== "Xvfb" || basename(r.manager.exe) !== "openbox" ||
          !["chrome", "chromium", "google-chrome", "google-chrome-stable"].includes(basename(r.chrome.exe))) throw new Error();
      check = "private Secret Service bus routing";
      if (!r.busProxy || !ownedBusProxyAlive(r.busProxy, this.directory)) throw new Error();
      if (r.auth) {
        check = "OS authentication daemon";
        if (!authBindingAlive(r.auth)) throw new Error();
      }
      check = "exclusive profile lock";
      if (readlinkSync(join(c.root, "SingletonLock")) !== `${hostname()}-${r.chrome.pid}`) throw new Error();
      check = "browser arguments";
      const argv = readFileSync(`/proc/${r.chrome.pid}/cmdline`, "utf8").replaceAll("\0", " ");
      if (!argv.includes(`--user-data-dir=${c.root} `) || !argv.includes(`--profile-directory=${c.profile} `) ||
          !argv.includes(" --ozone-platform=x11 ") || (argv.match(/--ozone-platform=/g) ?? []).length !== 1 ||
          argv.includes("remote-debugging") || argv.includes("-headless") || argv.includes("-display") || argv.includes("ozone-platform-hint") ||
          argv.includes("--no-sandbox") || argv.includes("password-store") || argv.includes("use-mock-keychain")) throw new Error();
      // Sandboxed ordinary Chrome can make its /proc/environ unreadable. This
      // owned service created the exact sanitized environment; nativeClaim also
      // requires its direct child's inherited display/auth to match this record.
      // Unowned Chrome continues to require the separate full native attestation.
      return r;
    } catch {
      throw new ChromeDesktopError(`Owned X11 Chrome ${check} is unavailable or changed. Keep tools paused and obtain operator repair; no browser is restarted automatically.`);
    }
  }
  available() { try { this.record(); return true; } catch { return false; } }
  nativeClaim(parent: unknown, desktop: ChromeDesktop): ChromeDesktop | null {
    try {
      const record = this.record();
      if (JSON.stringify(parent) !== JSON.stringify(record.chrome) || !this.matches(desktop)) return null;
      return { available: true, display: record.binding.display, auth: record.binding.auth };
    } catch { return null; }
  }
  matches(desktop: { available: boolean; display?: string; auth?: string }) {
    try {
      const r = this.record();
      return desktop.available && desktop.display === r.binding.display && desktop.auth === r.binding.auth &&
        JSON.stringify(bindChromeDesktop({ available: true, display: desktop.display!, auth: desktop.auth! })) === JSON.stringify(r.binding);
    } catch { return false; }
  }
}
