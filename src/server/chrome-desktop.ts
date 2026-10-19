import {
  lstatSync,
  realpathSync,
  readFileSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join } from "node:path";

/** Only deliberately sanitized desktop failures may reach public share status. */
export class ChromeDesktopError extends Error {}

/** Native-host-only claim. Never accept display/auth parameters from HTTP/tools. */
export type ChromeDesktop =
  { available: true; display: string; auth: string } | { available: false };
/** Validate a private local binding, not evidence that Chrome uses that desktop. */
export function localX11Desktop(
  env: NodeJS.ProcessEnv,
  platform = process.platform,
): ChromeDesktop {
  if (
    platform !== "linux" ||
    env.XDG_SESSION_TYPE !== "x11" ||
    env.WAYLAND_DISPLAY ||
    !/^:[0-9]+(?:\.[0-9]+)?$/.test(env.DISPLAY ?? "") ||
    !env.XAUTHORITY ||
    !isAbsolute(env.XAUTHORITY)
  )
    return { available: false };
  try {
    const auth = realpathSync(env.XAUTHORITY);
    const s = lstatSync(auth);
    if (!s.isFile() || s.uid !== process.getuid?.() || s.mode & 0o077)
      return { available: false };
    return { available: true, display: env.DISPLAY!, auth };
  } catch {
    return { available: false };
  }
}
const desktopEnvKeys = [
  "DISPLAY",
  "XAUTHORITY",
  "XDG_SESSION_TYPE",
  "WAYLAND_DISPLAY",
] as const;

/** Chromium may flatten argv in /proc. Never reconstruct arbitrary argv from it. */
function processSwitches(command: string, name: string): string[] | null {
  // Chrome also accepts single-dash switches; ambiguous/noncanonical forms fail.
  const occurrences =
    command.split(`--${name}`).length -
    1 +
    [...command.matchAll(new RegExp(`(?<![-\\w])-${name}`, "g"))].length;
  const tokens = [
    ...command.matchAll(
      new RegExp(`(?:^|[\\0 ])--${name}(?=[=\\0 ]|$)([^\\0 ]*)`, "g"),
    ),
  ].map((m) => m[1]!);
  return occurrences === tokens.length ? tokens : null;
}
function x11Command(command: string, resolved = false) {
  // Display overrides cannot be distinguished from flattened argument values.
  // Refuse all of them, including well-formed local --display=:N overrides.
  if (command.includes("-display") || command.includes("-headless"))
    return false;
  const platforms = processSwitches(
    command.replaceAll("--ozone-platform-hint", ""),
    "ozone-platform",
  );
  const hints = processSwitches(command, "ozone-platform-hint");
  return (
    platforms !== null &&
    hints !== null &&
    platforms.length <= 1 &&
    hints.length <= 1 &&
    platforms.every((s) => s === "=x11") &&
    hints.every((s) => s === "=x11") &&
    (!resolved || platforms.length === 1)
  );
}

/** Native-host only: attest the direct browser parent, not inherited DISPLAY alone.
 * procRoot/parentPid allow disposable /proc fixtures; neither comes from the bridge.
 */
