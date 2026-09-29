import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { createServer } from "vite";
import { privateDevFiles } from "../scripts/dev-files";

test("dev HTTP only serves frontend assets, including encoded, raw and symlink paths", async () => {
  const root = mkdtempSync(join(tmpdir(), ".jelly-dev-files-"));
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const marker = "SYNTHETIC-PRIVATE-DATA-MUST-NOT-BE-SERVED";
  for (const file of [
    ".jelly/auth.json",
    ".jelly/jelly.sqlite",
    ".env.local",
    ".git/config",
    "Screenshot.png",
    "src/server/private.ts",
    "src/client/.env.local",
    "src/shared/custom-auth.json",
    "src/client/custom-data/secret.json",
  ])
    write(file, marker);
  write(
    "index.html",
    '<script type="module" src="/src/client/main.ts"></script>',
  );
  write("src/client/main.ts", 'export const publicValue = "frontend";');
  write("src/shared/public.ts", 'export const sharedValue = "shared";');
  write("public/brand/icon.svg", "<svg></svg>");
  write("node_modules/.vite/probe.js", "export default 1;");
  symlinkSync(join(root, ".jelly/auth.json"), join(root, "public/leak.json"));
  symlinkSync(
    join(root, "src/client/.env.local"),
    join(root, "src/client/leak.txt"),
  );
  // Vite treats port 0 as its default; allocate a free loopback port explicitly.
  const allocation = createNetServer();
  await new Promise<void>((r) => allocation.listen(0, "127.0.0.1", r));
  const port = (allocation.address() as { port: number }).port;
  await new Promise<void>((r) => allocation.close(() => r()));
  const priorAuth = process.env.JELLY_AUTH_FILE,
    priorData = process.env.JELLY_DATA_DIR;
  process.env.JELLY_AUTH_FILE = join(root, "src/shared/custom-auth.json");
  process.env.JELLY_DATA_DIR = join(root, "src/client/custom-data");
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    server = await createServer({
      configFile: false,
      root,
      plugins: [privateDevFiles()],
      server: { host: "127.0.0.1", port, strictPort: true, cors: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await server.listen();
    // A configured credential file can be created/repointed after dev startup.
    rmSync(join(root, "src/shared/custom-auth.json"));
    write("src/shared/aliased-private.json", marker);
    symlinkSync(
      join(root, "src/shared/aliased-private.json"),
      join(root, "src/shared/custom-auth.json"),
    );
    for (const path of [
      "/.jelly/auth.json",
      "/.jelly/jelly.sqlite",
      "/%2ejelly/auth.json",
      "/.env.local",
      "/.git/config",
      "/Screenshot.png",
      "/src/server/private.ts?raw",
      "/src/shared/custom-auth.json?import",
      "/src/shared/aliased-private.json",
      "/src/client/custom-data/secret.json",
      "/leak.json",
      "/src/client/leak.txt",
      "/@fs" + join(root, ".jelly/auth.json"),
      "/@fs" + join(root, "src/server/private.ts"),
      "/@fs/etc/passwd",
      "/src/client/%2e%2e/server/private.ts?raw",
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(response.status, path).toBe(403);
      expect(await response.text(), path).not.toContain(marker);
    }
    for (const path of [
      "/",
      "/index.html",
      "/src/client/main.ts",
      "/src/shared/public.ts",
      "/brand/icon.svg",
      "/@vite/client",
      "/node_modules/.vite/probe.js",
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { Origin: "http://localhost:43210" },
      });
      expect(response.status, path).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  } finally {
    await server?.close();
    if (priorAuth === undefined) delete process.env.JELLY_AUTH_FILE;
    else process.env.JELLY_AUTH_FILE = priorAuth;
    if (priorData === undefined) delete process.env.JELLY_DATA_DIR;
    else process.env.JELLY_DATA_DIR = priorData;
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
