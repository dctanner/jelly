import * as fs from "node:fs";
import { dirname, parse as parsePath, resolve } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { applyDiff, DiffWorkBudget } from "./vendor/apply-diff";
import { APPLY_PATCH_GRAMMAR } from "./vendor/apply-patch-grammar";

export const PATCH_LIMITS = {
  patchBytes: 1024 * 1024,
  files: 64,
  fileBytes: 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
} as const;
type Operation = {
  kind: "add" | "update" | "delete";
  path: string;
  destination?: string;
  diff: string;
};
type Snapshot = { bytes: Buffer; stat: fs.Stats };
type Planned = Operation & { before?: Snapshot; after?: Buffer };
export type PatchChange = {
  path: string;
  kind: Operation["kind"];
  destination?: string;
  diff: string;
};
export type PatchDetails = {
  status: "applied" | "rejected" | "partial";
  changedFiles: PatchChange[];
  mutations: {
    path: string;
    action:
      "created-directory" | "created" | "write-started" | "written" | "deleted";
  }[];
  error?: string;
};
// Test seam for deterministic disk failures. Production always uses node:fs.
export type PatchIO = Pick<
  typeof fs,
  | "lstatSync"
  | "openSync"
  | "fstatSync"
  | "readSync"
  | "closeSync"
  | "mkdirSync"
  | "writeSync"
  | "ftruncateSync"
  | "fchmodSync"
  | "unlinkSync"
>;
const parameters = Type.Object({
  patch: Type.String({
    description: "The complete *** Begin Patch ... *** End Patch text.",
  }),
});
let tail: Promise<unknown> = Promise.resolve();

