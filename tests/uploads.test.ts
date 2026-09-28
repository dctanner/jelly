import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startApp } from "../src/server/app";
import { uploadFile } from "../src/server/uploads";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-uploads-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startApp({ dataDir: join(dir, "state"), configDir: join(dir, "config"), port: 0 });
  cleanups.push(() => app.close());
  const base = `http://127.0.0.1:${app.server.port}`;
  const session = await fetch(base + "/api/control-session");
  const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  const { csrf } = (await session.json()) as { csrf: string };
  const headers = {
    cookie,
    "x-jelly-csrf": csrf,
    "Content-Type": "application/octet-stream",
  };
  const agent = app.store.agents()[0]!;
  const url = (directory: string, name: string) =>
    `${base}/api/agents/${agent.id}/uploads?${new URLSearchParams({ directory, name })}`;
  const upload = (directory: string, name: string, body: BodyInit = "") =>
    fetch(url(directory, name), { method: "POST", headers, body });
  return { dir, app, base, agent, headers, url, upload };
}

test("uploads arbitrary binary and empty files to host folders and initializes the managed workspace", async () => {
  const { dir, agent, upload } = await fixture();
  const destination = join(dir, "outside workspace");
  mkdirSync(destination);
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const response = await upload(destination, "résumé #1.bin", bytes);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ name: "résumé #1.bin" });
  expect(readFileSync(join(destination, "résumé #1.bin"))).toEqual(bytes);
  expect((await upload(agent.cwd, "empty")).status).toBe(201);
  expect(readFileSync(join(agent.cwd, "empty")).length).toBe(0);
  expect(readdirSync(destination)).toEqual(["résumé #1.bin"]);
});

test("uploads enforce control protections, validate paths, and never overwrite files or symlinks", async () => {
  const { dir, headers, url, upload, base } = await fixture();
  const destination = join(dir, "files");
  mkdirSync(destination);
  writeFileSync(join(destination, "existing"), "keep");
  symlinkSync(join(destination, "existing"), join(destination, "alias"));
  for (const name of ["existing", "alias"])
    expect((await upload(destination, name, "replace")).status).toBe(409);
  expect(readFileSync(join(destination, "existing"), "utf8")).toBe("keep");
  for (const name of [
    "",
    ".",
    "..",
    "../escape",
    "folder/file",
    "folder\\file",
    "null\0byte",
  ])
    expect((await upload(destination, name, "bad")).status).toBe(400);
  for (const path of [
    "relative",
    join(dir, "missing"),
    join(destination, "existing"),
  ])
    expect((await upload(path, "file", "bad")).status).toBe(400);
  for (const [extra, status] of [
    [{ cookie: "" }, 401],
    [{ "x-jelly-csrf": "wrong" }, 403],
    [{ origin: "https://example.com" }, 403],
    [{ "sec-fetch-site": "cross-site" }, 403],
    [{ "x-jelly-managed-browser": "1" }, 403],
  ] as const) {
    const response = await fetch(url(destination, "forbidden"), {
      method: "POST",
      headers: { ...headers, ...extra },
      body: "bad",
    });
    expect(response.status).toBe(status);
  }
  expect(readdirSync(destination).sort()).toEqual(["alias", "existing"]);
  const oversized = await fetch(base + "/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "x".repeat(65000) }),
  });
  expect(oversized.status).toBe(413);
});

test("interrupted streams remove temporary data and never publish a partial file", async () => {
  const { dir } = await fixture();
  const destination = join(dir, "files");
  mkdirSync(destination);
  let reads = 0;
  const req = new Request("http://localhost/upload", {
    method: "POST",
    body: new ReadableStream({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
        else controller.error(new Error("connection lost"));
      },
    }),
  });
  await expect(uploadFile(req, destination, "partial")).rejects.toThrow(
    "connection lost",
  );
  expect(readdirSync(destination)).toEqual([]);
});

test("concurrent uploads of the same name publish exactly one complete file", async () => {
  const { dir, upload } = await fixture();
  const responses = await Promise.all([
    upload(dir, "same", "one"),
    upload(dir, "same", "two"),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    201, 409,
  ]);
  expect(["one", "two"]).toContain(readFileSync(join(dir, "same"), "utf8"));
  expect(
    readdirSync(dir).filter((name) => name.startsWith(".jelly-upload-")),
  ).toEqual([]);
});
