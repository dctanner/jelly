import { useTestModel } from "./fixtures/app";
import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  statSync,
  symlinkSync,
  readdirSync,
  truncateSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startApp } from "../src/server/app";
import { RenderedFiles, renderFileTool } from "../src/server/rendered-files";
import { wavFixture, mp4Header } from "./fixtures/media";

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
  useTestModel(h);
  const session = await h.create(
    agent,
    [],
    h.config("api"),
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

test("HTML inline responses are private and sandboxed while downloads and other text stay inert", async () => {
  const f = await fixture();
  const html = '<style>h1 {color: red}</style><h1>Preview</h1><script>parent.stolen=true</script>';
  for (const name of ["page.html", "page.HTM"]) {
    const path = join(f.dir, name);
    writeFileSync(path, html);
    const file = await f.app.service.harness.files.save(path, f.dir);
    expect((await f.get(file.url + "?inline=1", {} as any)).status).toBe(401);
    const response = await f.get(file.url + "?inline=1");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-disposition")).toStartWith("inline;");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const policy = response.headers.get("content-security-policy")!;
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("style-src 'unsafe-inline'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("frame-ancestors 'self'");
    expect(policy).toContain("sandbox");
    expect(policy).toContain("sandbox allow-scripts");
    expect(policy).toContain("script-src 'unsafe-inline'");
    expect(policy).not.toContain("allow-same-origin");
    expect(await response.text()).toBe(html);
    const download = await f.get(file.url);
    expect(download.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(download.headers.get("content-disposition")).toStartWith("attachment;");
  }
  const path = join(f.dir, "source.txt");
  writeFileSync(path, html);
  const file = await f.app.service.harness.files.save(path, f.dir);
  const response = await f.get(file.url + "?inline=1");
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("content-disposition")).toStartWith("attachment;");
});

test("rendered audio/video uses private validated metadata, byte ranges, HEAD and downloads", async () => {
  const f = await fixture();
  const bytes = wavFixture();
  const source = join(f.dir, "sound.wav");
  writeFileSync(source, bytes);
  let event: any;
  const tool = renderFileTool(f.app.service.harness.files, f.dir, (_type, data) => { event = data; });
  const result = await tool.execute("audio", { path: source }, undefined, undefined, {} as never);
  const file = event.files[0];
  expect(file.kind).toBe("audio");
  expect(file.mimeType).toBe("audio/wav");
  expect(JSON.stringify(result)).not.toContain(bytes.toString("base64"));
  expect((await f.get(file.url, {} as any)).status).toBe(401);
  const full = await f.get(file.url);
  expect(full.headers.get("accept-ranges")).toBe("bytes");
  expect(full.headers.get("content-type")).toBe("audio/wav");
  expect(full.headers.get("cache-control")).toBe("private, no-store");
  expect(full.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
  for (const [range, start, end] of [["bytes=0-1", 0, 1], ["bytes=44-", 44, bytes.length - 1], ["bytes=-12", bytes.length - 12, bytes.length - 1], ["bytes=1-999999", 1, bytes.length - 1]] as const) {
    const response = await f.get(file.url, { cookie: f.cookie, range } as any);
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${bytes.length}`);
    expect(response.headers.get("content-length")).toBe(String(end - start + 1));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1));
  }
  for (const range of ["bytes=999999-", "bytes=20-10", "bytes=-0"]) {
    const response = await f.get(file.url, { cookie: f.cookie, range } as any);
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  }
  expect((await f.get(file.url, { cookie: f.cookie, range: "bytes=0-1,4-5" } as any)).status).toBe(200);
  expect((await f.get(file.url, { cookie: f.cookie, range: "bytes=0-1", "if-range": "old" } as any)).status).toBe(200);
  const head = await fetch(new URL(file.url, f.app.server.url), { method: "HEAD", headers: { cookie: f.cookie, range: "bytes=0-1" } });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String(bytes.length));
  expect((await head.arrayBuffer()).byteLength).toBe(0);
  expect((await f.get(file.url + "?download=1")).headers.get("content-disposition")).toStartWith("attachment;");
  const freshFiles = new RenderedFiles(f.dir);
  expect((await freshFiles.read(file.url))?.bytes).toEqual(bytes);
  for (const [name, kind, mime] of [["video.mp4", "video", "video/mp4"], ["audio.m4a", "audio", "audio/mp4"]] as const) {
    const path = join(f.dir, name!); writeFileSync(path, mp4Header());
    const saved = await freshFiles.save(path, f.dir);
    expect(saved.kind).toBe(kind); expect(saved.mimeType).toBe(mime);
    expect((await freshFiles.read(saved.url))?.metadata).toEqual(saved);
  }
});

test("media signatures, limits and metadata are checked before playback", async () => {
  const f = await fixture(); const files = f.app.service.harness.files;
  const source = join(f.dir, "fake.mp4");
  writeFileSync(source, "<script>alert(1)</script>");
  await expect(files.save(source, f.dir)).rejects.toThrow("Unsupported");
  writeFileSync(source, mp4Header()); truncateSync(source, 100 * 1024 * 1024 + 1);
  await expect(files.save(source, f.dir)).rejects.toThrow("100 MiB");
  writeFileSync(source, mp4Header());
  const saved = await files.save(source, f.dir);
  writeFileSync(join(files.directory, `${saved.id}.json`), JSON.stringify({ ...saved, mimeType: "text/html" }));
  expect(await files.read(saved.url)).toBeNull();
  writeFileSync(join(files.directory, `${saved.id}.json`), JSON.stringify(saved));
  writeFileSync(join(files.directory, `${saved.id}.bin`), Buffer.alloc(saved.size));
  expect(await files.read(saved.url)).toBeNull();
  const { mediaType } = await import("../src/server/media-files");
  expect(mediaType(Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00"), "sound.mp3")?.mimeType).toBe("audio/mpeg");
  expect(mediaType(Buffer.from([0xff, 0xfb, 0x90, 0]), "sound.mp3")?.kind).toBe("audio");
  expect(mediaType(Buffer.from("fLaC"), "sound.flac")?.kind).toBe("audio");
  expect(mediaType(Buffer.from("OggS\0OpusHead"), "sound.opus")?.kind).toBe("audio");
  expect(mediaType(Buffer.from("OggS\0theora"), "video.ogv")?.kind).toBe("video");
  expect(mediaType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Buffer.from("webm")]), "video.webm")?.kind).toBe("video");
  expect(mediaType(Buffer.from("unrelated bytes"), "sound.wav")).toBeNull();
});
