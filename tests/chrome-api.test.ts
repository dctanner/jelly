import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startApp } from "./fixtures/app";

test("Connected Chrome settings require private control and persist without a managed controller", async () => {
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
    expect(app.store.instance()).not.toHaveProperty("browserBackend");
    expect(app.service.snapshot().config).not.toHaveProperty("browserTarget");
    const status = await fetch(`${origin}/api/chrome`, { headers });
    expect(await status.json()).toEqual({ profiles: [], task: null, selectedProfile: settings.chromeProfile, desktopShared: false, humanUsing: false });
    const agent = app.store.agents()[0]!;
    expect(() =>
      app.service.browsers
        .forRun(agent.id, "test-run", app.store.browserSelection(), agent.name)
        .get(agent.id),
    ).toThrow("disconnected");
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
    ).toBe(404);
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

test("Done and cancellation notify only bound sign-in requests, even after disconnect or failed computer cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-chrome-done-"));
  const app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
  const chrome = app.service.chrome, share = app.service.chromeShare;
  const profile = crypto.randomUUID(), generation = crypto.randomUUID();
  chrome.bridge.profiles = () => [{ id: profile, generation, connected: true, desktopAvailable: true }];
  chrome.bridge.desktop = () => ({ available: true, display: ":3999", auth: "/synthetic" });
  chrome.bridge.call = async (_p, _g, _s, _r, method) => method === "open" ? { pageId: "tab" } : { ok: true };
  const originalStop = (share as any).stopCapture.bind(share);
  try {
    const auth = await fetch(new URL("/api/control-session", app.server.url));
    const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
    const { csrf } = await auth.json();
    const post = (path: string, body: unknown) => fetch(new URL(`/api/${path}`, app.server.url), {
      method: "POST", headers: { cookie, "x-jelly-csrf": csrf, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const agent = app.store.agents()[0]!;
    const run = app.store.createRun(agent.id, "done-fixture", "request", "demo", "local-demo");
    const browser = chrome.allocate(agent.id, run.id, { chromeProfile: profile, chromeOrigins: ["https://example.com"] }, agent.name);
    const request = () => app.service.interventions.request("browser_login", agent.id, run.id, { url: "https://example.com", reason: "Fixture" });
    const first = request();
    await browser.reserveLogin(first.request.id, "https://example.com");
    expect((await post("chrome/done", { agentId: agent.id, handoff: "stale" })).status).toBe(409);
    expect(chrome.state(agent.id).task?.handoff).toBe(first.request.id);
    Object.assign(share, { binary: () => "synthetic", startCapture: async () => { (share as any).status = "sharing"; } });
    const take = await post("chrome/share/take", { agentId: agent.id, profile, profileGeneration: generation });
    expect(take.status).toBe(200);
    Object.assign(share, { stopCapture: async () => { throw new Error("uncertain native cleanup"); } });
    expect((await post("chrome/share/release", { generation: share.state().generation })).status).toBe(409);
    expect(await first.promise).toMatchObject({ completed: true, message: expect.stringContaining("finished") });
    expect(await browser.action("snapshot")).toMatchObject({ humanUsing: false });
    const second = request();
    await browser.reserveLogin(second.request.id, "https://example.com");
    // Cleanup retry is not a completion action for a request created afterward.
    Object.assign(share, { stopCapture: originalStop });
    expect((await post("chrome/share/release", { generation: share.state().generation, cleanupOnly: true })).status).toBe(200);
    expect(chrome.state(agent.id).task?.handoff).toBe(second.request.id);
    expect((await post("chrome/done", { agentId: agent.id, handoff: first.request.id })).status).toBe(409);
    chrome.bridge.onLoss(profile);
    expect((await post("chrome/done", { agentId: agent.id, handoff: second.request.id })).status).toBe(200);
    expect(await second.promise).toMatchObject({ completed: true });
    await expect(browser.action("snapshot")).rejects.toThrow("expired");
    const third = request();
    // Simulate retained status in a disconnected/inactive session, not authority.
    (chrome as any).tasks.get(agent.id).handoff = third.request.id;
    (chrome as any).tasks.get(agent.id).humanUsing = true;
    expect((await post(`interventions/${third.request.id}/deny`, {})).status).toBe(200);
    expect(await third.promise).toMatchObject({ denied: true });
    expect(chrome.state(agent.id).task?.handoff).toBeNull();
    expect(chrome.humanState()).toBe(false);
    // Retire only the completed browser boundary, never auto-resume native input.
    const fourth = request();
    (chrome as any).tasks.get(agent.id).handoff = fourth.request.id;
    (chrome as any).tasks.get(agent.id).humanUsing = true;
    (chrome as any).tasks.get(agent.id).paused = false;
    (chrome as any).tasks.get(agent.id).pauseState = "active";
    (chrome as any).tasks.get(agent.id).lost = false;
    const boundaries = (app.service as any).privateBoundaries as Set<string>;
    boundaries.add(`browser:${agent.id}`);
    boundaries.add("desktop-manual");
    (app.service as any).desktopPrivate = true;
    let released = 0;
    app.service.desktop.releasePrivateControl = async () => { released++; };
    app.service.desktop.resume = async () => { throw new Error("Must not resume native input"); };
    expect((await post("chrome/done", { agentId: agent.id, handoff: fourth.request.id })).status).toBe(200);
    expect(await fourth.promise).toMatchObject({ completed: true });
    expect(boundaries.has(`browser:${agent.id}`)).toBe(false);
    expect(released).toBe(0);
    boundaries.delete("desktop-manual");
    const fifth = request();
    (chrome as any).tasks.get(agent.id).handoff = fifth.request.id;
    (chrome as any).tasks.get(agent.id).humanUsing = true;
    boundaries.add(`browser:${agent.id}`);
    expect((await post("chrome/done", { agentId: agent.id, handoff: fifth.request.id })).status).toBe(200);
    expect(await fifth.promise).toMatchObject({ completed: true });
    expect(released).toBe(1);
    expect((app.service as any).desktopPrivate).toBe(false);
  } finally {
    Object.assign(share, { stopCapture: originalStop });
    await app.close(); rmSync(dir, { recursive: true, force: true });
  }
});
