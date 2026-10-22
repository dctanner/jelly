import type { Page } from "playwright-core";

/** Every entry uses the global computer viewer, never native Mac automation settings. */
export async function openChromeViewer(page: Page) {
  const control = page.getByRole("button", { name: "Computer control", exact: true });
  if (!await control.isVisible()) {
    const menu = page.getByRole("button", { name: "Agent list menu", exact: true });
    if (!await menu.isVisible()) await page.getByRole("button", { name: "Agents", exact: true }).click();
    await menu.click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  }
  await control.click();
}
