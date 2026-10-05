import {
  accessSync,
  constants,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { HttpError } from "./errors";
import type { AgentRecord } from "../shared/types";
export function validateDirectory(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    value.length > 4096
  )
    throw new HttpError(
      400,
      "Choose an absolute folder path on the Jelly server.",
    );
  try {
    const path = realpathSync(value);
    if (!statSync(path).isDirectory())
      throw new HttpError(400, "Choose a folder, not a file.");
    accessSync(path, constants.R_OK | constants.X_OK);
    return path;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(
      400,
      "This folder is missing or inaccessible on the Jelly server. Choose another folder.",
    );
  }
}
export function effectiveCwd(agent: AgentRecord) {
  if (agent.managedCwd) mkdirSync(agent.cwd, { recursive: true, mode: 0o700 });
  return validateDirectory(agent.cwd);
}
export function createDirectory(parent: unknown, name: unknown) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    [".", ".."].includes(name.trim()) ||
    /[/\\\u0000-\u001f\u007f]/.test(name) ||
    Buffer.byteLength(name.trim(), "utf8") > 255
  )
    throw new HttpError(
      400,
      "Enter a directory name, not a path (up to 255 bytes).",
    );
  const path = join(validateDirectory(parent), name.trim());
  try {
    // Never overwrite an existing entry or create missing parent directories.
    mkdirSync(path, { mode: 0o700 });
    return path;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST")
      throw new HttpError(
        409,
        "A file or directory with this name already exists.",
      );
    if (code === "EACCES" || code === "EPERM")
      throw new HttpError(
        403,
        "Permission denied. Choose another parent folder.",
      );
    if (code === "ENOENT" || code === "ENOTDIR")
      throw new HttpError(
        409,
        "The parent folder is no longer available. Choose it again.",
      );
    throw new HttpError(
      500,
      "Could not create the directory. Try another name or parent folder.",
    );
  }
}
export function directories(path = homedir(), after = "", hidden = false) {
  const current = validateDirectory(path);
  const entries = readdirSync(current, { withFileTypes: true })
    .filter(
      (e) =>
        (hidden || !e.name.startsWith(".")) &&
        (e.isDirectory() || e.isSymbolicLink()),
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .filter((e) => e.name > after);
  const folders: { name: string; path: string; available: boolean }[] = [];
  let scanned = "";
  let index = 0;
  for (; index < entries.length && folders.length < 100; index++) {
    const entry = entries[index]!;
    scanned = entry.name;
    const path = join(current, entry.name);
    try {
      if (!statSync(path).isDirectory()) continue;
      folders.push({
        name: entry.name,
        path: validateDirectory(path),
        available: true,
      });
    } catch {
      folders.push({ name: entry.name, path, available: false });
    }
  }
  return {
    path: current,
    home: homedir(),
    parent: dirname(current) === current ? null : dirname(current),
    entries: folders,
    cursor: index < entries.length ? scanned : null,
  };
}
