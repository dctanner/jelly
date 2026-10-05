import { afterEach, expect, spyOn, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readSubagentTranscript } from "../src/server/subagent-transcript";
import type { SubagentTranscript } from "../src/shared/subagents";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const header = {
  type: "session",
  version: 3,
  id: "child-session",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/private/header-path",
};
const line = (value: unknown) => JSON.stringify(value) + "\n";
const assistant = (text: string, timestamp = 100) => ({
  type: "message",
  timestamp: "2026-01-01T00:00:01.000Z",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp,
  },
});
async function fixture(records: unknown[] = []) {
  const root = await mkdtemp(join(tmpdir(), "jelly-subagent-transcript-"));
  directories.push(root);
  const sessionFile = join(root, "child.jsonl");
  await writeFile(sessionFile, [header, ...records].map(line).join(""));
  return { sessionFile, roots: [root] };
}
function bounded(page: SubagentTranscript) {
  expect(page.entries.length).toBeLessThanOrEqual(100);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
    64 * 1024,
  );
  expect(page.unavailable).toBeUndefined();
}
function denied(page: SubagentTranscript) {
  expect(page.entries).toEqual([]);
  expect(page.before).toBeNull();
  expect(page.unavailable).toBe("Transcript unavailable.");
  expect(JSON.stringify(page)).not.toContain(tmpdir());
}

test("transcript generations stay stable on append and change with the source file", async () => {
  const source = await fixture([assistant("original")]);
  const first = await readSubagentTranscript(source);
  expect(first.generation).toMatch(/^[a-f0-9]{32}$/);
  await appendFile(source.sessionFile, line(assistant("appended")));
  expect((await readSubagentTranscript(source)).generation).toBe(
    first.generation,
  );
  const replacement = await fixture([assistant("new file")]);
  const next = await readSubagentTranscript(replacement);
  expect(next.generation).not.toBe(first.generation);
  expect(next.entries[0]?.id).toBe(first.entries[0]?.id);
});

test("subagent transcript projects only exposed thinking and excludes signatures, redacted and encrypted blocks", async () => {
  const source = await fixture([
    {
      type: "message",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        stopReason: "stop",
        errorMessage: "PRIVATE ERROR",
        provider: "PRIVATE PROVIDER",
        content: [
          {
            type: "thinking",
            thinking: "Visible reasoning",
            thinkingSignature: "SECRET SIGNATURE",
          },
          {
            type: "thinking",
            thinking: "SECRET REDACTED",
            redacted: true,
            thinkingSignature: "SECRET PAYLOAD",
          },
          { type: "redacted_thinking", data: "SECRET REDACTED BLOCK" },
          { type: "thinking", thinking: "SECRET ENCRYPTED", encrypted: true },
          { type: "encrypted", data: "SECRET ENCRYPTED BLOCK" },
          { type: "thinking", thinkingSignature: "SECRET EMPTY SIGNATURE" },
          {
            type: "text",
            text: "Visible answer",
            textSignature: "SECRET TEXT SIGNATURE",
          },
          { type: "image", data: "SECRET IMAGE" },
        ],
      },
    },
  ]);
  const page = await readSubagentTranscript(source);
  bounded(page);
  expect(page.entries.map((entry) => [entry.kind, entry.text])).toEqual([
    ["thinking", "Visible reasoning"],
    ["text", "Visible answer"],
  ]);
  expect(page.entries[0]!.timestamp).toBe(
    Date.parse("2026-01-01T00:00:01.000Z"),
  );
  expect(page.entries.map((entry) => entry.id)).toEqual([
    `${Buffer.byteLength(line(header))}:0`,
    `${Buffer.byteLength(line(header))}:6`,
  ]);
  expect(JSON.stringify(page)).not.toMatch(
    /SECRET|PRIVATE|private\/header-path|thinkingSignature|textSignature/,
  );
});

