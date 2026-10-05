import { startApp } from "./fixtures/app";
import { chromium, type Page } from "playwright-core";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "jelly-mobile-layout-"));
const app = await startApp({
  dataDir: dir,
  configDir: join(dir, "config"),
  port: 0,
});
const agent = app.store.agents()[0]!;
for (let i = 0; i < 24; i++)
  app.store.event(agent.id, null, "message", {
    role: "assistant",
    text: `Conversation line ${i}`,
  });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  headless: true,
});
mkdirSync("output/mobile-layout", { recursive: true });

async function settled(page: Page, selector: string) {
  await page.locator(selector).evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
}
async function fits(page: Page, selector: string) {
  await settled(page, selector);
  await page.locator(selector).evaluate((element) => {
    const r = element.getBoundingClientRect();
    const v = window.visualViewport!;
    if (
      r.left < v.offsetLeft - 1 ||
      r.top < v.offsetTop - 1 ||
      r.right > v.offsetLeft + v.width + 1 ||
      r.bottom > v.offsetTop + v.height + 1
    )
      throw new Error(
        `${element.className} outside viewport: ${JSON.stringify(r)}`,
      );
  });
}
async function composerFits(page: Page) {
  await page.waitForFunction(() => {
    const wrap = document
      .querySelector(".composer-wrap")!
      .getBoundingClientRect();
    const header = document
      .querySelector(".conversation-header")!
      .getBoundingClientRect();
    return wrap.top - header.bottom >= window.visualViewport!.height / 4 - 1;
  });
  await page.locator(".composer").evaluate((element) => {
    const textarea = element.querySelector("textarea")!;
    const input = textarea.getBoundingClientRect();
    const footer = element
      .querySelector(".composer-footer")!
      .getBoundingClientRect();
    if (
      Math.abs(input.width - footer.width) > 1 ||
      footer.top < input.bottom - 1
    )
      throw new Error("Composer buttons still consume text width");
    if (document.documentElement.scrollWidth > window.innerWidth)
      throw new Error("Horizontal document overflow");
  });
}

