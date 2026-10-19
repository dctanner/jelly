import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startApp } from "./fixtures/app";
import { interventionTools } from "../src/server/agent-tools";
import { DEFAULT_DESKTOP_CONFIG } from "../src/shared/desktop";
import { DesktopLease } from "../src/server/desktop-lease";
async function fixture(platform: NodeJS.Platform = process.platform) {
  const directory = mkdtempSync(join(tmpdir(), "jelly-desktop-api-"));
  const app = await startApp({
    dataDir: directory,
    configDir: join(directory, "config"),
    port: 0,
    desktopOptions: { platform },
  });
  const origin = app.server.url.origin;
  const bootstrap = await fetch(`${origin}/api/control-session`);
  const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
  const { csrf } = (await bootstrap.json()) as { csrf: string };
  const headers = {
    cookie,
    "x-jelly-csrf": csrf,
    "content-type": "application/json",
  };
  return {
    app,
    directory,
    origin,
    headers,
    request: (path: string, input: unknown = {}) =>
      fetch(`${origin}/api/desktop/${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      }),
    close: async () => {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("desktop configuration and controls require private sessions, CSRF and same-origin access", async () => {
  const f = await fixture();
  try {
    expect((await fetch(`${f.origin}/api/desktop`)).status).toBe(401);
    expect(
      (await fetch(`${f.origin}/api/desktop`, { headers: f.headers })).status,
    ).toBe(200);
    for (const operation of [
      "settings",
      "connect",
      "pause",
      "stop",
      "resume",
      "foreground",
    ]) {
      expect(
        (
          await fetch(`${f.origin}/api/desktop/${operation}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${f.origin}/api/desktop/${operation}`, {
            method: "POST",
            headers: { ...f.headers, "x-jelly-csrf": "foreign" },
            body: "{}",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${f.origin}/api/desktop/${operation}`, {
            method: "POST",
            headers: { ...f.headers, origin: "https://foreign.example" },
            body: "{}",
          })
        ).status,
      ).toBe(403);
    }
    const view = (await (
      await fetch(`${f.origin}/api/desktop`, { headers: f.headers })
    ).json()) as any;
    expect(view.config).toEqual(DEFAULT_DESKTOP_CONFIG);
    expect(view.owner).toBeNull();
    expect(view.handoff).toBeNull();
    expect(view.capabilities.foreground).toBe(false);
    expect(f.app.store.browserSelection().browserTarget).toBe("managed");
    expect((await f.request("arbitrary-provider-method")).status).toBe(404);
  } finally {
    await f.close();
  }
});
test("desktop controls reject stale runs and malformed/expired foreground grants", async () => {
  const f = await fixture();
  try {
    const agentId = f.app.store.agents()[0]!.id;
    expect(
      (await f.request("resume", { agentId, runId: "stale" })).status,
    ).toBe(409);
    for (const durationMs of [0, 999, 60001, 1500.5, "30000", null])
      expect(
        (await f.request("foreground", { agentId, runId: "stale", durationMs }))
          .status,
      ).toBe(400);
    const denied = await f.request("foreground", {
      agentId,
      runId: "stale",
      durationMs: 30000,
    });
    expect(denied.ok).toBe(false);
    expect(f.app.service.desktop.status().foregroundExpiresAt).toBeNull();
    expect(f.app.service.desktop.status().owner).toBeNull();
  } finally {
    await f.close();
  }
});
test("desktop settlement occurs after the whole harness run and child disposal", async () => {
  const f = await fixture();
  try {
    const order: string[] = [];
    const harness = f.app.service.harness;
    const settle = harness.settle.bind(harness),
      dispose = harness.dispose.bind(harness);
    harness.settle = async (session) => {
      await settle(session);
      order.push("harness settled");
    };
    harness.dispose = async (...args) => {
      await dispose(...args);
      order.push("children disposed");
    };
    f.app.service.desktop.settle = async () => {
      order.push("desktop released");
    };
    const agent = f.app.store.agents()[0]!;
    f.app.service.start(
      agent.id,
      crypto.randomUUID(),
      "Synthetic lifecycle fixture",
    );
    await f.app.service.settled();
    expect(order).toEqual([
      "harness settled",
      "children disposed",
      "desktop released",
    ]);
  } finally {
    await f.close();
  }
});
test("unsafe desktop drain prevents publishing a browser private-entry card or reserving browser login", async () => {
  const f = await fixture();
  try {
    let reserved = false;
    const tools = interventionTools(
      {
        get: () => ({
          action: async () => ({}),
          reserveLogin: async () => {
            reserved = true;
          },
          cancelLogin: () => {},
        }),
      },
      f.app.service.interventions,
      f.app.store.agents()[0]!.id,
      "fixture-run",
      "/tmp",
      async () => {
        throw new Error("Unconfirmed host completion");
      },
    );
    const login = tools.find((tool) => tool.name === "request_browser_login")!;
    await expect(
      login.execute(
        "tool",
        { url: "https://example.com", reason: "Synthetic private fixture" },
        new AbortController().signal,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("Unconfirmed");
    expect(reserved).toBe(false);
    expect(f.app.store.interventions()).toEqual([]);
  } finally {
    await f.close();
  }
});
test("Chrome cannot report a private-safe pause while desktop completion is unsafe", async () => {
  const f = await fixture();
  try {
    const desktopStatus = f.app.service.desktop.status();
    f.app.service.desktop.status = () => ({
      ...desktopStatus,
      control: "unsafe",
    });
    f.app.service.chrome.state = () => ({
      profiles: [],
      task: {
        profile: "fixture",
        paused: true,
        pauseState: "paused",
        connected: true,
        active: null,
        tabs: [],
        handoff: "fixture",
        origins: [],
        siteScope: "approved",
      },
    });
    const response = await fetch(`${f.origin}/api/chrome?agentId=fixture`, {
      headers: f.headers,
    });
    const state = (await response.json()) as any;
    expect(state.task.paused).toBe(false);
    expect(state.task.pauseState).toBe("failed");
  } finally {
    await f.close();
  }
});
test("browser handback cannot release an independent manual native private boundary", async () => {
  // Mac lease behavior must be simulated explicitly on Linux CI.
  const f = await fixture("darwin");
  try {
    const agentId = f.app.store.agents()[0]!.id;
    expect((await f.request("pause")).ok).toBe(true);
    await f.app.service.pauseDesktopForPrivacy(`browser:${agentId}`);
    await f.app.service.finishBrowserPrivacy(agentId);
    const contender = new DesktopLease(
      join(f.directory, "desktop-fixture-leases"),
      { agentId: "other", runId: "other" },
    );
    await expect(contender.acquire()).rejects.toThrow("Desktop busy");
    expect(f.app.service.desktopStatus().privateSafe).toBe(true);
    expect((await f.request("handback")).ok).toBe(true);
    expect(f.app.service.desktopStatus().control).toBe("paused");
    expect(f.app.service.desktopStatus().privateSafe).toBe(false);
    await contender.acquire();
    await contender.release();
  } finally {
    await f.close();
  }
});
test("a local paused desktop without confirmed shared exclusion cannot authorize Chrome private-entry UI", async () => {
  const f = await fixture();
  try {
    const state = f.app.service.desktop.status();
    f.app.service.desktop.status = () => ({
      ...state,
      control: "paused",
      privateSafe: false,
    });
    f.app.service.chrome.state = () => ({
      profiles: [],
      task: {
        profile: "fixture",
        paused: true,
        pauseState: "paused",
        connected: true,
        active: null,
        tabs: [],
        handoff: "fixture",
        origins: [],
        siteScope: "approved",
      },
    });
    expect(f.app.service.chromeStatus("fixture").task?.paused).toBe(false);
  } finally {
    await f.close();
  }
});
