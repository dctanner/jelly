import { startApp } from "./fixtures/app";
import { chromium } from "playwright-core";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Real Chromium + notification worker; isolated data, no paid model calls.
const dir = mkdtempSync(join(tmpdir(), "jelly-notifications-browser-"));
const app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true,
});
const context = await browser.newContext({ permissions: ["notifications"], viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
const agent = app.service.createAgent({ name: "Notification Scout", instructions: "", color: "#123456" });
const instance = app.store.instance().id;
async function waitForNotice(title: string, tag: string) {
  await page.evaluate(async ({ title, tag }) => {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const registration = await navigator.serviceWorker.getRegistration("/");
      if ((await registration?.getNotifications())?.some(notification => notification.title === title && notification.tag === tag)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Notification not delivered: ${title}`);
  }, { title, tag });
}
try {
  await page.goto(app.server.url.origin + "/agents");
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[aria-label="Create agent"]')?.disabled);
  await page.getByRole("button", { name: "Agent list menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Browser notifications", exact: true }).click();
  await page.getByRole("button", { name: "Enable notifications", exact: true }).click();
  await page.getByText("Notifications on", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Send test notification", exact: true }).click();
  await waitForNotice("Jelly notifications are on", "jelly:test");
  mkdirSync("output/notifications", { recursive: true });
  await page.screenshot({ path: "output/notifications/settings-desktop.png" });
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Jelly destinations" }).getByRole("link", { name: "Apps", exact: true }).click();
  app.service.emit(agent.id, null, "run_completed", { private: "Never show this message." });
  await waitForNotice("Notification Scout finished", `jelly:${instance}:${agent.id}`);
  const worker = context.serviceWorkers()[0]!;
  // Exercise the real worker's click listener and message source validation,
  // without claiming that a headless browser OS toast was manually clicked.
  await worker.evaluate(async id => {
    const scope = self as unknown as { registration: ServiceWorkerRegistration; dispatchEvent: (event: Event) => boolean };
    const notifications = await scope.registration.getNotifications();
    const notification = notifications.find(notification => notification.data.url === `/agents/${id}`);
    if (!notification || notification.body.includes("Never show")) throw new Error(`Invalid notification contents: ${JSON.stringify({ id, notifications: notifications.map(n => ({ title: n.title, data: n.data })) })}`);
    const event = new Event("notificationclick");
    let work: Promise<unknown> = Promise.resolve();
    Object.defineProperties(event, {
      notification: { value: notification },
      waitUntil: { value: (promise: Promise<unknown>) => { work = promise; } },
    });
    scope.dispatchEvent(event);
    // Synthetic clicks do not carry the browser's user activation for focus().
    await work.catch(error => { if (error.name !== "InvalidAccessError") throw error; });
  }, agent.id);
  await page.getByRole("textbox", { name: "Message Notification Scout", exact: true }).waitFor();
  if (!page.url().endsWith(`/agents/${agent.id}`)) throw new Error("Notification did not route to its agent");
  app.store.setStatus(agent.id, "waiting");
  app.service.emit(agent.id, null, "intervention_requested", { request: { payload: { secret: "Never show this payload." } } });
  // Settings obscures the conversation, so the attention alert is not suppressed.
  await page.getByRole("button", { name: "Agent list menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  app.service.emit(agent.id, null, "intervention_requested", {});
  await waitForNotice("Notification Scout needs attention", `jelly:${instance}:${agent.id}`);
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("PASS: Chromium permission UI, real worker delivery, privacy, click routing from Apps and attention notifications");
} finally {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
