import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startApp } from "./fixtures/app";

const dir = mkdtempSync(join(tmpdir(), "jelly-agent-inbox-"));
const app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
const selected = app.store.agents()[0]!;
const other = app.service.createAgent({ name: "Archive this agent", instructions: "Test", color: "#abc" });
const working = app.service.createAgent({ name: "Working agent", instructions: "Test", color: "#abc" });
app.store.setStatus(working.id, "running");
const project = app.service.saveProject(null, { name: "Design team", defaultCwd: dir });
const member = app.service.createAgent({ name: "Project agent", instructions: "Test", color: "#abc", projectId: project.id });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  headless: true,
});
mkdirSync("output/agent-inbox", { recursive: true });

try {
  for (const width of [768, 1024, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(app.server.url.origin);
    const row = page.getByTitle(`${other.name} · idle`, { exact: true });
    const archive = page.getByRole("button", { name: `Archive ${other.name}`, exact: true });
    await row.waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".agent-create-fab")?.disabled);
    assert.equal(await archive.evaluate((element) => getComputedStyle(element).opacity), "0");
    await row.hover();
    await page.waitForFunction((name) => {
      const button = document.querySelector(`[aria-label="${name}"]`)!;
      return getComputedStyle(button).opacity === "1";
    }, `Archive ${other.name}`);
    const buttonBounds = (await archive.boundingBox())!;
    const rowBounds = (await row.boundingBox())!;
    assert.equal(buttonBounds.width, 32);
    assert.ok(buttonBounds.x + buttonBounds.width <= rowBounds.x + rowBounds.width);
    assert.ok((await row.locator(".agent-row-copy").boundingBox())!.x < buttonBounds.x);
    assert.equal(await row.locator("button").count(), 0, "Archive must not be nested inside the navigation button");
    await page.mouse.move(width - 10, 890);
    await row.focus();
    await page.keyboard.press("Tab");
    assert.equal(await archive.evaluate((element) => element === document.activeElement), true);
    assert.equal(await archive.evaluate((element) => getComputedStyle(element).pointerEvents), "auto");
    const workingArchive = page.getByRole("button", { name: `Archive ${working.name}`, exact: true });
    assert.equal(await workingArchive.isDisabled(), true);
    if (width === 1024) {
      await row.hover();
      await page.screenshot({ path: "output/agent-inbox/desktop-hover.png" });
    }
    if (width === 1280) {
      await page.getByTitle(`${selected.name} · idle`, { exact: true }).click();
      const draft = page.getByRole("textbox", { name: `Message ${selected.name}`, exact: true });
      await draft.fill("Keep the selected conversation");
      await row.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await row.waitFor({ state: "detached" });
      assert.equal(await draft.inputValue(), "Keep the selected conversation");
      assert.ok(app.store.agent(other.id)?.archivedAt);
      await page.getByRole("button", { name: `Open project ${project.name}`, exact: true }).click();
      const memberArchive = page.getByRole("button", { name: `Archive ${member.name}`, exact: true });
      await page.getByTitle(`${member.name} · idle`, { exact: true }).hover();
      await memberArchive.click();
      await memberArchive.waitFor({ state: "detached" });
      assert.ok(app.store.agent(member.id)?.archivedAt);
    }
    await page.close();
  }
  for (const width of [375, 767]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(app.server.url.origin);
    const row = page.getByTitle(`${selected.name} · idle`, { exact: true });
    await row.waitFor();
    const archive = page.locator(`.agent-row-archive[aria-label="Archive ${selected.name}"]`);
    assert.equal(await archive.evaluate((element) => getComputedStyle(element).display), "none");
    assert.equal(await row.evaluate((element) => getComputedStyle(element, "::before").height), "1px");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.close();
  }
  console.log("Agent inbox desktop hover, keyboard archive, project actions and mobile layout passed.");
} finally {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
