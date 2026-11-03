import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Desktop } from "../src/server/desktop";
import { startApp } from "./fixtures/app";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-desktop-"));
  dirs.push(dir);
  return dir;
}
function png() {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
/** A fake peekaboo CLI: prints version/permissions and echoes a screenshot path. */
function fakeCli(dir: string) {
  const image = join(dir, "shot.png");
  writeFileSync(image, png());
  const cli = join(dir, "peekaboo");
  writeFileSync(
    cli,
    `#!/bin/sh
case "$1" in
  --version) echo "Peekaboo 4.9.7 (test)";;
  permissions) echo '{"success":true,"data":{"permissions":[{"name":"Accessibility","isGranted":true},{"name":"Screen Recording","isGranted":false,"grantInstructions":"System Settings"}]}}';;
  see) echo '{"success":true,"data":{"screenshot_raw":"${image}"}}';;
  fail) echo "boom" >&2; exit 3;;
  *) echo "args:$*";;
esac
`,
  );
  chmodSync(cli, 0o755);
  return cli;
}

test("starts disabled with no tools and persists the single on/off switch", async () => {
  const dir = temp();
  const cli = fakeCli(dir);
  const desktop = new Desktop(dir, { platform: "darwin", cliPath: cli });
  expect(desktop.tools()).toEqual([]);
  expect((await desktop.status()).enabled).toBe(false);
  await expect(desktop.configure({ enabled: "yes" })).rejects.toThrow();
  const status = await desktop.configure({ enabled: true });
  expect(status).toMatchObject({
    enabled: true,
    installed: true,
    version: "4.9.7",
    permissions: [
      { name: "Accessibility", granted: true },
      { name: "Screen Recording", granted: false },
    ],
  });
  const restored = new Desktop(dir, { platform: "darwin", cliPath: cli });
  expect((await restored.status()).enabled).toBe(true);
  expect(restored.tools().map((tool) => tool.name)).toEqual(["peekaboo"]);
});

test("missing CLI or non-Mac platform exposes no tools", async () => {
  const dir = temp();
  writeFileSync(join(dir, "desktop.json"), JSON.stringify({ enabled: true }));
  const missing = new Desktop(dir, { platform: "darwin", cliPath: null });
  expect(missing.tools()).toEqual([]);
  expect((await missing.status()).installed).toBe(false);
  const linux = new Desktop(dir, { platform: "linux", cliPath: fakeCli(dir) });
  expect(linux.tools()).toEqual([]);
  expect((await linux.status()).platformSupported).toBe(false);
});

test("peekaboo tool passes any arguments and attaches screenshots", async () => {
  const dir = temp();
  const desktop = new Desktop(dir, { platform: "darwin", cliPath: fakeCli(dir) });
  await desktop.configure({ enabled: true });
  const tool = desktop.tools()[0]!;
  const call = (args: string[]) =>
    tool.execute("id", { args } as never, undefined, undefined, {} as never);
  const plain = await call(["click", "--on", "B1"]);
  expect(plain.content).toEqual([{ type: "text", text: "args:click --on B1\n" }]);
  const shot = await call(["see", "--json"]);
  expect(shot.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  await expect(call(["fail"])).rejects.toThrow("boom");
});

test("desktop API reads status and toggles the switch", async () => {
  const dir = temp();
  const app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
  try {
    const origin = app.server.url.origin;
    const bootstrap = await fetch(`${origin}/api/control-session`);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const { csrf } = (await bootstrap.json()) as { csrf: string };
    const headers = { cookie, "x-jelly-csrf": csrf, "content-type": "application/json" };
    expect((await fetch(`${origin}/api/desktop`)).status).toBe(401);
    const status = await (await fetch(`${origin}/api/desktop`, { headers })).json();
    expect(status).toMatchObject({ enabled: false, installed: false });
    const next = await fetch(`${origin}/api/desktop/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    expect(next.status).toBe(200);
    expect((await next.json()).enabled).toBe(true);
  } finally {
    await app.close();
  }
});
