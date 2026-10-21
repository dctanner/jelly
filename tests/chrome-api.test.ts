import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startApp } from "./fixtures/app";

test("Connected Chrome settings require private control and persist separately from managed controller", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-chrome-api-"));
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
  });
  try {
    const origin = app.server.url.origin;
    const session = await fetch(`${origin}/api/control-session`);
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const { csrf } = (await session.json()) as { csrf: string };
    const headers = {
      "content-type": "application/json",
      cookie,
      "x-jelly-csrf": csrf,
    };
    const settings = {
      browserTarget: "chrome" as const,
      chromeProfile: crypto.randomUUID(),
      chromeOrigins: ["https://example.com", "http://localhost:8080", "http://[::1]:8080"],
    };
    expect(
      (
        await fetch(`${origin}/api/chrome/settings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(settings),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${origin}/api/chrome/settings`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...settings,
            chromeOrigins: [origin],
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${origin}/api/chrome/settings`, {
          method: "POST",
          headers,
          body: JSON.stringify(settings),
        })
      ).status,
    ).toBe(200);
    expect(app.store.browserSelection()).toEqual(settings);
    expect(app.store.instance().browserBackend).toBe("agent-browser");
    expect(app.service.snapshot().config.browserTarget).toBe("chrome");
    const status = await fetch(`${origin}/api/chrome`, { headers });
    expect(await status.json()).toEqual({ profiles: [], task: null, browserTarget: "chrome", selectedProfile: settings.chromeProfile, desktopShared: false });
    const agent = app.store.agents()[0]!;
    expect(() =>
      app.service.browsers
        .forRun(agent.id, "test-run", app.store.browserSelection(), agent.name)
        .get(agent.id),
    ).toThrow("disconnected");
    expect(app.service.computer.state(agent.id).status).toBe("stopped");
    const internet = {
      ...settings,
      chromeOrigins: [],
      chromeSiteScope: "internet" as const,
    };
    for (const [scope, expected] of [
      ["internet", 200],
      ["approved", 400],
      ["anything", 400],
      [true, 400],
    ] as const) {
      expect(
        (
          await fetch(`${origin}/api/chrome/settings`, {
            method: "POST",
            headers,
            body: JSON.stringify({ ...internet, chromeSiteScope: scope }),
          })
        ).status,
      ).toBe(expected);
    }
    expect(app.store.browserSelection()).toEqual(internet);
    expect(app.service.snapshot().config.chromeSiteScope).toBe("internet");
    expect(() =>
      app.service.setConfig({ agentId: agent.id, chromeSiteScope: "internet" }),
    ).toThrow("global");
    expect(
      (
        await fetch(`${origin}/api/computer/start?agentId=${agent.id}`, {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(409);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Chrome cleanup is invoked after Harness settlement/disposal, not individual tool turns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-chrome-settle-"));
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
  });
  try {
    const order: string[] = [];
    const harness = app.service.harness;
    const settle = harness.settle.bind(harness),
      dispose = harness.dispose.bind(harness);
    harness.settle = async (session) => {
      await settle(session);
      order.push("settle");
    };
    harness.dispose = async (...args) => {
      await dispose(...args);
      order.push("dispose");
    };
    app.service.chrome.settle = async () => {
      order.push("chrome cleanup");
    };
    const agent = app.store.agents()[0]!;
    app.service.start(agent.id, crypto.randomUUID(), "Hello");
    await app.service.settled();
    expect(order).toEqual(["settle", "dispose", "chrome cleanup"]);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
