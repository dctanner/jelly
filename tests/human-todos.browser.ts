import { startApp } from "./fixtures/app";
import { chromium } from "playwright-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (
  process.env.JELLY_DISPOSABLE_BROWSER_SOURCE !== resolve(import.meta.dir, "..")
)
  throw new Error(
    "Run bun run test:human-todos-browser to build and test a disposable source copy.",
  );
const dir = mkdtempSync(join(tmpdir(), "jelly-todos-browser-data-"));
const app = await startApp({
  dataDir: dir,
  authPath: join(dir, "auth.json"),
  configDir: join(dir, "config"),
  port: 0,
});
const agent = app.store.agents()[0]!;
app.store.event(agent.id, null, "message", {
  role: "assistant",
  text: "Disposable conversation source",
});
const todo = app.service.changeHumanTodo("create", null, {
  requestId: "browser-fixture",
  title: "Upload the signed agreement",
  instructions: "A long non-secret instruction. ".repeat(80),
  reason: "Finish authorized filing",
  blocking: true,
  agentId: agent.id,
}).todo;
const project = app.service.saveProject(null, { name: "Archived project", defaultCwd: dir });
const archivedFixtures = [null, project.id].map(projectId => {
  const archived = app.service.createAgent({ name: projectId ? "Archived project requester" : "Archived root requester", instructions: "", color: "#123456", projectId });
  const run = app.store.createRun(archived.id, `source-${archived.id}`, "Original source", "api", archived.model);
  const source = app.store.event(archived.id, run.id, "message", { role: "assistant", text: `Historical context for ${archived.name}` });
  const task = app.service.humanTodos.mutate("create", null, { requestId: `todo-${archived.id}`, title: `Action for ${archived.name}` }, { kind: "agent", agentId: archived.id, runId: run.id }).todo;
  app.store.finishRun(run.id, "completed", null);
  app.service.archiveAgent(archived.id, true);
  return { agent: archived, todo: task, source };
});
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  headless: true,
});
try {
  for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(app.server.url.origin + `/agents/${agent.id}`);
    await page
      .locator(".composer textarea")
      .fill("Preserve this unsent chat draft");
    if (width < 768)
      await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByRole("link", { name: /Todos/ }).click();
    await page
      .getByRole("button", {
        name: "Edit or manage Upload the signed agreement",
      })
      .click();
    await page.getByLabel("Action title").fill("Preserved todo draft");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Keep editing" }).click();
    if (
      (await page.getByLabel("Action title").inputValue()) !==
      "Preserved todo draft"
    )
      throw new Error("Todo draft lost on dismissal.");
    await page
      .getByRole("dialog", { name: "Todo details" })
      .evaluate(async (element) => {
        await Promise.all(
          element
            .getAnimations()
            .map((animation) => animation.finished.catch(() => {})),
        );
        if (element.scrollWidth > element.clientWidth + 1)
          throw new Error("Todo sheet overflows horizontally.");
        const box = element.getBoundingClientRect();
        if (
          box.left < -1 ||
          box.right > innerWidth + 1 ||
          box.bottom > innerHeight + 1
        )
          throw new Error("Todo sheet outside viewport.");
        for (const input of element.querySelectorAll("input,textarea,select"))
          if (
            innerWidth < 768 &&
            parseFloat(getComputedStyle(input).fontSize) < 16
          )
            throw new Error("Mobile field text below 16px.");
      });
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    if (width < 768)
      await page.locator(".agent-row", { hasText: agent.name }).first().click();
    if (
      (await page.locator(".composer textarea").inputValue()) !==
      "Preserve this unsent chat draft"
    )
      throw new Error("Chat draft lost switching destinations.");
    await page.goto(app.server.url.origin + `/todos/${todo.id}`);
    await page.getByLabel("Action title").waitFor();
    if ((await page.getByLabel("Action title").inputValue()) !== todo.title)
      throw new Error("Direct todo link failed.");
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    await page.locator(".destination-navigation").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      for (const link of element.querySelectorAll("a")) {
        const box = link.getBoundingClientRect();
        if (
          box.height < 44 ||
          box.left < bounds.left - 1 ||
          box.right > bounds.right + 1
        )
          throw new Error("Destination navigation target overflows.");
      }
    });
    if (
      await page
        .locator(".human-todos")
        .first()
        .evaluate((element) => element.scrollWidth > element.clientWidth + 1)
    )
      throw new Error("Todos list overflows.");
    for (const fixture of archivedFixtures) {
      // Begin with the ordinary snapshot, which excludes the archived target.
      await page.goto(app.server.url.origin + `/agents/${agent.id}`);
      await page.locator(".composer textarea").waitFor();
      if (width < 768) await page.getByRole("button", { name: "Agents", exact: true }).click();
      await page.getByRole("link", { name: /Todos/ }).click();
      await page.getByRole("button", { name: `Edit or manage ${fixture.todo.title}` }).click();
      const detailUrl = page.url();
      await page.getByRole("button", { name: "Open agent", exact: true }).click();
      await page.getByRole("button", { name: `Edit ${fixture.agent.name} profile` }).waitFor();
      await page.locator(".archived-notice").waitFor();
      if ((await page.evaluate(() => history.state.jellyProject)) !== fixture.agent.projectId)
        throw new Error("Archived link used the wrong project scope.");
      await page.goBack();
      await page.getByLabel("Action title").waitFor();
      if (page.url() !== detailUrl) throw new Error("Browser Back lost the canonical todo detail.");
      await page.getByRole("button", { name: "Source conversation", exact: true }).click();
      const source = page.getByRole("dialog", { name: "Source conversation" });
      await source.getByText(`Historical context for ${fixture.agent.name}`, { exact: true }).waitFor();
      await page.getByRole("button", { name: `Edit ${fixture.agent.name} profile` }).waitFor({ state: "attached" });
      await page.goBack();
      await page.getByLabel("Action title").waitFor();
      if (page.url() !== detailUrl) throw new Error("Browser Back from source lost the todo.");
      // Unassign through the real revision-checked UI, keeping immutable source navigation.
      await page.getByLabel("Linked agent").selectOption("");
      await page.getByRole("button", { name: "Save todo", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".todo-editor[disabled]"));
      if (await page.getByRole("button", { name: "Open agent", exact: true }).count())
        throw new Error("Unassigned task retained a current-agent action.");
      await page.getByRole("button", { name: "Source conversation", exact: true }).click();
      await page.getByRole("dialog", { name: "Source conversation" }).getByText(`Historical context for ${fixture.agent.name}`, { exact: true }).waitFor();
      await page.goBack();
      await page.getByLabel("Action title").waitFor();
      await page.getByLabel("Linked agent").selectOption(fixture.agent.id);
      await page.getByRole("button", { name: "Save todo", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".todo-editor[disabled]"));
      if (app.store.runs(fixture.agent.id).length !== 1) throw new Error("Archived navigation started work.");
    }
    console.log(
      `Todos browser checks passed at ${width}px: archived root/project links, source after unassignment, actual Back, draft/layout checks (motion retained).`,
    );
    await context.close();
  }
  if (app.store.runs(agent.id).length)
    throw new Error("Navigation or editing unexpectedly started an agent.");
} finally {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
