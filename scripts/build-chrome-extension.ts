import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const outdir = resolve(process.argv[2] ?? "dist/chrome-extension");
await mkdir(outdir, { recursive: true });
const result = await Bun.build({
  entrypoints: ["extensions/chrome/worker.js", "extensions/chrome/popup.js"],
  outdir,
  target: "browser",
  format: "esm",
  minify: false,

});
if (!result.success) throw new Error(result.logs.join("\n"));
const manifest = JSON.parse(
  await readFile("extensions/chrome/manifest.json", "utf8"),
);
await writeFile(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2));
await copyFile("extensions/chrome/popup.html", `${outdir}/popup.html`);
console.log(`Unpacked experimental extension: ${outdir}`);
