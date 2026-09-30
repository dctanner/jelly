import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executePatch,
  PATCH_LIMITS,
  type PatchIO,
} from "../src/server/apply-patch";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), "jelly-patch-"));
  dirs.push(dir);
  return {
    dir,
    write: (p: string, value: string) => fs.writeFileSync(join(dir, p), value),
    read: (p: string) => fs.readFileSync(join(dir, p), "utf8"),
  };
}
const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch\n`;
const add = (p = "new.txt") => `*** Add File: ${p}\n+hello`;
const update = (p = "a") => `*** Update File: ${p}\n@@\n-old\n+new`;

test("apply_patch add/update/delete/move with structured diffs and full-host cwd semantics", async () => {
  const f = fixture();
  const outside = fixture();
  f.write("a", "old\n");
  f.write("gone", "bye");
  f.write("move", "old\n");
  const result = await executePatch(
    patch(
      `${add("nested/new")}\n${update()}\n*** Delete File: gone\n*** Update File: move\n*** Move to: moved\n@@\n-old\n+relocated\n${add(join(outside.dir, "absolute"))}`,
    ),
    f.dir,
  );
  expect(result.status).toBe("applied");
  expect(result.changedFiles).toHaveLength(5);
  expect(result.changedFiles[1].diff).toContain("-old\n+new");
  expect(f.read("nested/new")).toBe("hello\n");
  expect(f.read("a")).toBe("new\n");
  expect(f.read("moved")).toBe("relocated\n");
  expect(fs.existsSync(join(f.dir, "gone"))).toBe(false);
  expect(fs.existsSync(join(f.dir, "move"))).toBe(false);
  expect(outside.read("absolute")).toBe("hello\n");
  const relative = `../${outside.dir.split("/").at(-1)}/relative`;
  expect((await executePatch(patch(add(relative)), f.dir)).status).toBe(
    "applied",
  );
});

test("apply_patch preserves BOM, CRLF, Unicode, missing final newline, and file modes", async () => {
  const f = fixture();
  f.write("a", "\uFEFFhéllo 🌊\r\nold\r\n");
  fs.chmodSync(join(f.dir, "a"), 0o751);
  expect((await executePatch(patch(update()), f.dir)).status).toBe("applied");
  expect(f.read("a")).toBe("\uFEFFhéllo 🌊\r\nnew\r\n");
  expect(fs.statSync(join(f.dir, "a")).mode & 0o777).toBe(0o751);
  expect(
    (await executePatch(patch("*** Update File: a\n*** Move to: moved"), f.dir))
      .status,
  ).toBe("applied");
  expect(f.read("moved")).toBe("\uFEFFhéllo 🌊\r\nnew\r\n");
  expect(fs.statSync(join(f.dir, "moved")).mode & 0o777).toBe(0o751);
  f.write("a", "old");
  expect((await executePatch(patch(update()), f.dir)).status).toBe("applied");
  expect(f.read("a")).toBe("new");
  f.write("a", "\uFEFFold\n");
  expect((await executePatch(patch(update()), f.dir)).status).toBe("applied");
  expect(f.read("a")).toBe("\uFEFFnew\n");
});

test("apply_patch exact anchors and EOF disambiguate repeated contexts", async () => {
  const f = fixture();
  f.write("a", "old\nanchor\nold\n");
  expect(
    (
      await executePatch(
        patch("*** Update File: a\n@@ anchor\n-old\n+new"),
        f.dir,
      )
    ).status,
  ).toBe("applied");
  expect(f.read("a")).toBe("old\nanchor\nnew\n");
  expect(
    (
      await executePatch(
        patch("*** Update File: a\n@@\n-new\n+last\n*** End of File"),
        f.dir,
      )
    ).status,
  ).toBe("applied");
  expect(
    (
      await executePatch(
        patch("*** Update File: a\n@@\n+appended\n*** End of File"),
        f.dir,
      )
    ).status,
  ).toBe("applied");
  expect(f.read("a")).toBe("old\nanchor\nlast\nappended\n");
});

for (const [name, content, body] of [
  ["ambiguous", "old\nold\n", update()],
  ["whitespace fuzz", " old\n", update()],
  ["missing anchor", "old\n", "*** Update File: a\n@@ missing\n-old\n+new"],
  [
    "ambiguous anchor",
    "anchor\nold\nanchor\n",
    "*** Update File: a\n@@ anchor\n-old\n+new",
  ],
  ["overlapping hunks", "old\n", `${update()}\n@@\n-old\n+again`],
  ["EOF fallback", "old\nend\n", `${update()}\n*** End of File`],
  ["unanchored insertion", "old\n", "*** Update File: a\n@@\n+new"],
  ["empty hunk", "old\n", "*** Update File: a\n@@"],
  ["empty update", "old\n", "*** Update File: a"],
  ["bare line", "old\n", "*** Update File: a\n@@\nold"],
  ["blank line", "old\n", `${update()}\n`],
  ["double EOF", "old\n", `${update()}\n*** End of File\n*** End of File`],
  ["repeated file", "old\n", `${update()}\n${update("./a")}`],
  ["existing add", "old\n", add("a")],
  ["self move", "old\n", "*** Update File: a\n*** Move to: ./a"],
  [
    "destination overwrite",
    "old\n",
    "*** Update File: a\n*** Move to: occupied",
  ],
  [
    "move conflict",
    "old\n",
    `*** Update File: a\n*** Move to: dest\n${add("dest")}`,
  ],
  ["parent conflict", "old\n", `${add("dir")}\n${add("dir/child")}`],
  ["delete body", "old\n", "*** Delete File: a\n+oops"],
  ["mixed newlines", "old\r\nother\n", update()],
  ["binary", "old\0", update()],
] as const)
  test(`apply_patch preflight rejects ${name} without any writes`, async () => {
    const f = fixture();
    f.write("a", content);
    f.write("occupied", "keep");
    const result = await executePatch(
      patch(`${add("would-create")}\n${body}`),
      f.dir,
    );
    expect(result.status).toBe("rejected");
    expect(result.mutations).toEqual([]);
    expect(f.read("a")).toBe(content);
    expect(fs.existsSync(join(f.dir, "would-create"))).toBe(false);
  });

test("apply_patch refuses symlink sources, destinations, ancestor links, dangling links and hardlinks", async () => {
  const f = fixture();
  const target = fixture();
  target.write("a", "old\n");
  fs.symlinkSync(join(target.dir, "a"), join(f.dir, "a"));
  fs.symlinkSync(target.dir, join(f.dir, "link"));
  fs.symlinkSync(join(target.dir, "missing"), join(f.dir, "dangling"));
  for (const body of [
    update(),
    "*** Delete File: a",
    add("a"),
    add("link/new"),
    add("dangling"),
    "*** Update File: link/a\n*** Move to: elsewhere",
  ]) {
    expect((await executePatch(patch(body), f.dir)).status).toBe("rejected");
  }
  fs.linkSync(join(target.dir, "a"), join(f.dir, "hard"));
  expect((await executePatch(patch(update("hard")), f.dir)).status).toBe(
    "rejected",
  );
  expect(target.read("a")).toBe("old\n");
});

test("apply_patch detects stale files between preflight and writes", async () => {
  const f = fixture();
  f.write("a", "old\n");
  let reads = 0;
  const io: PatchIO = {
    ...fs,
    readSync: ((...args: any[]) => {
      const result = (fs.readSync as any)(...args);
      if (++reads === 1) queueMicrotask(() => f.write("a", "external\n"));
      return result;
    }) as typeof fs.readSync,
  };
  const result = await executePatch(
    patch(`${add()}\n${update()}`),
    f.dir,
    undefined,
    io,
  );
  expect(result.status).toBe("rejected");
  expect(result.error).toContain("Stale");
  expect(result.mutations).toEqual([]);
  expect(f.read("a")).toBe("external\n");
});

test("apply_patch cancellation before, during preflight, and after a mutation is accurate", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  expect(
    (await executePatch(patch(add()), f.dir, controller.signal)).status,
  ).toBe("rejected");
  f.write("a", "old\n");
  const preflightAbort = new AbortController();
  const beforeIO: PatchIO = {
    ...fs,
    readSync: ((...args: any[]) => {
      const bytes = (fs.readSync as any)(...args);
      preflightAbort.abort();
      return bytes;
    }) as typeof fs.readSync,
  };
  expect(
    (
      await executePatch(
        patch(update()),
        f.dir,
        preflightAbort.signal,
        beforeIO,
      )
    ).mutations,
  ).toEqual([]);
  const afterAbort = new AbortController();
  const io: PatchIO = {
    ...fs,
    writeSync: ((...args: any[]) => {
      const n = (fs.writeSync as any)(...args);
      afterAbort.abort();
      return n;
    }) as typeof fs.writeSync,
  };
  const result = await executePatch(
    patch(`${add()}\n${add("second")}`),
    f.dir,
    afterAbort.signal,
    io,
  );
  expect(result.status).toBe("partial");
  expect(result.changedFiles).toHaveLength(1);
  expect(f.read("new.txt")).toBe("hello\n");
  expect(fs.existsSync(join(f.dir, "second"))).toBe(false);
});

test("apply_patch reports partial writes and incomplete moves without claiming rollback", async () => {
  const f = fixture();
  f.write("a", "old\n");
  const io: PatchIO = {
    ...fs,
    writeSync: (() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }) as typeof fs.writeSync,
  };
  const result = await executePatch(patch(update()), f.dir, undefined, io);
  expect(result.status).toBe("partial");
  expect(result.error).toBe("ENOSPC");
  expect(result.changedFiles).toEqual([]);
  expect(result.mutations).toEqual([
    { path: join(f.dir, "a"), action: "write-started" },
  ]);
  expect(f.read("a")).toBe("");
  f.write("a", "old\n");
  const moveIO: PatchIO = {
    ...fs,
    unlinkSync: () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
  };
  const move = await executePatch(
    patch("*** Update File: a\n*** Move to: moved"),
    f.dir,
    undefined,
    moveIO,
  );
  expect(move.status).toBe("partial");
  expect(move.changedFiles).toEqual([]);
  expect(f.read("a")).toBe(f.read("moved"));
  expect(
    move.mutations.some(
      (m) => m.path.endsWith("moved") && m.action === "written",
    ),
  ).toBe(true);
});

test("apply_patch reports created directories and completed earlier files on IO failure", async () => {
  const f = fixture();
  const io: PatchIO = {
    ...fs,
    openSync: ((path: any, ...args: any[]) => {
      if (String(path).endsWith("second"))
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      return (fs.openSync as any)(path, ...args);
    }) as typeof fs.openSync,
  };
  const result = await executePatch(
    patch(`${add()}\n${add("nested/second")}`),
    f.dir,
    undefined,
    io,
  );
  expect(result.status).toBe("partial");
  expect(result.changedFiles).toHaveLength(1);
  expect(result.mutations.at(-1)?.action).toBe("created-directory");
});

test("apply_patch serializes its own concurrent calls and never overwrites an add", async () => {
  const f = fixture();
  const results = await Promise.all([
    executePatch(patch(add()), f.dir),
    executePatch(patch(add()), f.dir),
  ]);
  expect(results.map((r) => r.status)).toEqual(["applied", "rejected"]);
});

test("apply_patch bounds patch bytes, file count, input/output and total working set", async () => {
  const f = fixture();
  expect(
    (await executePatch("x".repeat(PATCH_LIMITS.patchBytes + 1), f.dir)).error,
  ).toContain("Patch exceeds");
  expect(
    (
      await executePatch(
        patch(Array.from({ length: 65 }, (_, i) => add(`f${i}`)).join("\n")),
        f.dir,
      )
    ).error,
  ).toContain("64 files");
  f.write("a", "x".repeat(PATCH_LIMITS.fileBytes + 1));
  expect(
    (await executePatch(patch("*** Delete File: a"), f.dir)).error,
  ).toContain("File exceeds");
  f.write("a", "x".repeat(PATCH_LIMITS.fileBytes - 1) + "\n");
  expect(
    (
      await executePatch(
        patch("*** Update File: a\n@@\n+too much\n*** End of File"),
        f.dir,
      )
    ).error,
  ).toContain("Result exceeds");
  const bodies: string[] = [];
  for (let i = 0; i < 9; i++) {
    f.write(`big${i}`, "x".repeat(PATCH_LIMITS.fileBytes));
    bodies.push(`*** Update File: big${i}\n*** Move to: dest${i}`);
  }
  expect((await executePatch(patch(bodies.join("\n")), f.dir)).error).toContain(
    "working set",
  );
});

for (const input of [
  "*** Begin Patch\n*** End Patch\n",
  "prefix\n*** Begin Patch\n*** Add File: a\n+x\n*** End Patch\n",
  "*** Begin Patch\n*** Add File: a\n+x\n*** End Patch\nsuffix",
  "*** Begin Patch\n*** Add File: a\n*** End Patch\n",
  "*** Begin Patch\n*** Add File: a\nx\n*** End Patch\n",
])
  test("apply_patch rejects malformed envelope or add body", async () => {
    const f = fixture();
    const result = await executePatch(input, f.dir);
    expect(result.status).toBe("rejected");
    expect(result.mutations).toEqual([]);
  });

test("apply_patch handles short writes and empty files", async () => {
  const f = fixture();
  f.write("a", "");
  const io: PatchIO = {
    ...fs,
    writeSync: ((
      fd: number,
      data: Buffer,
      offset: number,
      length: number,
      position: number,
    ) =>
      fs.writeSync(
        fd,
        data,
        offset,
        Math.min(length, 2),
        position,
      )) as typeof fs.writeSync,
  };
  expect(
    (
      await executePatch(
        patch("*** Update File: a\n@@\n+hello 🌊"),
        f.dir,
        undefined,
        io,
      )
    ).status,
  ).toBe("applied");
  expect(f.read("a")).toBe("hello 🌊\n");
});

test("apply_patch rejects invalid UTF-8 and special files without blocking", async () => {
  const f = fixture();
  fs.writeFileSync(join(f.dir, "a"), Buffer.from([0xff, 0xfe]));
  expect((await executePatch(patch(update()), f.dir)).error).toContain("UTF-8");
  fs.mkdirSync(join(f.dir, "directory"));
  expect(
    (await executePatch(patch("*** Delete File: directory"), f.dir)).status,
  ).toBe("rejected");
});

test("apply_patch rejects conflicting insertions and handles large repetitive context", async () => {
  const f = fixture();
  f.write("a", "");
  expect(
    (await executePatch(patch("*** Update File: a\n@@\n+x\n@@\n+y"), f.dir))
      .status,
  ).toBe("rejected");
  f.write("a", "x\n".repeat(100_000));
  const context = " x\n".repeat(20_000);
  expect(
    (
      await executePatch(
        patch(`*** Update File: a\n@@\n${context}-absent\n+new`),
        f.dir,
      )
    ).status,
  ).toBe("rejected");
  expect(
    (
      await executePatch(
        patch("*** Update File: a\n@@\n+last\n*** End of File"),
        f.dir,
      )
    ).status,
  ).toBe("applied");
  expect(f.read("a").endsWith("x\nlast\n")).toBe(true);
});

test("apply_patch treats whitespace-only and empty textual anchors as exact context", async () => {
  const f = fixture();
  for (const anchor of ["   ", "\t", ""]) {
    for (const content of ["old\n", `${anchor}\nold\n${anchor}\nend\n`]) {
      f.write("a", content);
      const result = await executePatch(patch(`${add()}\n*** Update File: a\n@@ ${anchor}\n-old\n+new`), f.dir);
      expect(result.status).toBe("rejected");
      expect(result.mutations).toEqual([]);
      expect(f.read("a")).toBe(content);
      expect(fs.existsSync(join(f.dir, "new.txt"))).toBe(false);
    }
    f.write("a", `${anchor}\nold\nend`);
    expect((await executePatch(patch(`*** Update File: a\n@@ ${anchor}\n-old\n+new`), f.dir)).status).toBe("applied");
  }
});

test("apply_patch rejects malformed UTF-16 in bodies and paths before filesystem access", async () => {
  const f = fixture();
  let accesses = 0;
  const io: PatchIO = { ...fs, lstatSync: ((...args: any[]) => {
    accesses++;
    return (fs.lstatSync as any)(...args);
  }) as typeof fs.lstatSync };
  for (const invalid of ["\uD800", "\uDC00", "\uD800x"]) {
    for (const body of [`*** Add File: new\n+${invalid}`, add(invalid), `*** Update File: a\n*** Move to: ${invalid}`, `*** Update File: a\n@@ ${invalid}\n-old\n+new`]) {
      const result = await executePatch(patch(body), f.dir, undefined, io);
      expect(result.error).toContain("Unicode");
      expect(result.status).toBe("rejected");
      expect(result.mutations).toEqual([]);
    }
  }
  expect(accesses).toBe(0);
  expect(fs.readdirSync(f.dir)).toEqual([]);
});

for (const kind of ["anchors", "hunks"])
  test(`apply_patch bounds adversarial many-${kind} preflight before writes`, async () => {
    const f = fixture();
    const lines = Array.from({ length: 50_000 }, (_, i) => `L${String(i).padStart(5, "0")}`);
    const content = lines.join("\n") + "\nold\n";
    f.write("a", content);
    const body = kind === "anchors"
      ? lines.map(line => `@@ ${line}`).join("\n") + "\n-old\n+new"
      : lines.slice(0, 20_000).map(line => `@@\n-${line}\n+new`).join("\n");
    const result = await executePatch(patch(`${add()}\n*** Update File: a\n${body}`), f.dir);
    expect(result.error).toContain("work budget");
    expect(result.status).toBe("rejected");
    expect(result.mutations).toEqual([]);
    expect(f.read("a")).toBe(content);
    expect(fs.existsSync(join(f.dir, "new.txt"))).toBe(false);
  });

test("apply_patch shares comparison work budget across files", async () => {
  const f = fixture();
  const lines = Array.from({ length: 50_000 }, (_, i) => `L${String(i).padStart(5, "0")}`);
  const content = lines.join("\n") + "\nold\n";
  const diff = lines.slice(0, 12).map(line => `@@ ${line}`).join("\n") + "\n-old\n+new";
  f.write("a", content);
  f.write("b", content);
  const result = await executePatch(patch(`*** Update File: a\n${diff}\n*** Update File: b\n${diff}`), f.dir);
  expect(result.error).toContain("work budget");
  expect(result.mutations).toEqual([]);
  expect(f.read("a")).toBe(content);
  expect(f.read("b")).toBe(content);
});
