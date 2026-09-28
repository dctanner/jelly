import { Database } from "bun:sqlite";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

// A separate SQLite connection holds an OS-backed exclusive lock for the whole
// server lifetime. The kernel releases it on exit, including SIGKILL. Never
// unlink this file: replacing its inode would let a second owner acquire it.
const owned = new Set<string>();
export function acquireInstance(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const directory = realpathSync(dataDir);
  const busy = () =>
    new Error(
      `Jelly is already running with data directory ${directory}. Stop that server first, or set JELLY_DATA_DIR to a different directory.`,
    );
  if (owned.has(directory)) throw busy();
  const db = new Database(join(directory, "server-lock.sqlite"), {
    create: true,
  });
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
  } catch (error) {
    db.close();
    if (
      ["SQLITE_BUSY", "SQLITE_LOCKED"].includes(
        (error as { code?: string }).code ?? "",
      )
    )
      throw busy();
    throw error;
  }
  owned.add(directory);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      db.close();
    } finally {
      owned.delete(directory);
    }
  };
}
