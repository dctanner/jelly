import { chromium, type Locator } from "playwright-core";
import { readFileSync } from "node:fs";

// Exercise the production styles; useInputModality's event handling is covered
// by client.test.tsx. No live Jelly service, credentials, or app data are used.
const styles = ["styles.css", "ios.css", "viewport-layout.css", "Apps.css"]
  .map((name) =>
    readFileSync(new URL(`../src/client/${name}`, import.meta.url), "utf8"),
  )
  .join("\n");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  headless: true,
});

async function expectRing(target: Locator, visible: boolean) {
  const ring = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
  });
  if (ring !== visible)
    throw new Error(
      `Expected focus ring ${visible ? "visible" : "hidden"} on ${await target.evaluate((element) => element.outerHTML)}`,
    );
}

try {
  for (const { width, hasTouch, mobile } of [
    { width: 390, hasTouch: true, mobile: true },
    { width: 390, hasTouch: false, mobile: true },
    { width: 844, hasTouch: true, mobile: true },
    { width: 1280, hasTouch: false, mobile: false },
  ]) {
    const page = await browser.newPage({
      viewport: { width, height: 780 },
      hasTouch,
    });
    await page.setContent(`<!doctype html><html><head><style>${styles}</style></head><body>
      <div class="jelly-destinations" data-input-modality="pointer">
        <div class="app"><button id="agent">Agent action</button></div>
        <div class="apps-home"><button id="add" class="apps-add"><span>Add app</span></button></div>
        <nav class="destination-navigation"><a id="destination" href="#apps">Apps</a></nav>
        <nav class="viewer-app-tabs"><a id="viewer" href="#viewer">App</a></nav>
        <input id="text" aria-label="Name">
      </div>
      <div class="apps-menu"><button id="apps-menu" role="menuitem">App details</button></div>
      <div class="agent-list-menu-panel"><button id="agent-menu">Settings</button></div>
      <div class="composer-settings-menu"><button id="composer-menu">Model</button></div>
    </body></html>`);
    for (const modality of ["pointer", "keyboard"]) {
      await page.locator(".jelly-destinations").evaluate((element, value) => {
        (element as HTMLElement).dataset.inputModality = value;
      }, modality);
      for (const id of [
        "agent",
        "add",
        "destination",
        "viewer",
        "apps-menu",
        "agent-menu",
        "composer-menu",
      ]) {
        const target = page.locator(`#${id}`);
        await target.focus();
        await expectRing(
          id === "add" ? target.locator("span") : target,
          !mobile || modality === "keyboard",
        );
      }
      // Editable text fields retain their indicator in either modality.
      await page.locator("#text").focus();
      await expectRing(page.locator("#text"), true);
    }
    // Returning from keyboard navigation to touch must hide the ring again.
    await page.locator(".jelly-destinations").evaluate((element) => {
      (element as HTMLElement).dataset.inputModality = "pointer";
    });
    await page.locator("#apps-menu").focus();
    await expectRing(page.locator("#apps-menu"), !mobile);
    await page.close();
  }
  console.log(
    "Mobile button focus: portrait, landscape touch, portals, keyboard, and desktop passed.",
  );
} finally {
  await browser.close();
}
