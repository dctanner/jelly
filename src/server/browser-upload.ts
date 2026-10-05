import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

// Playwright caps in-memory file payloads at 50 MiB in total. Buffers also keep
// browser File objects readable after the tool finishes or a source is changed.
const MAX_TOTAL = 50 * 1024 * 1024;

export async function readBrowserUploadFiles(paths: unknown, guard: () => void) {
  guard();
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 10 ||
      !paths.every(p => typeof p === "string" && p.length <= 4096 &&
        !p.includes("\0") && isAbsolute(p)))
    throw new Error("Upload 1–10 absolute file paths (at most 4096 characters each).");
  const files: { name: string; mimeType: string; buffer: Buffer }[] = [];
  let total = 0;
  for (const source of paths) {
    guard();
    // O_NONBLOCK avoids hanging on FIFOs before the regular-file check.
    const input = await open(source, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      guard();
      const before = await input.stat();
      if (!before.isFile()) throw new Error("Upload regular files, not directories or devices.");
      if (total + before.size > MAX_TOTAL)
        throw new Error("Browser uploads are limited to 50 MiB total per call.");
      const buffer = Buffer.alloc(before.size);
      let size = 0;
      while (size < buffer.length) {
        guard();
        const { bytesRead } = await input.read(buffer, size, Math.min(1024 * 1024, buffer.length - size));
        guard();
        if (!bytesRead) break;
        size += bytesRead;
      }
      const extra = await input.read(Buffer.alloc(1));
      const after = await input.stat();
      guard();
      if (extra.bytesRead || size !== before.size || after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
        throw new Error("File changed while preparing upload; try again after writing finishes.");
      total += size;
      files.push({ name: basename(source), mimeType: Bun.file(source).type || "application/octet-stream", buffer });
    } finally {
      await input.close();
    }
  }
  guard();
  return files;
}