export function nativeChromeDesktop(
  parentPid = process.ppid,
  procRoot = "/proc",
  platform = process.platform,
): ChromeDesktop {
  if (platform !== "linux") return { available: false };
  try {
    const read = (pid: number) => {
      const dir = join(procRoot, String(pid));
      if (statSync(dir).uid !== process.getuid?.()) throw new Error();
      const stat = readFileSync(join(dir, "stat"), "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const executable = readlinkSync(join(dir, "exe"));
      const binary = statSync(join(dir, "exe"));
      const command = readFileSync(join(dir, "cmdline"), "utf8");
      if (!command.endsWith("\0") || command.length > 262144 || !fields[19])
        throw new Error();
      return {
        pid,
        parent: Number(fields[1]),
        start: fields[19],
        executable,
        binary: `${binary.dev}:${binary.ino}`,
        command,
      };
    };
    const browser = read(parentPid);
    if (
      !/^(chrome|chromium|chromium-browser|google-chrome|google-chrome-stable)$/.test(
        basename(browser.executable),
      ) ||
      browser.command.includes("-type") ||
      !x11Command(browser.command)
    )
      return { available: false };
    const rawEnv = readFileSync(
      join(procRoot, String(parentPid), "environ"),
      "utf8",
    );
    if (rawEnv.length > 262144 || !rawEnv.endsWith("\0"))
      return { available: false };
    const env: NodeJS.ProcessEnv = Object.create(null);
    for (const entry of rawEnv.split("\0").filter(Boolean)) {
      const equals = entry.indexOf("=");
      if (equals < 1) return { available: false };
      const key = entry.slice(0, equals);
      if (Object.hasOwn(env, key)) return { available: false };
      env[key] = entry.slice(equals + 1);
    }
    if (
      desktopEnvKeys.some(
        (key) => (env[key] ?? "") !== (process.env[key] ?? ""),
      ) ||
      env.OZONE_PLATFORM ||
      env.OZONE_PLATFORM_HINT
    )
      return { available: false };
    const desktop = localX11Desktop(env, platform);
    if (!desktop.available) return desktop;

    let remaining = 128,
      resolved = false;
    const visit = (parent: typeof browser, depth: number) => {
      const children = readFileSync(
        join(
          procRoot,
          String(parent.pid),
          "task",
          String(parent.pid),
          "children",
        ),
        "utf8",
      ).trim();
      if (!children) return;
      if (depth >= 4) throw new Error();
      for (const text of children.split(/\s+/)) {
        if (!/^[1-9][0-9]*$/.test(text) || --remaining < 0) throw new Error();
        const child = read(Number(text));
        if (child.parent !== parent.pid) throw new Error();
        if (child.binary !== browser.binary) continue;
        if (!x11Command(child.command)) throw new Error();
        const types = processSwitches(child.command, "type");
        if (!types || types.length !== 1) throw new Error();
        if (["=gpu-process", "=renderer"].includes(types[0]!)) {
          if (!x11Command(child.command, true)) throw new Error();
          resolved = true;
        }
        visit(child, depth + 1);
      }
    };
    visit(browser, 0);
    const current = read(parentPid);
    if (
      !resolved ||
      current.start !== browser.start ||
      current.binary !== browser.binary ||
      current.command !== browser.command ||
      (procRoot === "/proc" && process.ppid !== parentPid)
    )
      return { available: false };
    return desktop;
  } catch {
    // Raw commands, environment and filesystem errors are never public diagnostics.
    return { available: false };
  }
}

export interface ChromeDesktopBinding {
  display: string;
  auth: string;
  authHash: string;
  socketPath: string;
  socketDev: string;
  socketIno: string;
  socketCtime: string;
}
/** Bind cleanup to this exact authenticated X server, not a later reused DISPLAY. */
export function bindChromeDesktop(
  desktop: ChromeDesktop,
): ChromeDesktopBinding {
  if (!desktop.available)
    throw new ChromeDesktopError("The attested X11 desktop is unavailable.");
  const validated = localX11Desktop({
    XDG_SESSION_TYPE: "x11",
    DISPLAY: desktop.display,
    XAUTHORITY: desktop.auth,
  });
  if (!validated.available)
    throw new ChromeDesktopError(
      "X11 authorization changed. Operator repair required.",
    );
  const socketPath = `/tmp/.X11-unix/X${desktop.display.slice(1).split(".")[0]}`;
  const socket = lstatSync(socketPath, { bigint: true });
  const auth = lstatSync(desktop.auth);
  if (!socket.isSocket() || auth.size > 1048576)
    throw new ChromeDesktopError("Cannot bind the exact native X11 server.");
  return {
    display: desktop.display,
    auth: desktop.auth,
    socketPath,
    socketDev: String(socket.dev),
    socketIno: String(socket.ino),
    socketCtime: String(socket.ctimeNs),
    authHash: createHash("sha256")
      .update(readFileSync(desktop.auth))
      .digest("hex"),
  };
}
export function validDesktopBinding(binding: ChromeDesktopBinding) {
  try {
    return (
      JSON.stringify(
        bindChromeDesktop({
          available: true,
          display: binding.display,
          auth: binding.auth,
        }),
      ) === JSON.stringify(binding)
    );
  } catch {
    return false;
  }
}
export function validChromeDesktop(value: unknown): ChromeDesktop {
  if (!value || typeof value !== "object") return { available: false };
  const d = value as Record<string, unknown>;
  // Revalidate local paths/permissions; public profile responses never include these.
  return d.available === true &&
    typeof d.display === "string" &&
    typeof d.auth === "string"
    ? localX11Desktop({
        XDG_SESSION_TYPE: "x11",
        DISPLAY: d.display,
        XAUTHORITY: d.auth,
      })
    : { available: false };
}