test("subagent transcript pairs finalized tools with stable IDs, bounded displayed args/results and errors", async () => {
  const source = await fixture([
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        timestamp: 123,
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            arguments: { path: "src/file.ts" },
            thoughtSignature: "PRIVATE SIGNATURE",
          },
          {
            type: "toolCall",
            id: "call-2",
            name: "bash",
            arguments: { command: "x".repeat(20_000) },
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
        timestamp: 124,
        content: [
          { type: "text", text: "file text" },
          { type: "text", text: "PRIVATE REDACTED", redacted: true },
          { type: "image", data: "PRIVATE IMAGE" },
        ],
        details: { path: "/PRIVATE DETAILS" },
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "bash",
        isError: true,
        timestamp: 125,
        content: [{ type: "text", text: "failure".repeat(5_000) }],
      },
    },
  ]);
  const page = await readSubagentTranscript(source);
  bounded(page);
  expect(
    page.entries.map((entry) => [entry.kind, entry.toolCallId, entry.name]),
  ).toEqual([
    ["toolCall", "call-1", "read"],
    ["toolCall", "call-2", "bash"],
    ["toolResult", "call-1", "read"],
    ["toolResult", "call-2", "bash"],
  ]);
  expect(page.entries[0]!.text).toBe('{"path":"src/file.ts"}');
  expect(page.entries[2]!.isError).toBe(false);
  expect(page.entries[3]!.isError).toBe(true);
  expect(
    page.entries.every((entry) => Buffer.byteLength(entry.text) <= 8192),
  ).toBe(true);
  expect(page.truncated).toBe(true);
  expect(JSON.stringify(page)).not.toMatch(/PRIVATE|thoughtSignature|details/);
});

test("subagent transcript omits initial user, system, custom and inherited context", async () => {
  const source = await fixture([
    ...["user", "system", "custom", "compactionSummary", "branchSummary"].map(
      (role) => ({
        type: "message",
        message: { role, content: [{ type: "text", text: "PRIVATE CONTEXT" }] },
      }),
    ),
    { type: "custom_message", content: "PRIVATE CONTEXT", display: true },
    { type: "compaction", summary: "PRIVATE CONTEXT" },
    assistant("child answer"),
  ]);
  expect(
    (await readSubagentTranscript(source)).entries.map((entry) => entry.text),
  ).toEqual(["child answer"]);
  await writeFile(
    source.sessionFile,
    [
      { ...header, parentSession: "/private/parent.jsonl" },
      assistant("PRIVATE INHERITED"),
      {
        type: "message",
        message: {
          role: "user",
          content: "new child task",
          timestamp: 9_999_999_999_999,
        },
      },
      assistant("child answer"),
    ]
      .map(line)
      .join(""),
  );
  const fork = await readSubagentTranscript(source);
  expect(fork.entries).toEqual([]);
  expect(fork.before).toBeNull();
  expect(fork.unavailable).toContain("inherited fork context");
  expect(JSON.stringify(fork)).not.toMatch(/PRIVATE|\/private/);
});

test("subagent transcript reads finalized JSON message_end but not streaming or duplicated event snapshots", async () => {
  const final = assistant("finished").message;
  const source = await fixture([
    { type: "message_start", message: final },
    {
      type: "message_update",
      message: final,
      assistantMessageEvent: { type: "text_delta", delta: "PRIVATE PARTIAL" },
    },
    { type: "message_end", message: { ...final, stopReason: "pending" } },
    { type: "message", message: { ...final, stopReason: "pending" } },
    { type: "message_end", message: final },
    { type: "turn_end", message: final },
    { type: "agent_end", messages: [final] },
  ]);
  expect(
    (await readSubagentTranscript(source)).entries.map((entry) => entry.text),
  ).toEqual(["finished"]);
});

test("subagent transcript paginates newest-last with stable byte IDs and no duplicates after append", async () => {
  const records = Array.from({ length: 237 }, (_, index) =>
    assistant(`message ${index} 🐈`, index),
  );
  const source = await fixture(records);
  let page = await readSubagentTranscript(source);
  const first = page;
  const collected = [...page.entries];
  let previousCursor = Infinity;
  while (page.before !== null) {
    bounded(page);
    expect(page.before).toBeLessThan(previousCursor);
    previousCursor = page.before;
    page = await readSubagentTranscript(source, page.before);
    collected.unshift(...page.entries);
  }
  expect(collected.map((entry) => entry.text)).toEqual(
    records.map((value) => value.message.content[0]!.text),
  );
  expect(new Set(collected.map((entry) => entry.id)).size).toBe(237);
  const offset = Buffer.byteLength(line(header) + line(records[0]));
  expect(collected[1]!.id).toBe(`${offset}:0`);
  const olderBeforeAppend = await readSubagentTranscript(source, first.before!);
  await appendFile(
    source.sessionFile,
    line(assistant("new appended message", 999)),
  );
  expect(await readSubagentTranscript(source, first.before!)).toEqual(
    olderBeforeAppend,
  );
  const refreshed = await readSubagentTranscript(source);
  for (const entry of refreshed.entries.filter(
    (entry) => entry.timestamp !== 999,
  ))
    expect(first.entries.find((old) => old.id === entry.id)).toEqual(entry);
  expect(refreshed.entries.at(-1)!.text).toBe("new appended message");
});