function fail(message: string): never {
  throw new Error(message);
}
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) fail("Cancelled");
}
function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function stat(path: string, io: PatchIO) {
  try {
    return io.lstatSync(path);
  } catch (e) {
    if (missing(e)) return undefined;
    throw e;
  }
}
function safePath(path: string, io: PatchIO) {
  const root = parsePath(path).root;
  let current = root;
  for (const segment of path.slice(root.length).split("/").filter(Boolean)) {
    current = resolve(current, segment);
    const entry = stat(current, io);
    if (entry?.isSymbolicLink()) fail(`Symlink refused: ${current}`);
    if (current !== path && entry && !entry.isDirectory())
      fail(`Not a directory: ${current}`);
  }
}
function identity(a: fs.Stats, b: fs.Stats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
function snapshot(path: string, io: PatchIO): Snapshot {
  safePath(path, io);
  const entry = stat(path, io);
  if (!entry?.isFile() || entry.nlink !== 1)
    fail(`Expected a regular, non-hardlinked file: ${path}`);
  if (entry.size > PATCH_LIMITS.fileBytes)
    fail(`File exceeds ${PATCH_LIMITS.fileBytes} bytes: ${path}`);
  const fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!identity(entry, io.fstatSync(fd))) fail(`Stale file: ${path}`);
    // Read at most the preflight size plus one byte, even if another process
    // grows the file while it is open.
    const buffer = Buffer.alloc(entry.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = io.readSync(
        fd,
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!count) break;
      length += count;
    }
    if (length !== entry.size || !identity(entry, io.fstatSync(fd)))
      fail(`Stale or oversized file: ${path}`);
    return { bytes: buffer.subarray(0, length), stat: entry };
  } finally {
    io.closeSync(fd);
  }
}
function text(bytes: Buffer, path: string) {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return fail(`Not UTF-8 text: ${path}`);
  }
  if (value.includes("\0") || /\r(?!\n)/.test(value))
    fail(`Unsupported binary or line endings: ${path}`);
  if (value.includes("\r\n") && /(?<!\r)\n/.test(value))
    fail(`Mixed line endings refused: ${path}`);
  return value;
}
function parsePatch(patch: string, cwd: string): Operation[] {
  if (Buffer.byteLength(patch) > PATCH_LIMITS.patchBytes)
    fail(`Patch exceeds ${PATCH_LIMITS.patchBytes} bytes`);
  if (/[\uD800-\uDFFF]/u.test(patch)) fail("Invalid patch Unicode: unpaired surrogate");
  if (patch.includes("\0") || /\r(?!\n)/.test(patch))
    fail("Invalid patch characters");
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch")
    fail("Expected exact Begin Patch and End Patch markers");
  const operations: Operation[] = [];
  const paths = new Set<string>();
  function path(value: string) {
    if (!value || value.trim() !== value)
      fail("Empty or whitespace-padded path");
    const full = resolve(cwd, value);
    if (paths.has(full)) fail(`Conflicting path: ${full}`);
    paths.add(full);
    return full;
  }
  for (let i = 0; i < lines.length;) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i++]);
    if (!header) fail(`Invalid file header at patch line ${i + 1}`);
    const kind = header[1].toLowerCase() as Operation["kind"];
    const operation: Operation = { kind, path: path(header[2]), diff: "" };
    if (kind === "update" && lines[i]?.startsWith("*** Move to: "))
      operation.destination = path(lines[i++].slice(13));
    const body: string[] = [];
    while (
      i < lines.length &&
      !/^\*\*\* (Add|Update|Delete) File: /.test(lines[i])
    )
      body.push(lines[i++]);
    if (kind === "delete" && body.length)
      fail("Delete must not contain a body");
    if (
      kind === "add" &&
      (!body.length || body.some((line) => !line.startsWith("+")))
    )
      fail("Add requires +-prefixed lines");
    if (kind === "update" && !body.length && !operation.destination)
      fail("Empty update");
    if (
      kind === "update" &&
      body.some(
        (line, index) =>
          !/^[ +\-]/.test(line) &&
          line !== "@@" &&
          !line.startsWith("@@ ") &&
          !(line === "*** End of File" && index === body.length - 1),
      )
    )
      fail("Invalid update line or misplaced End of File marker");
    operation.diff = body.join("\n");
    operations.push(operation);
    if (operations.length > PATCH_LIMITS.files)
      fail(`Patch exceeds ${PATCH_LIMITS.files} files`);
  }
  if (!operations.length) fail("Patch contains no files");
  // Parent/child paths cannot both participate, even if one does not yet exist.
  const ordered = [...paths].sort();
  for (let i = 0; i < ordered.length; i++)
    for (let j = i + 1; j < ordered.length; j++) {
      if (ordered[j].startsWith(ordered[i] + "/"))
        fail("Conflicting ancestor paths");
    }
  return operations;
}
function preflight(patch: string, cwd: string, io: PatchIO): Planned[] {
  let bytes = 0;
  const budget = new DiffWorkBudget();
  return parsePatch(patch, cwd).map((operation) => {
    safePath(operation.path, io);
    const before =
      operation.kind !== "add" ? snapshot(operation.path, io) : undefined;
    const destination =
      operation.destination ??
      (operation.kind === "add" ? operation.path : undefined);
    if (destination) {
      safePath(destination, io);
      if (stat(destination, io)) fail(`Destination exists: ${destination}`);
    }
    let after: Buffer | undefined;
    if (operation.kind === "add")
      after = Buffer.from(applyDiff("", operation.diff, "create", budget) + "\n");
    if (operation.kind === "update") {
      const input = text(before!.bytes, operation.path);
      const bom = input.startsWith("\uFEFF") ? "\uFEFF" : "";
      after = operation.diff
        ? Buffer.from(bom + applyDiff(input.slice(bom.length), operation.diff, "default", budget))
        : before!.bytes;
    }
    if (after && after.length > PATCH_LIMITS.fileBytes)
      fail(`Result exceeds ${PATCH_LIMITS.fileBytes} bytes: ${operation.path}`);
    bytes += (before?.bytes.length ?? 0) + (after?.length ?? 0);
    if (bytes > PATCH_LIMITS.totalBytes)
      fail(`Patch working set exceeds ${PATCH_LIMITS.totalBytes} bytes`);
    return { ...operation, before, after };
  });
}
function verify(item: Planned, io: PatchIO) {
  if (item.before) {
    const now = snapshot(item.path, io);
    if (
      !identity(item.before.stat, now.stat) ||
      !item.before.bytes.equals(now.bytes)
    )
      fail(`Stale file: ${item.path}`);
  }
  const destination =
    item.destination ?? (item.kind === "add" ? item.path : undefined);
  if (destination) {
    safePath(destination, io);
    if (stat(destination, io)) fail(`Destination exists: ${destination}`);
  }
}
function directories(path: string, io: PatchIO, details: PatchDetails) {
  const parent = dirname(path);
  if (stat(parent, io)) return;
  directories(parent, io, details);
  io.mkdirSync(parent);
  details.mutations.push({ path: parent, action: "created-directory" });
}
function write(
  path: string,
  bytes: Buffer,
  before: Snapshot | undefined,
  io: PatchIO,
  details: PatchDetails,
  mode?: number,
) {
  safePath(path, io);
  directories(path, io, details);
  const fd = io.openSync(
    path,
    fs.constants.O_WRONLY |
      fs.constants.O_NOFOLLOW |
      (before ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL),
    mode ?? 0o666,
  );
  if (!before) details.mutations.push({ path, action: "created" });
  try {
    if (before && !identity(before.stat, io.fstatSync(fd)))
      fail(`Stale file: ${path}`);
    // Record before the first potentially destructive syscall: errors may leave
    // a partially truncated/written file. There is deliberately no rollback.
    details.mutations.push({ path, action: "write-started" });
    io.ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.length) {
      const count = io.writeSync(
        fd,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!count) fail(`Zero-byte write: ${path}`);
      offset += count;
    }
    if (mode !== undefined) io.fchmodSync(fd, mode);
    details.mutations.push({ path, action: "written" });
  } finally {
    io.closeSync(fd);
  }
}
async function run(
  patch: string,
  cwd: string,
  signal: AbortSignal | undefined,
  io: PatchIO,
): Promise<PatchDetails> {
  const details: PatchDetails = {
    status: "rejected",
    changedFiles: [],
    mutations: [],
  };
  try {
    checkAbort(signal);
    const plan = preflight(patch, cwd, io);
    await yieldTurn();
    checkAbort(signal);
    for (const item of plan) verify(item, io);
    for (const item of plan) {
      checkAbort(signal);
      verify(item, io);
      if (item.kind === "delete") {
        io.unlinkSync(item.path);
        details.mutations.push({ path: item.path, action: "deleted" });
      } else {
        write(
          item.destination ?? item.path,
          item.after!,
          item.destination ? undefined : item.before,
          io,
          details,
          item.before ? item.before.stat.mode & 0o7777 : undefined,
        );
        if (item.destination) {
          // Recheck before removing the source, including after a destination write.
          const current = snapshot(item.path, io);
          if (
            !identity(item.before!.stat, current.stat) ||
            !current.bytes.equals(item.before!.bytes)
          )
            fail(`Stale move source: ${item.path}`);
          checkAbort(signal);
          io.unlinkSync(item.path);
          details.mutations.push({ path: item.path, action: "deleted" });
        }
      }
      details.changedFiles.push({
        path: item.path,
        kind: item.kind,
        destination: item.destination,
        diff: item.diff,
      });
      await yieldTurn();
      checkAbort(signal);
    }
    details.status = "applied";
  } catch (error) {
    details.status = details.mutations.length ? "partial" : "rejected";
    // OS error codes are useful; do not echo file contents or raw patch lines.
    details.error =
      (error as NodeJS.ErrnoException).code ??
      (error instanceof Error ? error.message : "Patch failed");
  }
  return details;
}
/** Full-host authorized paths, relative to cwd; not a sandbox. Symlink path
 * components and hardlinked sources are intentionally refused. All our calls
 * serialize in-process, but external/native writers are not locked. Stale checks
 * reduce races, not adversarial filesystem protection. IO is non-transactional.
 */
