import { link, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { validateDirectory } from "./directories";
import { HttpError } from "./errors";

export async function uploadFile(
  req: Request,
  directory: unknown,
  name: unknown,
) {
  const destination = validateDirectory(directory);
  if (
    typeof name !== "string" ||
    !name ||
    name === "." ||
    name === ".." ||
    /[/\\\0]/.test(name) ||
    Buffer.byteLength(name) > 255
  )
    throw new HttpError(400, "Choose a valid file name without a folder path.");

  let temporary: string | undefined;
  try {
    temporary = await mkdtemp(join(destination, ".jelly-upload-"));
    const staged = join(temporary, "file");
    // Stream to disk, then publish the complete file without replacing existing files.
    const file = await open(staged, "wx", 0o600);
    const reader = req.body?.getReader();
    try {
      if (reader) {
        while (true) {
          req.signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          let offset = 0;
          while (offset < value.byteLength) {
            const { bytesWritten } = await file.write(value.subarray(offset));
            offset += bytesWritten;
          }
        }
      }
      req.signal.throwIfAborted();
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      await file.close();
    }
    await link(staged, join(destination, name));
    return { name };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST")
      throw new HttpError(
        409,
        `A file named ${name} already exists. Rename your file or choose another folder.`,
      );
    if (code === "EACCES" || code === "EPERM" || code === "EROFS")
      throw new HttpError(
        403,
        "Jelly cannot write to this folder. Choose another folder.",
      );
    if (code === "ENOSPC" || code === "EDQUOT")
      throw new HttpError(507, "There is not enough space in this folder.");
    throw error;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