test("subagent transcript keeps multi-block records atomic at page boundaries", async () => {
  const source = await fixture(
    Array.from({ length: 60 }, (_, index) => ({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: `think ${index}` },
          { type: "text", text: `text ${index}` },
        ],
        stopReason: "stop",
      },
    })),
  );
  const recent = await readSubagentTranscript(source);
  const older = await readSubagentTranscript(source, recent.before!);
  expect(recent.entries).toHaveLength(100);
  expect(older.entries).toHaveLength(20);
  expect(older.before).toBeNull();
  expect(older.entries.at(-1)!.text).toBe("text 9");
  expect(recent.entries[0]!.text).toBe("think 10");
  expect(
    new Set([...older.entries, ...recent.entries].map((entry) => entry.id))
      .size,
  ).toBe(120);
});

test("subagent transcript tolerates malformed lines and incomplete final JSONL until finalized", async () => {
  const source = await fixture([assistant("first")]);
  await appendFile(
    source.sessionFile,
    "{malformed}\nnull\n[]\n\n" +
      line(assistant("second")) +
      JSON.stringify(assistant("last")),
  );
  const initial = await readSubagentTranscript(source);
  expect(initial.entries.map((entry) => entry.text)).toEqual([
    "first",
    "second",
  ]);
  expect(initial.truncated).toBe(true);
  await appendFile(source.sessionFile, "\n");
  const finalized = await readSubagentTranscript(source);
  expect(finalized.entries.map((entry) => entry.text)).toEqual([
    "first",
    "second",
    "last",
  ]);
  expect(finalized.entries.slice(0, 2)).toEqual(initial.entries);
});

test("subagent transcript bounds serialized bytes including escaping and truncates UTF8 without replacement characters", async () => {
  const text = '🐈漢é"\\\u2028\u2029'.repeat(1700);
  const source = await fixture(
    Array.from({ length: 8 }, (_, index) => assistant(`${index}:${text}`)),
  );
  let page = await readSubagentTranscript(source);
  const all = [...page.entries];
  bounded(page);
  while (page.before !== null) {
    const cursor = page.before;
    page = await readSubagentTranscript(source, cursor);
    bounded(page);
    expect(page.before === null || page.before < cursor).toBe(true);
    all.unshift(...page.entries);
  }
  expect(all).toHaveLength(8);
  for (const entry of all) {
    expect(entry.text).not.toContain("\ufffd");
    expect(entry.text).toContain("\u2028\u2029");
    expect(Buffer.byteLength(entry.text)).toBeLessThanOrEqual(8192);
  }
});

test("subagent transcript strips terminal controls and bounds a single record with too many blocks", async () => {
  const source = await fixture([
    assistant("older"),
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: Array.from({ length: 150 }, () => ({
          type: "text",
          text: "\x1b[31mhello\x1b[0m\x00\nworld",
        })),
      },
    },
  ]);
  const page = await readSubagentTranscript(source);
  bounded(page);
  expect(page.entries).toHaveLength(100);
  expect(page.entries[0]!.text).toBe("hello\nworld");
  expect(page.truncated).toBe(true);
  expect(
    (await readSubagentTranscript(source, page.before!)).entries.map(
      (entry) => entry.text,
    ),
  ).toEqual(["older"]);
});

test("subagent transcript caps actual reads at 256KiB and advances past oversized records without looping", async () => {
  const source = await fixture([
    assistant("oldest"),
    assistant("x".repeat(1024 * 1024)),
    assistant("newest"),
  ]);
  const handle = await open(source.sessionFile, "r");
  const prototype = Object.getPrototypeOf(handle);
  const readSpy = spyOn(prototype, "read");
  await handle.close();
  try {
    let page = await readSubagentTranscript(source);
    const entries = [...page.entries];
    let pages = 1;
    for (;;) {
      const requested = readSpy.mock.calls.reduce(
        (total: number, args: unknown[]) => total + (args[2] as number),
        0,
      );
      expect(requested).toBeLessThanOrEqual(256 * 1024);
      expect(readSpy.mock.calls.length).toBeLessThanOrEqual(2);
      readSpy.mockClear();
      bounded(page);
      if (page.before === null) break;
      const before = page.before;
      page = await readSubagentTranscript(source, before);
      expect(page.before === null || page.before < before).toBe(true);
      entries.unshift(...page.entries);
      expect(++pages).toBeLessThan(10);
    }
    expect(entries.map((entry) => entry.text)).toEqual(["oldest", "newest"]);
  } finally {
    readSpy.mockRestore();
  }
});

