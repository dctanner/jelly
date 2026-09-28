import { constants } from "node:fs";
import { mkdir, open, writeFile, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  isRenderedFile,
  isRenderedFileUrl,
  type RenderedFile,
} from "../shared/rendered-files";
import { rasterMime } from "./raster-images";

const MAX_FILE = 20 * 1024 * 1024;
const MAX_TEXT = 2 * 1024 * 1024;

async function readRegularFile(path: string, limit: number, noFollow = false) {
  const file = await open(
    path,
    constants.O_RDONLY |
      constants.O_NONBLOCK |
      (noFollow ? constants.O_NOFOLLOW : 0),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile())
      throw new Error(
        "Render a regular image or text file, not a directory or device.",
      );
    if (stat.size > limit)
      throw new Error(
        "File is too large to render (20 MiB images, 2 MiB text).",
      );
    // Bound the read even if another process grows the source after stat().
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > stat.size)
      throw new Error(
        "File changed while rendering. Try again once writing finishes.",
      );
    return Buffer.from(buffer.subarray(0, length));
  } finally {
    await file.close();
  }
}
function textContents(bytes: Buffer) {
  if (bytes.length > MAX_TEXT)
    throw new Error("Text files must be at most 2 MiB.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/[\x00-\x08\x0e-\x1f]/.test(text))
    throw new Error(
      "Unsupported binary file. Render a raster image or UTF-8 text file.",
    );
  return text;
}

/** Immutable private copies keep attachments available after source edits and restarts. */
export class RenderedFiles {
  readonly directory: string;
  constructor(dataDir: string) {
    this.directory = join(dataDir, "rendered-files");
  }
  async save(
    path: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RenderedFile> {
    signal?.throwIfAborted();
    const source = resolve(cwd, path);
    const bytes = await readRegularFile(source, MAX_FILE);
    const imageType = rasterMime(bytes);
    if (!imageType) textContents(bytes);
    signal?.throwIfAborted();
    const id = crypto.randomUUID();
    const metadata: RenderedFile = {
      id,
      url: `/api/rendered-files/${id}`,
      name: basename(source),
      kind: imageType ? "image" : "text",
      mimeType: imageType ?? "text/plain; charset=utf-8",
      size: bytes.length,
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(this.directory, `${id}.bin`), bytes, {
        mode: 0o600,
        flag: "wx",
      });
      await writeFile(
        join(this.directory, `${id}.json`),
        JSON.stringify(metadata),
        { mode: 0o600, flag: "wx" },
      );
      signal?.throwIfAborted();
      return metadata;
    } catch (error) {
      await this.remove(metadata);
      throw error;
    }
  }
  async remove(file: RenderedFile) {
    await Promise.all(
      ["bin", "json"].map((extension) =>
        unlink(join(this.directory, `${file.id}.${extension}`)).catch(() => {}),
      ),
    );
  }
  async read(url: string) {
    if (!isRenderedFileUrl(url)) return null;
    const id = url.slice("/api/rendered-files/".length);
    try {
      const metadata = JSON.parse(
        (
          await readRegularFile(join(this.directory, `${id}.json`), 16384, true)
        ).toString("utf8"),
      );
      if (
        !isRenderedFile(metadata) ||
        metadata.id !== id ||
        metadata.url !== url
      )
        return null;
      const bytes = await readRegularFile(
        join(this.directory, `${id}.bin`),
        MAX_FILE,
        true,
      );
      if (bytes.length !== metadata.size) return null;
      if (metadata.kind === "image") {
        if (rasterMime(bytes) !== metadata.mimeType) return null;
      } else {
        if (metadata.mimeType !== "text/plain; charset=utf-8") return null;
        textContents(bytes);
      }
      return { metadata, bytes };
    } catch {
      return null;
    }
  }
}

export function renderFileTool(
  files: RenderedFiles,
  cwd: string,
  report: (type: string, data: Record<string, unknown>) => void,
): ToolDefinition {
  return {
    name: "render_file",
    label: "Show file in chat",
    description:
      "Display an existing local image or UTF-8 text file in chat without reading its contents into model context. Images appear inline; text gets an expandable plain-text preview and download. Returns only metadata. Use this when asked to show a file; no prior read is needed. Supports PNG, JPEG, GIF, WebP and BMP (up to 20 MiB), and text/code/Markdown/HTML/SVG as inert text (up to 2 MiB). Relative paths use the agent working directory. Files are copied privately so attachments survive source edits. Do not repeat the attachment in Markdown.",
    parameters: Type.Object({
      path: Type.String({
        minLength: 1,
        maxLength: 4096,
        description: "Absolute or working-directory-relative file path",
      }),
    }),
    execute: async (_id, args: any, signal) => {
      if (
        typeof args.path !== "string" ||
        !args.path.trim() ||
        args.path.length > 4096
      )
        throw new Error("Provide a local file path.");
      const file = await files.save(args.path, cwd, signal);
      try {
        report("file_rendered", { files: [file] });
      } catch (error) {
        await files.remove(file);
        throw error;
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ files: [file], displayedInChat: true }),
          },
        ],
        details: { files: [file] },
      };
    },
  };
}
