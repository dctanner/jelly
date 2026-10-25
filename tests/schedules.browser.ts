import { chromium } from "playwright-core";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureBrowserPath } from "./fixtures/browser";

// Isolate both Pi authority and build output. Never overwrite the live dist or use
// the operator's browser profile, database, schedules or model credentials.
const dir = mkdtempSync(join(tmpdir(), "jelly-schedule-browser-"));
for (const key of Object.keys(process.env))
  if (key.startsWith("PI_")) delete process.env[key];
process.env.PI_CODING_AGENT_DIR = join(dir, "pi");
const { startApp } = await import("./fixtures/app");
let app: Awaited<ReturnType<typeof startApp>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const build = Bun.spawn(
    [
      process.execPath,
      "node_modules/vite/bin/vite.js",
      "build",
      "--outDir",
      join(dir, "client"),
      "--emptyOutDir",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, output, error] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(`Isolated frontend build failed: ${output}\n${error}`);
  app = await startApp({
    dataDir: join(dir, "data"),
    configDir: join(dir, "config"),
    authPath: join(dir, "auth.json"),
    port: 0,
    staticDir: join(dir, "client"),
  });
  browser = await chromium.launch({
    executablePath: fixtureBrowserPath(),
    headless: true,
  });
  for (const [width, height] of [
    [320, 740],
    [390, 844],
    [1280, 900],
  ]) {
    const agent = app.service.createAgent({
      name: `Schedule fixture ${width}`,
      instructions: "Fixture only",
      color: "#a4c8e8",
    });
    const receipt = app.service.schedules.create(agent.id, {
      title: "Weekday review",
      prompt: "Preserve this exact task",
      kind: "cron",
      cron: "30 8 * * 1-5",
      timezone: "Europe/London",
      requestId: `browser-${width}`,
    });
    const page = await browser.newPage({
      viewport: { width: width!, height: height! },
      reducedMotion: "reduce",
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `${app.server.url.origin}/agents/${agent.id}?schedule=${receipt.schedule.id}`,
    );
    await page
      .getByRole("heading", { name: "Schedules", exact: true })
      .waitFor();
    const edit = page.getByRole("button", { name: "Edit", exact: true });
    await edit.press("Enter");
    const prompt = page.getByRole("textbox", {
      name: "Stored task",
      exact: true,
    });
    await prompt.fill(`Verbatim\n${"long-input-".repeat(100)}`);
    await page.getByRole("button", { name: "Preview times" }).click();
    await page.getByRole("list", { name: "Upcoming times" }).waitFor();
    const fits = await page
      .locator(".schedules-panel")
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
    if (!fits) throw new Error(`Schedule editor overflows at ${width}px`);
    if (width! < 768) {
      const font = await prompt.evaluate((element) =>
        parseFloat(getComputedStyle(element).fontSize),
      );
      if (font < 16) throw new Error(`Mobile input text is ${font}px`);
    }
    await page.getByRole("button", { name: "Save schedule" }).click();
    const pause = page.getByRole("button", { name: "Pause", exact: true });
    await pause.waitFor();
    const box = await pause.boundingBox();
    if (!box || box.height < 44)
      throw new Error(`Pause target is shorter than 44px at ${width}px`);
    await pause.press("Enter");
    await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
    if (
      app.service.schedules.get(agent.id, receipt.schedule.id).state !==
      "paused"
    )
      throw new Error("Pause did not persist");
    await page
      .getByRole("button", { name: "Cancel schedule", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Cancel schedule", exact: true })
      .waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: "Agent options", exact: true })
      .click();
    await page
      .getByRole("button", { name: /Schedules \(0 active\)/ })
      .waitFor();
    if (app.store.runs(agent.id).length)
      throw new Error("Managing schedules executed the task at creation");
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(
      `Schedules browser: ${width}×${height}, deep link, keyboard edit/preview/pause/cancel, 44px controls, no overflow; no model run.`,
    );
    await page.close();
  }
} finally {
  await browser?.close();
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
}