try {
  for (const [width, height] of [
    [320, 740],
    [375, 812],
    [390, 844],
    [430, 932],
    [768, 600],
    [844, 390],
    [1280, 900],
  ]) {
    for (const running of [false, true]) {
      app.store.setStatus(agent.id, running ? "running" : "idle");
      const page = await browser.newPage({
        viewport: { width: width!, height: height! },
        hasTouch: true,
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      // Layout tests emulate keyboard geometry, NOT Safari's native keyboard/zoom.
      await page.addInitScript(() => {
        const viewport = Object.assign(new EventTarget(), {
          width: innerWidth,
          height: innerHeight,
          offsetLeft: 0,
          offsetTop: 0,
          scale: 1,
        });
        Object.defineProperty(window, "visualViewport", {
          configurable: true,
          value: viewport,
        });
      });
      await page.goto(app.server.url.origin);
      if (width! < 768)
        await page
          .getByTitle(`${agent.name} · ${running ? "running" : "idle"}`)
          .click();
      const input = page.getByRole("textbox", {
        name: `Message ${agent.name}`,
        exact: true,
      });
      await input.waitFor();
      await settled(page, "main");
      await input.fill(
        "Long draft with enough text to wrap across the full input width.\n".repeat(
          200,
        ),
      );
      await composerFits(page);
      await fits(page, ".composer-wrap");
      if (
        (await input.evaluate(
          (element) => getComputedStyle(element).overflowY,
        )) !== "auto"
      )
        throw new Error("Long draft does not scroll");
      if (running) {
        const mode = page.getByRole("combobox", { name: "Message delivery" });
        if (
          (await mode.evaluate((element) =>
            parseFloat(getComputedStyle(element).fontSize),
          )) < 16
        )
          throw new Error("Delivery select can trigger focus zoom");
        await mode.selectOption("steer");
      }
      await page.getByRole("button", { name: "Model and effort" }).click();
      const popup =
        width! < 768 ? ".composer-settings-sheet" : ".composer-settings-menu";
      await fits(page, popup);
      for (const name of ["Model", "Reasoning effort"]) {
        if (
          (await page
            .getByRole("combobox", { name, exact: true })
            .evaluate((element) =>
              parseFloat(getComputedStyle(element).fontSize),
            )) < 16
        )
          throw new Error(`${name} can trigger focus zoom`);
      }
      if (
        width! < 768 &&
        (await page.evaluate(() => document.activeElement?.tagName)) !== "H2"
      )
        throw new Error("Settings sheet focused an input");
      if (width === 390 && running) {
        for (const [nextWidth, nextHeight] of [
          [844, 390],
          [390, 844],
        ]) {
          await page.setViewportSize({
            width: nextWidth!,
            height: nextHeight!,
          });
          await page.evaluate(() => {
            Object.assign(window.visualViewport!, {
              width: innerWidth,
              height: innerHeight,
            });
            window.visualViewport!.dispatchEvent(new Event("resize"));
          });
          const rotatedPopup =
            nextWidth! < 768
              ? ".composer-settings-sheet"
              : ".composer-settings-menu";
          await page.locator(rotatedPopup).waitFor();
          await fits(page, rotatedPopup);
          await composerFits(page);
        }
      }
      await page.keyboard.press("Escape");
      await page.locator(popup).waitFor({ state: "detached" });
      await input.fill("");
      if ((await input.evaluate((element) => element.clientHeight)) > 46)
        throw new Error("Empty draft did not shrink");

      if (width! <= 844) {
        await input.focus();
        await page.evaluate(() => {
          Object.assign(window.visualViewport!, {
            height: Math.min(320, innerHeight - 120),
            offsetTop: 40,
          });
          window.visualViewport!.dispatchEvent(new Event("resize"));
        });
        await input.fill("Keyboard draft\n".repeat(200));
        await composerFits(page);
        await fits(page, ".composer-wrap");
        await page.getByRole("button", { name: "Model and effort" }).click();
        await fits(page, popup);
        await page.keyboard.press("Escape");
        await page.locator(popup).waitFor({ state: "detached" });
        // A tall notice cannot eat the reserved band. It scrolls with the
        // bounded composer wrapper and all controls remain reachable.
        await page.evaluate(() => {
          const notice = document.createElement("p");
          notice.textContent = "Long retryable error ".repeat(100);
          document.querySelector(".composer-wrap")!.prepend(notice);
          window.visualViewport!.dispatchEvent(new Event("resize"));
        });
        await composerFits(page);
        await page.locator(".composer-wrap").evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await page.getByRole("button", { name: "Model and effort" }).click();
        await fits(page, popup);
        await page.keyboard.press("Escape");
        await page.locator(popup).waitFor({ state: "detached" });
        await page.evaluate(() => {
          document.querySelector(".composer-wrap > p")?.remove();
          Object.assign(window.visualViewport!, {
            height: innerHeight,
            offsetTop: 0,
          });
          window.visualViewport!.dispatchEvent(new Event("resize"));
        });
      }
      await page.screenshot({
        path: `output/mobile-layout/${width}-${running ? "running" : "idle"}.png`,
      });
      if (width! < 768)
        await page.getByRole("button", { name: "Agents", exact: true }).click();
      await page.getByRole("button", { name: "Agent list menu" }).click();
      await fits(page, ".agent-list-menu-panel");
      await page
        .getByRole("menuitem", { name: "Settings", exact: true })
        .click();
      await fits(page, "dialog.native-sheet");
      if (errors.length) throw new Error(errors.join("\n"));
      await page.close();
      console.log(
        `${width}×${height} ${running ? "running" : "idle"}: width, reserve, controls and overlays passed`,
      );
    }
  }
} finally {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
