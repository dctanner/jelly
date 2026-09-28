import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  statSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startApp } from "../src/server/app";
import { RenderedFiles, renderFileTool } from "../src/server/rendered-files";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7L8AAAAASUVORK5CYII=";
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-render-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
  });
  cleanups.push(() => app.close());
  const control = await fetch(new URL("/api/control-session", app.server.url));
  const cookie = control.headers.get("set-cookie")!.split(";")[0]!;
  const get = (path: string, headers = { cookie }) =>
    fetch(new URL(path, app.server.url), { headers });
  return { dir, app, get, cookie };
}

test("render_file is registered and shows an image with metadata only, no prior read", async () => {
  const f = await fixture();
  const agent = f.app.store.agents()[0]!;
  mkdirSync(agent.cwd, { recursive: true });
  writeFileSync(join(agent.cwd, "ad.png"), Buffer.from(PNG, "base64"));
  const h = f.app.service.harness;
  const session = await h.create(
    agent,
    [],
    h.config("demo"),
    f.app.store.instance(),
    [],
    (type, data) => {
      f.app.service.emit(agent.id, null, type, data);
    },
  );
  try {
    expect(session.getActiveToolNames()).toContain("render_file");
    const tool = session.agent.state.tools.find(
      (tool) => tool.name === "render_file",
    )!;
    const result = await tool.execute(
      "show-ad",
      { path: "ad.png" },
      new AbortController().signal,
    );
    expect(JSON.stringify(result)).not.toContain(PNG);
    const event = f.app.store
      .historyPage(agent.id)
      .events.find((event) => event.type === "file_rendered")!;
    const file = (event.data.files as any[])[0];
    expect(file).toMatchObject({
      name: "ad.png",
      kind: "image",
      mimeType: "image/png",
    });
    expect((await f.get(file.url, { cookie: "" })).status).toBe(401);
    const response = await f.get(file.url);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(
      PNG,
    );
    const denied = await fetch(new URL(file.url, f.app.server.url), {
      headers: { cookie: f.cookie, origin: "https://evil.example" },
    });
    expect(denied.status).toBe(403);
    expect(
      statSync(join(f.dir, "rendered-files", `${file.id}.bin`)).mode & 0o777,
    ).toBe(0o600);
    expect(statSync(join(f.dir, "rendered-files")).mode & 0o777).toBe(0o700);
    writeFileSync(join(agent.cwd, "ad.png"), "changed");
    expect(
      (await new RenderedFiles(f.dir).read(file.url))!.bytes.toString("base64"),
    ).toBe(PNG);
  } finally {
    await h.dispose(session);
  }
});

test("text is an inert, bounded, on-demand preview with full download and no model contents", async () => {
  const f = await fixture();
  const source = join(f.dir, "notes.html");
  const text =
    '<script>alert("private-file-content")</script>\n' +
    "Hello café\n".repeat(300);
  writeFileSync(source, text);
  let metadata: any;
  const tool = renderFileTool(
    f.app.service.harness.files,
    f.dir,
    (_type, data) => {
      metadata = (data.files as any[])[0];
    },
  );
  const result = await tool.execute(
    "render-text",
    { path: source },
    undefined,
    undefined,
    {} as never,
  );
  expect(JSON.stringify(result)).not.toContain("private-file-content");
  expect(JSON.stringify(result)).not.toContain("Hello café");
  expect(metadata.kind).toBe("text");
  const preview = await (await f.get(metadata.url + "?preview=1")).json();
  expect(preview.truncated).toBe(true);
  expect(preview.text.split("\n")).toHaveLength(200);
  expect(preview.text).toContain(
    '<script>alert("private-file-content")</script>',
  );
  const response = await f.get(metadata.url);
  expect(response.headers.get("content-type")).toBe(
    "text/plain; charset=utf-8",
  );
  expect(response.headers.get("content-disposition")).toContain("attachment");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(await response.text()).toBe(text);
});

test("rendered attachments survive service restart", async () => {
  const f = await fixture();
  const source = join(f.dir, "note.md");
  writeFileSync(source, "# Persisted note");
  const saved = await f.app.service.harness.files.save(source, f.dir);
  const agent = f.app.store.agents()[0]!;
  f.app.service.emit(agent.id, null, "file_rendered", { files: [saved] });
  await f.app.close();
  const next = await startApp({
    dataDir: f.dir,
    configDir: join(f.dir, "config"),
    port: 0,
  });
  cleanups.push(() => next.close());
  expect(
    next.store
      .historyPage(agent.id)
      .events.some((event) => event.type === "file_rendered"),
  ).toBe(true);
  expect(
    (await next.service.harness.files.read(saved.url))!.bytes.toString(),
  ).toBe("# Persisted note");
});

test("render_file rejects unsafe/binary/oversized inputs and cleans up failed or cancelled attachments", async () => {
  const f = await fixture();
  const files = f.app.service.harness.files;
  const source = join(f.dir, "source");
  await expect(files.save(join(f.dir, "missing"), f.dir)).rejects.toThrow();
  await expect(files.save(f.dir, f.dir)).rejects.toThrow("regular");
  writeFileSync(source, Buffer.from([0, 255, 1, 2]));
  await expect(files.save(source, f.dir)).rejects.toThrow();
  writeFileSync(source, "x".repeat(2 * 1024 * 1024 + 1));
  await expect(files.save(source, f.dir)).rejects.toThrow("2 MiB");
  writeFileSync(source, Buffer.alloc(20 * 1024 * 1024 + 1));
  await expect(files.save(source, f.dir)).rejects.toThrow("too large");
  writeFileSync(source, "plain text");
  const controller = new AbortController();
  controller.abort();
  await expect(files.save(source, f.dir, controller.signal)).rejects.toThrow();
  const tool = renderFileTool(files, f.dir, () => {
    throw new Error("report failed");
  });
  await expect(
    tool.execute(
      "bad-report",
      { path: source },
      undefined,
      undefined,
      {} as never,
    ),
  ).rejects.toThrow("report failed");
  expect(readdirSync(files.directory)).toHaveLength(0);
  const svg = join(f.dir, "image.svg");
  writeFileSync(svg, '<svg onload="alert(1)"></svg>');
  expect((await files.save(svg, f.dir)).kind).toBe("text");
  const saved = await files.save(source, f.dir);
  const stored = join(files.directory, `${saved.id}.bin`);
  rmSync(stored);
  symlinkSync(source, stored);
  expect(await files.read(saved.url)).toBeNull();
  expect(await files.read("/api/rendered-files/../../auth.json")).toBeNull();
  expect((await f.get("/api/rendered-files/invalid")).status).toBe(404);
});
