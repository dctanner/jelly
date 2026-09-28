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
