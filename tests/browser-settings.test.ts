import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store";
import { defaultChromeSelection } from "../src/shared/chrome-protocol";
import { startApp } from "./fixtures/app";

test("legacy managed settings and site restrictions have no authority after reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-browser-settings-"));
  const path = join(dir, "test.sqlite");
  let store = new Store(path);
  try {
    // Reproduce columns and JSON left by an earlier installation, without
    // opening or migrating any real user's old browser profile.
    store.db.exec("ALTER TABLE instance ADD COLUMN browserBackend TEXT NOT NULL DEFAULT 'agent-browser'");
    const selected = { chromeProfile: crypto.randomUUID() };
    store.db.query("INSERT INTO browser_selection VALUES (1, ?)").run(JSON.stringify({ ...selected, chromeOrigins: ["https://example.com"], chromeSiteScope: "approved", browserTarget: "managed", browserBackend: "playwright" }));
    store.close();
    store = new Store(path);
    expect(store.instance()).not.toHaveProperty("browserBackend");
    expect(store.browserSelection()).toEqual(selected);
    store.setBrowserSelection(store.browserSelection());
    const persisted = store.db.query("SELECT selection FROM browser_selection").get() as { selection: string };
    expect(JSON.parse(persisted.selection)).toEqual(selected);
    for (const value of ["not JSON", "null", "[]", JSON.stringify({ browserTarget: "managed", chromeProfile: 42, chromeOrigins: [false] })]) {
      store.db.query("UPDATE browser_selection SET selection=?").run(value);
      expect(store.browserSelection()).toEqual(defaultChromeSelection());
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale API controller/target fields cannot enable managed functionality", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-browser-retired-api-"));
  const app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
  try {
    const origin = app.server.url.origin;
    const bootstrap = await fetch(origin + "/api/control-session");
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const { csrf } = await bootstrap.json();
    const headers = { cookie, "x-jelly-csrf": csrf, "content-type": "application/json" };
    for (const [path, method, body] of [
      ["/api/config", "PUT", { browserBackend: "playwright", effort: "medium" }],
      ["/api/chrome/settings", "POST", { browserTarget: "managed" }],
    ] as const) {
      const response = await fetch(origin + path, { method, headers, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      const config = await response.json();
      expect(config).not.toHaveProperty("browserBackend");
      expect(config).not.toHaveProperty("browserTarget");
    }
    expect(app.store.browserSelection()).toEqual(defaultChromeSelection());
    const agent = app.store.agents()[0]!;
    expect(() => app.service.browsers.forRun(agent.id, "no-browser-fallback", app.store.browserSelection(), agent.name).get(agent.id)).toThrow("Choose a connected Chrome profile");
    expect((await fetch(origin + "/api/computer/start?agentId=" + agent.id, { method: "POST", headers })).status).toBe(404);
    expect(app.service.snapshot()).not.toHaveProperty("computer");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
