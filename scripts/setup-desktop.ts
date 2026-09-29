import { mkdirSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
if (process.platform !== "linux")
  throw new Error("The managed desktop currently requires Linux.");
const root = resolve(process.env.JELLY_DATA_DIR ?? ".jelly", "runtime"),
  downloads = join(root, "downloads");
mkdirSync(downloads, { recursive: true, mode: 0o700 });
const xtLibrary = Bun.spawnSync(["apt-cache", "show", "libxt6t64"], {
  stdout: "ignore", stderr: "ignore",
}).exitCode === 0 ? "libxt6t64" : "libxt6";
const result = Bun.spawnSync(
  [
    "apt-get",
    "download",
    "xvfb",
    "x11vnc",
    "libxfont2",
    "libvncclient1",
    "libvncserver1",
    "xauth",
    "xclip",
    "libxmu6",
    xtLibrary,
    "libice6",
    "libsm6",
    "x11-xkb-utils",
  ],
  { cwd: downloads, stdout: "inherit", stderr: "inherit" },
);
if (result.exitCode)
  throw new Error(
    "Package download failed. This installer supports Debian/Ubuntu; install Xvfb and x11vnc with your distribution package manager otherwise.",
  );
for (const file of readdirSync(downloads).filter((f) => f.endsWith(".deb"))) {
  const r = Bun.spawnSync(["dpkg-deb", "-x", join(downloads, file), root], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (r.exitCode) throw new Error("Package extraction failed.");
}
console.log(
  "Desktop runtime installed locally. A sandbox-capable Google Chrome or Chromium is also required.",
);
