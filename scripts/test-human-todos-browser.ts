import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Build only a disposable source copy. Never overwrite the running instance's dist.
const source = resolve(import.meta.dir, ".."),
  copy = mkdtempSync(join(tmpdir(), "jelly-todos-browser-source-"));
try {
  const files = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: source },
  );
  if (files.exitCode) throw new Error("Could not enumerate source fixture.");
  for (const file of new Set(
    files.stdout.toString().split("\0").filter(Boolean),
  )) {
    if (
      !/^(src\/|scripts\/|tests\/|public\/|extensions\/|package\.json$|tsconfig\.json$|vite\.config\.ts$|index\.html$)/.test(
        file,
      )
    )
      continue;
    const target = join(copy, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, file), target);
  }
  symlinkSync(join(source, "node_modules"), join(copy, "node_modules"), "dir");
  for (const args of [["run", "build"], ["tests/human-todos.browser.ts"]]) {
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: copy,
      env: { ...process.env, JELLY_DISPOSABLE_BROWSER_SOURCE: copy },
      stdout: "inherit",
      stderr: "inherit",
    });
    if (await child.exited)
      throw new Error(`Disposable check failed: bun ${args.join(" ")}`);
  }
} finally {
  rmSync(copy, { recursive: true, force: true });
}
