/** Isolated, disposable UI review server. Never opens the user's .jelly database. */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startApp } from "../tests/fixtures/app";
const dir = mkdtempSync(join(tmpdir(), "jelly-design-review-"));
const workingPreview = process.argv.includes("--working");
const app = await startApp({
  dataDir: join(dir, "state"),
  configDir: join(dir, "config"),
  port: 0,
  staticDir: resolve("dist"),
  fixtureDelayMs: workingPreview ? 120_000 : 400,
});
app.service.setMode("api");
const website = join(dir, "website");
mkdirSync(website);
mkdirSync(join(website, "src"));
mkdirSync(join(website, "docs"));
const p = app.service.saveProject(null, {
  name: "Website",
  defaultCwd: website,
});
const personal = app.service.saveProject(null, {
  name: "Personal",
  defaultCwd: dir,
});
app.service.saveProject(null, { name: "Research", defaultCwd: dir });
const original = app.store.agents()[0]!;
app.service.archiveAgent(original.id, true);
const milo = app.service.createAgent({
  name: "Milo",

  instructions: "Be thoughtful and practical.",
  color: "#a4c8e8",
  avatarId: "octopus",
  projectId: p.id,
});
app.service.createAgent({
  name: "Pearl",

  instructions: "",
  color: "#a4c8e8",
  avatarId: "sea-turtle",
  projectId: p.id,
});
app.service.createAgent({
  name: "Fin",

  instructions: "",
  color: "#a4c8e8",
  avatarId: "whale",
  projectId: personal.id,
});
app.service.createAgent({
  name: "Pip",

  instructions: "",
  color: "#a4c8e8",
  avatarId: "crab",
});
const run = app.store.createRun(
  milo.id,
  "design-reference",
  "Homepage refresh",
  "api",
  "gpt-6-astra",
);
app.store.event(milo.id, run.id, "message", {
  role: "user",
  text: "Let’s give the homepage a little more personality. Something warm, clear, and unmistakably us.",
});
app.store.event(milo.id, run.id, "message", {
  role: "assistant",
  text: "## A warmer welcome.\n\nI gave the homepage a softer palette and a little more breathing room. The important things still come first.\n\n- A clearer introduction, with one easy next step.\n- Friendly details that feel at home with your brand.\n- A layout that works just as well on a small screen.\n\nReady for a look?",
});
app.store.finishRun(run.id, "completed", null);
app.store.event(milo.id, run.id, "run_completed", { status: "completed" });
if (workingPreview)
  app.service.start(milo.id, crypto.randomUUID(), "Let’s refine those details.");
console.log("Disposable Jelly design review: " + app.server.url.origin);
async function close() {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
