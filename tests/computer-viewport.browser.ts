import { startApp } from "./fixtures/app";
import { chromium, type BrowserContext } from "playwright-core";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "jelly-computer-viewport-"));
symlinkSync(resolve(".jelly/runtime"), join(dir, "runtime"), "dir");
const app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
app.service.setMode("api");
const agent = app.store.agents()[0]!;
const computer = app.service.computer.get(agent.id);
const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
  '<body style="margin:0;height:100vh;background:linear-gradient(90deg,#f88464,#55bbdd)"><h1>Remote browser pan test</h1><script>window.lastClick=-1;document.addEventListener("click",e=>window.lastClick=e.clientX)</script>',
  { headers: { "Content-Type": "text/html" } },
) });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await computer.action("open", { url: site.url.href });
  const remote = (computer as unknown as { context: BrowserContext }).context.pages().at(-1)!;
  app.service.emit(agent.id, null, "message", { role: "user", text: "Browser viewport test" });
  await page.goto(app.server.url.origin);
  await page.getByTitle(`${agent.name} · idle`).click();
  await page.getByRole("button", { name: "Agent options", exact: true }).click();
  await page.getByRole("button", { name: "Computer", exact: true }).click();
  await page.getByText("Viewing · Agent has control", { exact: true }).waitFor();
  if (await page.getByRole("slider").count()) throw new Error("View-only mode gained a pan control");
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  const slider = page.getByRole("slider", { name: "Pan browser left and right" });
  await slider.waitFor();
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".computer-screen canvas")?.getBoundingClientRect();
    const viewport = document.querySelector(".computer-screen")?.getBoundingClientRect();
    return canvas && viewport && Math.abs(canvas.height - viewport.height) < 2 && canvas.width > viewport.width;
  });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await slider.focus();
    await slider.press("End");
    await page.waitForFunction(() => {
      const canvas = document.querySelector(".computer-screen canvas")!.getBoundingClientRect();
      const viewport = document.querySelector(".computer-screen")!.getBoundingClientRect();
      return Math.abs(canvas.right - viewport.right) < 2 && Math.abs(canvas.height - viewport.height) < 2;
    });
    await page.locator(".computer-screen").scrollIntoViewIfNeeded();
    const viewport = (await page.locator(".computer-screen").boundingBox())!;
    await page.mouse.click(viewport.x + viewport.width - 30, viewport.y + viewport.height / 2);
    await remote.waitForFunction(() => (window as any).lastClick > 1000);
    await slider.focus();
    await slider.press("Home");
    await page.waitForFunction(() => Math.abs(document.querySelector(".computer-screen canvas")!.getBoundingClientRect().left - document.querySelector(".computer-screen")!.getBoundingClientRect().left) < 2);
    mkdirSync("output/computer-viewport", { recursive: true });
    await page.screenshot({ path: `output/computer-viewport/portrait-${width}.png` });
  }
  for (const [width, height] of [[844, 390], [1280, 900]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await slider.waitFor({ state: "detached" });
    await page.waitForFunction(() => {
      const c = document.querySelector(".computer-screen canvas")!.getBoundingClientRect();
      const v = document.querySelector(".computer-screen")!.getBoundingClientRect();
      return c.width <= v.width + 2 && c.height <= v.height + 2;
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await slider.waitFor();
  await page.getByRole("button", { name: "Return to agent", exact: true }).click();
  await page.getByText("Viewing · Agent has control", { exact: true }).waitFor();
  await slider.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Close browser session", exact: true }).click();
  await page.getByRole("dialog", { name: "Agent computer", exact: true }).waitFor({ state: "detached" });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("PASS: portrait height fill, left/right panning, remote pointer mapping, landscape/desktop fit, and return to agent");
} finally {
  await browser.close();
  await app.service.close();
  // Bun can retain a phantom pendingWebSockets count after real VNC clients
  // disconnect (also covered by the known optional desktop teardown failure).
  // Dispose all service resources, initiate HTTP shutdown, and do not await
  // that server-stop promise; no production shutdown behavior is changed.
  void app.close();
  site.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
