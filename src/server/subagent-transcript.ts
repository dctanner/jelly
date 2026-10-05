import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep, extname } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  SubagentTranscript,
  SubagentTranscriptEntry,
} from "../shared/subagents";

const HEADER_BYTES = 8 * 1024;
const WINDOW_BYTES = 248 * 1024;
const OUTPUT_BYTES = 64 * 1024;
const RECORD_BYTES = 60 * 1024;
const MAX_ENTRIES = 100;
const TEXT_BYTES = 8 * 1024;
type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(line: Buffer): RecordValue | undefined {
  try {
    const value: unknown = JSON.parse(line.toString("utf8"));
    return record(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function unavailable(message = "Transcript unavailable."): SubagentTranscript {
  return { entries: [], before: null, truncated: false, unavailable: message };
}

function contained(root: string, file: string) {
  const child = relative(root, file);
  return (
    child !== "" &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function project(value: RecordValue, offset: number) {
  const entries: SubagentTranscriptEntry[] = [];
  let truncated = false;
  let bytes = 0;
  const bound = (text: string, limit = TEXT_BYTES) => {
    const clean = stripVTControlCharacters(text).replace(
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,
      "",
    );
    const buffer = Buffer.from(clean);
    if (buffer.length <= limit) return clean;
    truncated = true;
    let end = limit - 3;
    while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
    return `${buffer.subarray(0, end).toString("utf8")}…`;
  };
  const add = (entry: SubagentTranscriptEntry) => {
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (entries.length >= MAX_ENTRIES || bytes + size > RECORD_BYTES) {
      truncated = true;
      return false;
    }
    entries.push(entry);
    bytes += size;
    return true;
  };
  // Session JSONL and Pi JSON mode's finalized messages, never deltas or snapshots.
  const message =
    value.type === "message" || value.type === "message_end"
      ? value.message
      : undefined;
  if (
    !record(message) ||
    message.stopReason === "pending" ||
    !Array.isArray(message.content)
  )
    return { entries, truncated };
  const timestamp =
    typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? message.timestamp
      : typeof value.timestamp === "string"
        ? Date.parse(value.timestamp)
        : NaN;
  const time = Number.isFinite(timestamp) ? { timestamp } : {};
  // User, system, custom and compaction context are deliberately not displayed.
  if (message.role === "toolResult") {
    const text = message.content
      .filter(
        (block): block is RecordValue =>
          record(block) &&
          block.type === "text" &&
          !block.redacted &&
          !block.encrypted &&
          typeof block.text === "string",
      )
      .map((block) => block.text as string)
      .join("\n");
    const toolCallId = message.toolCallId;
    if (
      typeof toolCallId !== "string" ||
      !toolCallId ||
      Buffer.byteLength(toolCallId) > 512
    )
      return { entries, truncated: true };
    add({
      id: `${offset}:0`,
      kind: "toolResult",
      role: "toolResult",
      text: bound(text),
      ...time,
      toolCallId,
      ...(typeof message.toolName === "string"
        ? { name: bound(message.toolName, 256) }
        : {}),
      ...(typeof message.isError === "boolean"
        ? { isError: message.isError }
        : {}),
    });
  } else if (message.role === "assistant") {
    for (let index = 0; index < message.content.length; index++) {
      const block: unknown = message.content[index];
      if (!record(block) || block.redacted || block.encrypted) continue;
      const base = { id: `${offset}:${index}`, role: "assistant", ...time };
      let entry: SubagentTranscriptEntry | undefined;
      if (block.type === "text" && typeof block.text === "string" && block.text)
        entry = { ...base, kind: "text", text: bound(block.text) };
      else if (
        block.type === "thinking" &&
        typeof block.thinking === "string" &&
        block.thinking
      )
        entry = { ...base, kind: "thinking", text: bound(block.thinking) };
      else if (block.type === "toolCall") {
        if (
          typeof block.id !== "string" ||
          !block.id ||
          Buffer.byteLength(block.id) > 512 ||
          typeof block.name !== "string"
        ) {
          truncated = true;
          continue;
        }
        try {
          entry = {
            ...base,
            kind: "toolCall",
            toolCallId: block.id,
            name: bound(block.name, 256),
            text: bound(
              record(block.arguments) ? JSON.stringify(block.arguments) : "{}",
            ),
          };
        } catch {
          truncated = true;
        }
      }
      if (entry && !add(entry)) break;
    }
  }
  return { entries, truncated };
}

/** Read only an ownership-checked path supplied by the host. Pi session-format.md,
 * message-types.md and json.md define the allowlisted finalized record shapes.
 * Cursors are exclusive byte offsets; IDs remain stable while files are appended.
 */
export async function readSubagentTranscript(
  source: { sessionFile: string; roots: string[] },
  before?: number,
): Promise<SubagentTranscript> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (
      !isAbsolute(source.sessionFile) ||
      extname(source.sessionFile) !== ".jsonl" ||
      (before !== undefined && (!Number.isSafeInteger(before) || before < 0))
    )
      return unavailable();
    const path = await realpath(source.sessionFile);
    if (extname(path) !== ".jsonl") return unavailable();
    let trusted = false;
    for (const root of source.roots) {
      if (!isAbsolute(root)) continue;
      try {
        if (contained(await realpath(root), path)) {
          trusted = true;
          break;
        }
      } catch {
        /* An expired root does not grant access. */
      }
    }
    if (!trusted) return unavailable();
    const expected = await lstat(path);
    if (!expected.isFile()) return unavailable();
    // Nonblocking prevents a raced FIFO from hanging; no-follow and inode/path
    // rechecks prevent reading a replacement symlink or an escaped directory.
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      (await realpath(path)) !== path ||
      (await realpath(source.sessionFile)) !== path ||
      !Number.isSafeInteger(stat.size) ||
      (before !== undefined && before > stat.size)
    )
      return unavailable();

    // Total file reads are capped at 256 KiB, including attribution/header checks.
    const headerBuffer = Buffer.alloc(Math.min(HEADER_BYTES, stat.size));
    const headerRead = await file.read(headerBuffer, 0, headerBuffer.length, 0);
    const headerEnd = headerBuffer
      .subarray(0, headerRead.bytesRead)
      .indexOf(10);
    if (headerEnd < 0) return unavailable();
    const header = parse(headerBuffer.subarray(0, headerEnd));
    if (
      !header ||
      header.type !== "session" ||
      typeof header.id !== "string" ||
      !header.id ||
      ![1, 2, 3].includes((header.version ?? 1) as number)
    )
      return unavailable();
    // Forks copy inherited entries but have no authoritative child-boundary marker.
    // Do not guess from timestamps or the first (potentially inherited) user turn.
    if ("parentSession" in header)
      return unavailable(
        "Transcript unavailable: inherited fork context cannot be safely separated.",
      );

    const generation = createHash("sha256")
      .update(JSON.stringify([stat.dev, stat.ino, header.id]))
      .digest("hex")
      .slice(0, 32);
    const floor = headerEnd + 1;
    const end = before ?? stat.size;
    if (end <= floor)
      return { generation, entries: [], before: null, truncated: false };
    const start = Math.max(floor, end - WINDOW_BYTES + 1);
    const readStart = start > floor ? start - 1 : start;
    const buffer = Buffer.alloc(end - readStart);
    const read = await file.read(buffer, 0, buffer.length, readStart);
    const data = buffer.subarray(0, read.bytesRead);
    let first = start - readStart;
    if (start > floor && data[0] !== 10) {
      const newline = data.indexOf(10, first);
      first = newline < 0 ? data.length : newline + 1;
    }
    // A huge line may occupy the whole window. Advance through it instead of
    // returning the same cursor forever; never assemble it with unbounded reads.
    let cursor = readStart + first;
    if (cursor >= end) cursor = start;
    let truncated = start > floor || read.bytesRead !== buffer.length;
    const lines: { start: number; end: number }[] = [];
    for (let position = first; position < data.length;) {
      const newline = data.indexOf(10, position);
      if (newline < 0) {
        truncated = true;
        break;
      }
      lines.push({ start: position, end: newline + 1 });
      position = newline + 1;
    }
    const entries: SubagentTranscriptEntry[] = [];
    let outputBytes = 128; // Envelope, commas and maximum numeric cursor overhead.
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]!;
      const value = parse(data.subarray(line.start, line.end - 1));
      if (!value) {
        truncated = true;
        continue;
      }
      const projected = project(value, readStart + line.start);
      const bytes = projected.entries.reduce(
        (total, entry) => total + Buffer.byteLength(JSON.stringify(entry)) + 1,
        0,
      );
      if (
        entries.length + projected.entries.length > MAX_ENTRIES ||
        outputBytes + bytes > OUTPUT_BYTES
      ) {
        // Keep records atomic so a numeric cursor never duplicates/skips blocks
        // across pages. Oversized individual records are bounded in project().
        cursor = readStart + line.end;
        truncated = true;
        break;
      }
      entries.unshift(...projected.entries);
      outputBytes += bytes;
      truncated ||= projected.truncated;
    }
    return {
      generation,
      entries,
      before: cursor > floor ? cursor : null,
      truncated,
    };
  } catch {
    return unavailable();
  } finally {
    await file?.close().catch(() => {});
  }
}
