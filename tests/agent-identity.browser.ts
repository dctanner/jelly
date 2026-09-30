import { startApp } from "./fixtures/app";
import { chromium, type Page } from "playwright-core";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated fixtures only; neither naming nor sending makes a real model request.
const dir = mkdtempSync(join(tmpdir(), "jelly-agent-identity-"));
const app = await startApp({
  dataDir: dir,
  configDir: join(dir, "config"),
  port: 0,
});
app.service.setMode("api");
app.service.harness.generateAgentName = async () => "Coral Coder";
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  headless: true,
});
mkdirSync("output/agent-identity", { recursive: true });
async function fits(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box || box.x < 0 || box.x + box.width > page.viewportSize()!.width + 1)
    throw new Error(
      `${selector} overflows the viewport: ${JSON.stringify(box)}`,
    );
}
try {
  for (const [device, width, height] of [
    ["desktop", 1280, 900],
    ["mobile", 390, 844],
    ["narrow", 320, 740],
  ] as const) {
    const page = await browser.newPage({
      viewport: { width, height },
      reducedMotion: "reduce",
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.server.url.origin);
    await page
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit agent name", exact: true })
      .waitFor();
    if (await page.locator(".conversation-header .agent-identity").count())
      throw new Error("Empty agent is already in the header");
    const titleStyle = await page
      .locator(".initial-agent-title")
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return [
          style.fontFamily,
          style.fontSize,
          style.fontWeight,
          style.lineHeight,
          style.letterSpacing,
        ];
      });
    const titlePillBox = await page
      .locator(".initial-agent-identity")
      .boundingBox();
    await page
      .getByRole("button", { name: "Edit agent name", exact: true })
      .click();
    const inputStyle = await page
      .locator(".inline-agent-name-input")
      .evaluate((element) => {
        const style = getComputedStyle(element);
        if (
          style.backgroundColor !== "rgba(0, 0, 0, 0)" ||
          style.borderTopWidth !== "0px" ||
          style.boxShadow !== "none" ||
          style.outlineStyle !== "none"
        )
          throw new Error("Inline input has visible form chrome");
        return [
          style.fontFamily,
          style.fontSize,
          style.fontWeight,
          style.lineHeight,
          style.letterSpacing,
        ];
      });
    if (JSON.stringify(inputStyle) !== JSON.stringify(titleStyle))
      throw new Error(`Name typography changed on focus: ${JSON.stringify({titleStyle, inputStyle})}`);
    const inputPillBox = await page
      .locator(".initial-agent-identity")
      .boundingBox();
    if (
      !titlePillBox ||
      !inputPillBox ||
      Math.abs(titlePillBox.width - inputPillBox.width) > 1 ||
      Math.abs(titlePillBox.height - inputPillBox.height) > 1
    )
      throw new Error("Pill geometry changed on focus");
    if (
      await page
        .getByRole("button", { name: /Save agent name|Cancel name edit/ })
        .count()
    )
      throw new Error("Inline name action buttons remain");

    await page
      .getByRole("textbox", { name: "Agent name", exact: true })
      .fill("Discard me");
    await page
      .getByRole("textbox", { name: "Agent name", exact: true })
      .press("Escape");
    if (
      (await page
        .getByRole("button", { name: "Edit agent name", exact: true })
        .textContent()) !== "New Agent"
    )
      throw new Error("Escape saved the draft");
    await page
      .getByRole("button", { name: "Edit agent name", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Agent name", exact: true })
      .fill("My Crab");
    await fits(page, ".initial-agent-identity");
    await fits(page, ".inline-agent-name-input");
    await page.screenshot({ path: `output/agent-identity/${device}-name.png` });
    await page
      .getByRole("textbox", { name: "Agent name", exact: true })
      .press("Enter");
    await page
      .getByRole("textbox", { name: "Message My Crab", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Edit agent avatar", exact: true })
      .click();
    await page.getByRole("button", { name: "octopus", exact: true }).waitFor();
    await fits(page, ".initial-agent-profile .sea-avatar-grid");
    const gridFits = await page.locator(".initial-agent-profile .sea-avatar-grid").evaluate(grid =>
      grid.scrollHeight <= grid.clientHeight + 1 && Array.from(grid.children).every(child =>
        child.getBoundingClientRect().bottom <= grid.getBoundingClientRect().bottom + 1));
    if (!gridFits) throw new Error("Avatar grid requires internal scrolling");
    await page.evaluate(() =>
      Promise.all(
        Array.from(document.images, (image) => image.decode().catch(() => {})),
      ),
    );
    const identityBox = await page
      .locator(".initial-agent-identity")
      .boundingBox();
    if (!identityBox || identityBox.y < 72)
      throw new Error("Avatar picker hid the centered pill under the header");
    await page.screenshot({
      path: `output/agent-identity/${device}-avatar.png`,
    });
    await page.getByRole("button", { name: "octopus", exact: true }).click();
    await page.locator(".initial-agent-avatar img[src*='octopus']").waitFor();
    await page
      .getByRole("button", { name: "Edit agent name", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Agent name", exact: true })
      .fill("Marlin Model Integrator");
    // Clicking the composer commits the name without an extra Save interaction.
    await page
      .getByRole("textbox", { name: "Message My Crab", exact: true })
      .click();
    const composer = page.getByRole("textbox", {
      name: "Message Marlin Model Integrator",
      exact: true,
    });
    await composer.waitFor();
    const emptyHeight = await composer.evaluate(element => {
      const style = getComputedStyle(element);
      const singleLine = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const hint = element.parentElement!.querySelector(".composer-placeholder")!;
      const hintStyle = getComputedStyle(hint);
      if (hintStyle.whiteSpace !== "nowrap" || hintStyle.textOverflow !== "ellipsis" || element.scrollHeight > singleLine + 1)
        throw new Error("Composer placeholder wraps");
      return element.clientHeight;
    });
    await page.locator(".composer").screenshot({ path: `output/agent-identity/${device}-placeholder.png` });
    await composer.fill("A message that still supports multiple lines.\nSecond line.\nThird line.");
    const multiline = await composer.evaluate(element => ({ height: element.clientHeight, whiteSpace: getComputedStyle(element).whiteSpace }));
    if (multiline.height <= emptyHeight || multiline.whiteSpace === "nowrap") throw new Error("Messages stopped wrapping");
    await composer.fill("");
    if (await composer.evaluate(element => element.clientHeight) !== emptyHeight) throw new Error("Empty composer did not shrink back to one line");

    await composer.fill("Hello from the UI fixture");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const pill = page.getByRole("button", {
      name: "Edit Marlin Model Integrator profile",
      exact: true,
    });
    await pill.waitFor();
    await app.service.settled();
    await page.waitForFunction(() =>
      document
        .querySelector(".conversation-header .header-status")
        ?.textContent?.includes("Ready"),
    );
    if (await page.locator(".initial-agent-identity").count())
      throw new Error("Centered identity remained after the message");
    await pill.locator("img").click();
    const form = page.getByRole("dialog", {
      name: "Agent profile",
      exact: true,
    });
    await form.waitFor();
    if (
      (await form.getByLabel("Name", { exact: true }).inputValue()) !==
      "Marlin Model Integrator"
    )
      throw new Error("Header did not open the edit form");
    await page.screenshot({
      path: `output/agent-identity/${device}-profile.png`,
    });
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await form.waitFor({ state: "detached" });
    await pill.locator("strong").click();
    await page
      .getByRole("dialog", { name: "Agent profile", exact: true })
      .waitFor();
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(
      `${device}: centered name/avatar editing, Escape/Enter/blur, and direct header form passed`,
    );
    await page.close();
  }
} finally {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