export function executePatch(
  patch: string,
  cwd: string,
  signal?: AbortSignal,
  io: PatchIO = fs,
): Promise<PatchDetails> {
  const result = tail.then(() => run(patch, cwd, signal, io));
  tail = result.catch(() => {});
  return result;
}
export function applyPatchTool(cwd: string) {
  return defineTool<typeof parameters, PatchDetails>({
    name: "apply_patch",
    label: "Apply patch",
    description:
      "Apply a FREEFORM Codex *** Begin Patch / Add File / Update File / Delete File / Move to / @@ / *** End Patch patch. Exact unique context is required. Paths are relative to cwd or absolute (not sandboxed). Symlinks, hardlinks, mixed line endings, and destination overwrites are refused. Preflights all files; subsequent IO failures can leave partial changes, without rollback. Limits: 1 MiB patch/file, 64 files, 16 MiB total working set.",
    promptSnippet: "Apply multi-file source changes with a Codex-style patch.",
    promptGuidelines: [
      "Prefer apply_patch for multi-file changes. Native edit and write remain available and unchanged.",
      "Use exact, unambiguous context in apply_patch. Inspect partial results before retrying; filesystem writes are not transactional.",
    ],
    parameters,
    constrainedSampling: {
      type: "grammar",
      variants: { openai_lark: APPLY_PATCH_GRAMMAR },
    },
    executionMode: "sequential",
    async execute(_id, { patch }, signal) {
      const details = await executePatch(patch, cwd, signal);
      const summary =
        details.status === "applied"
          ? `Applied patch to ${details.changedFiles.length} file(s).\n${details.changedFiles.map((file) => `${file.kind}: ${file.path}${file.destination ? ` -> ${file.destination}` : ""}`).join("\n")}`
          : `${details.status === "partial" ? "PARTIAL application; no rollback" : "Patch rejected; no writes"}: ${details.error}. Completed ${details.changedFiles.length} file(s).${details.mutations.length ? `\nMutations: ${details.mutations.map((m) => `${m.action}: ${m.path}`).join("; ")}` : ""}`;
      return { content: [{ type: "text", text: summary }], details };
    },
  });
}
