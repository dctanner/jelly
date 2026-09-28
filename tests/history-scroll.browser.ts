import { startApp } from "../src/server/app";
import { chromium } from "playwright-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "jelly-delayed-images-"));
const app = await startApp({
  dataDir: dir,
  configDir: join(dir, "config"),
  port: 0,
});
app.service.setMode("demo");
const id = app.store.agents()[0]!.id;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  headless: true,
});
try {
  const fixturePage = await browser.newPage();
  const pngs = await fixturePage.evaluate(() =>
    [
      [1600, 900],
      [450, 1200],
      [450, 1200],
    ].map(([width, height]) => {
      const canvas = document.createElement("canvas");
      canvas.width = width!;
      canvas.height = height!;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#d9eef5";
      context.fillRect(0, 0, width!, height!);
      return canvas.toDataURL("image/png").split(",")[1]!;
    }),
  );
  await fixturePage.close();
  const images = await app.service.harness.images.save(
    pngs,
    "Delayed image fixture",
  );
  for (let i = 1; i <= 240; i++) {
    app.store.event(id, null, "message", {
      role: "user",
      text: `History line ${i}`,
    });
    const index = [120, 125, 130].indexOf(i);
    if (index >= 0) {
      const { width: _width, height: _height, ...legacy } = images[index]!;
      app.store.event(id, null, "image_generated", {
        images: [index === 1 ? images[index] : legacy],
      });
    }
  }

  for (const [name, width, height] of [
    ["desktop", 1280, 900],
    ["mobile", 390, 844],
  ] as const) {
    const page = await browser.newPage({
      viewport: { width, height },
      reducedMotion: "reduce",
    });
    let releaseAuth = () => {},
      releaseImages = () => {},
      imageRequested = () => {};
    const authGate = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    const imageGate = new Promise<void>((resolve) => {
      releaseImages = resolve;
    });
    const imageStarted = new Promise<void>((resolve) => {
      imageRequested = resolve;
    });
    let failOnce = true;
    await page.route("**/api/control-session", async (route) => {
      await authGate;
      await route.continue();
    });
    await page.route("**/api/images/**", async (route) => {
      imageRequested();
      await imageGate;
      if (route.request().url().endsWith(`${images[2]!.id}.png`) && failOnce) {
        failOnce = false;
        await route.fulfill({ status: 503, body: "Fixture failure" });
      } else await route.continue();
    });
    await page.goto(app.server.url.origin);
    if (name === "mobile") await page.getByTitle("Jelly · idle").click();
    await page.getByText("History line 240", { exact: true }).waitFor();
    await page
      .locator(".conversation")
      .evaluate((el) => el.scrollTo({ top: 100, behavior: "instant" }));
    await page.getByText("History line 60", { exact: true }).waitFor();
    const anchor = await page
      .locator(".timeline > [data-activity-key]")
      .evaluateAll((els) => {
        const el = els.find(
          (el) => el.getBoundingClientRect().top >= 140,
        )! as HTMLElement;
        return {
          key: el.dataset.activityKey,
          top: el.getBoundingClientRect().top,
        };
      });
    const anchorElement = page.locator(`[data-activity-key="${anchor.key}"]`);
    const frameHeights = await page
      .locator(".image-frame")
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    releaseAuth();
    await page.waitForFunction(
      () => document.querySelectorAll(".image-frame img").length === 3,
    );
    await page.locator(".image-frame img").evaluateAll((imgs) =>
      imgs.forEach((img) => {
        (img as HTMLImageElement).loading = "eager";
      }),
    );
    await imageStarted;
    releaseImages();
    await page.locator(".image-frame [role=alert]").waitFor();
    await page.waitForFunction(() =>
      [
        ...document.querySelectorAll<HTMLImageElement>(".image-frame img"),
      ].every((img) => img.complete && img.naturalWidth > 0),
    );
    let after = await anchorElement.evaluate(
      (el) => el.getBoundingClientRect().top,
    );
    if (Math.abs(after - anchor.top) > 1)
      throw new Error(
        `${name}: late image/auth/error shifted viewport ${after - anchor.top}px`,
      );
    // Retry without the test driver automatically scrolling the button into view.
    await page
      .getByRole("button", { name: "Retry", exact: true })
      .evaluate((el) => (el as HTMLElement).click());
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".image-frame img").length === 3 &&
        [
          ...document.querySelectorAll<HTMLImageElement>(".image-frame img"),
        ].every((img) => img.complete && img.naturalWidth > 0),
    );
    after = await anchorElement.evaluate(
      (el) => el.getBoundingClientRect().top,
    );
    const finalHeights = await page
      .locator(".image-frame")
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    if (
      Math.abs(after - anchor.top) > 1 ||
      JSON.stringify(finalHeights) !== JSON.stringify(frameHeights)
    )
      throw new Error(`${name}: retry changed image geometry`);
    // Exercise the resize observer independently of image reservation.
    const previousTop = await page
      .locator(".conversation")
      .evaluate((el) => el.scrollTop);
    await page
      .locator(".timeline > [data-activity-key]")
      .first()
      .evaluate((el) => {
        const spacer = document.createElement("div");
        spacer.style.height = "240px";
        el.append(spacer);
      });
    await page.waitForFunction(
      (top) =>
        Math.abs(
          document.querySelector(".conversation")!.scrollTop - top - 240,
        ) < 1,
      previousTop,
    );
    after = await anchorElement.evaluate(
      (el) => el.getBoundingClientRect().top,
    );
    if (Math.abs(after - anchor.top) > 1)
      throw new Error(
        `${name}: asynchronous content resize moved reading position`,
      );
    await page
      .getByRole("button", { name: "Jump to bottom", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Jump to bottom", exact: true })
      .waitFor({ state: "hidden" });
    console.log(
      `${name}: 0px drift through delayed auth, legacy/new image decode, error/retry and +240px asynchronous growth; jump still works`,
    );
    await page.close();
  }
} finally {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
