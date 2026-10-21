import type { Page } from "playwright-core";

/** Open the human-only viewer through the Chrome settings, never a managed panel. */
export async function openChromeViewer(page: Page) {
  const viewer = page.getByRole("button", { name: "Connected Chrome web VNC…", exact: true });
  if (!await viewer.isVisible()) {
    const chrome = page.getByRole("button", { name: "Connected Chrome", exact: true });
    if (!await chrome.isVisible()) {
      const menu = page.getByRole("button", { name: "Agent list menu", exact: true });
      if (!await menu.isVisible())
        await page.getByRole("button", { name: "Agents", exact: true }).click();
      await menu.click();
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    }
    await chrome.click();
  }
  await viewer.click();
}