test("subagent transcript rejects untrusted paths, sibling prefix escape and traversal outside a trusted root", async () => {
  const source = await fixture([assistant("private")]);
  denied(await readSubagentTranscript({ ...source, roots: [] }));
  const trusted = join(source.roots[0]!, "trusted");
  const sibling = join(source.roots[0]!, "trusted-other");
  await mkdir(trusted);
  await mkdir(sibling);
  const outside = join(sibling, "outside.jsonl");
  await writeFile(outside, line(header) + line(assistant("private")));
  denied(
    await readSubagentTranscript({ sessionFile: outside, roots: [trusted] }),
  );
  denied(
    await readSubagentTranscript({
      sessionFile: `${trusted}/../trusted-other/outside.jsonl`,
      roots: [trusted],
    }),
  );
  denied(
    await readSubagentTranscript({
      sessionFile: "relative.jsonl",
      roots: source.roots,
    }),
  );
  denied(
    await readSubagentTranscript({
      ...source,
      roots: [join(trusted, "missing")],
    }),
  );
});

test("subagent transcript canonicalizes trusted roots and rejects file/directory symlink escapes", async () => {
  const source = await fixture([assistant("safe")]);
  const outside = await fixture([assistant("private")]);
  const root = source.roots[0]!;
  await symlink(outside.sessionFile, join(root, "escape.jsonl"));
  await symlink(outside.roots[0]!, join(root, "escape-dir"));
  denied(
    await readSubagentTranscript({
      ...source,
      sessionFile: join(root, "escape.jsonl"),
    }),
  );
  denied(
    await readSubagentTranscript({
      ...source,
      sessionFile: join(root, "escape-dir", "child.jsonl"),
    }),
  );
  await symlink(source.sessionFile, join(root, "inside.jsonl"));
  expect(
    (
      await readSubagentTranscript({
        ...source,
        sessionFile: join(root, "inside.jsonl"),
      })
    ).entries[0]!.text,
  ).toBe("safe");
  const rootAlias = join(outside.roots[0]!, "root-alias");
  await symlink(root, rootAlias);
  expect(
    (await readSubagentTranscript({ ...source, roots: [rootAlias] }))
      .entries[0]!.text,
  ).toBe("safe");
});

test("subagent transcript rejects nonregular files and never reads credential paths", async () => {
  const source = await fixture();
  const root = source.roots[0]!;
  const directory = join(root, "directory.jsonl");
  await mkdir(directory);
  denied(await readSubagentTranscript({ ...source, sessionFile: directory }));
  const fifo = join(root, "fifo.jsonl");
  expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
  denied(await readSubagentTranscript({ ...source, sessionFile: fifo }));
  const credential = join(root, "auth.json");
  await writeFile(credential, "DO NOT READ");
  await symlink(credential, join(root, "credential.jsonl"));
  const handle = await open(source.sessionFile, "r");
  const spy = spyOn(Object.getPrototypeOf(handle), "read");
  await handle.close();
  try {
    denied(
      await readSubagentTranscript({ ...source, sessionFile: credential }),
    );
    denied(
      await readSubagentTranscript({
        ...source,
        sessionFile: join(root, "credential.jsonl"),
      }),
    );
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test("subagent transcript safely reports vanished files, invalid headers and invalid byte cursors", async () => {
  const source = await fixture([assistant("safe")]);
  for (const cursor of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    denied(await readSubagentTranscript(source, cursor));
  expect(await readSubagentTranscript(source, 0)).toMatchObject({
    entries: [],
    before: null,
    truncated: false,
  });
  for (const contents of [
    "",
    "{invalid}\n",
    line({ ...header, version: 99 }),
    line(assistant("headerless")),
    line({ ...header, id: "x".repeat(9000) }),
  ]) {
    await writeFile(source.sessionFile, contents);
    denied(await readSubagentTranscript(source));
  }
  await unlink(source.sessionFile);
  denied(await readSubagentTranscript(source));
});
