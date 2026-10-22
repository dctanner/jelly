import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startApp } from "./fixtures/app";
import { DesktopLease } from "../src/server/desktop-lease";

test("desktop-card handback retains another browser boundary's cross-instance exclusion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-private-boundaries-"));
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
    // Exercise Mac cross-instance exclusion on every CI host. Unsupported
    // platforms deliberately have no native desktop lease to reserve.
    desktopOptions: { platform: "darwin" },
  });
  const agentId = app.store.agents()[0]!.id;
  const run = app.store.createRun(
    agentId,
    crypto.randomUUID(),
    "Synthetic private-boundary fixture",
    "api",
    "fixture",
  );
  // A synthetic authoritative service-run seam; no model or real browser requests.
  const active = (app.service as unknown as { active: Map<string, unknown> })
    .active;
  active.set(run.id, {
    agentId,
    cancelled: false,
    acceptsSteering: false,
    steering: new Map(),
    done: Promise.resolve(),
  });
  let detach = () => {};
  try {
    const safe = new Promise<void>((resolve) => {
      detach = app.service.subscribe((event) => {
        if (
          event.type === "desktop_changed" &&
          app.service.desktopStatus().handoff?.safe
        )
          resolve();
      });
    });
    const pending = app.service.requestDesktopHandoff(
      agentId,
      run.id,
      "Synthetic private native work",
    );
    void pending.catch(() => {});
    await safe;
    const handoffId = app.service.desktopStatus().handoff!.id;
    await app.service.pauseDesktopForPrivacy(`browser:${agentId}`);
    let browserPaused = true;
    app.service.chrome.state = () => ({
      profiles: [], humanUsing: false,
      task: {
        profile: "fixture", humanUsing: false,
        paused: browserPaused,
        pauseState: browserPaused ? "paused" : "active",
        connected: true,
        active: null,
        tabs: [],
        handoff: null,
        origins: [],
        siteScope: "approved",
      },
    });
    await app.service.resumeDesktop(agentId, run.id, handoffId);
    await pending;
    expect(app.service.desktopStatus().handoff).toBeNull();
    const contender = new DesktopLease(join(dir, "desktop-fixture-leases"), {
      agentId: "other",
      runId: "other",
    });
    await expect(contender.acquire()).rejects.toThrow("Desktop busy");
    await app.service.finishBrowserPrivacy(agentId);
    await expect(contender.acquire()).rejects.toThrow("Desktop busy");
    browserPaused = false;
    await app.service.finishBrowserPrivacy(agentId);
    expect(app.service.desktop.status().control).toBe("paused");
    await contender.acquire();
    await contender.release();
  } finally {
    detach();
    active.delete(run.id);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
