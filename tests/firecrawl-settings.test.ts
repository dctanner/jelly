import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FirecrawlSettings } from "../src/server/firecrawl-settings";
import { webTools } from "../src/server/web-tools";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const first = "fc-first-test-private-key-123456";
const second = "fc-second-test-private-key-123456";
function fixture(environment: () => string | undefined = () => undefined) {
  const dir = mkdtempSync(join(tmpdir(), "jelly-firecrawl-"));
  dirs.push(dir);
  return { dir, settings: new FirecrawlSettings(dir, environment) };
}

test("Firecrawl credentials persist privately, status is redacted and updates are visible to existing readers", () => {
  const { dir, settings } = fixture();
  expect(settings.status()).toEqual({ configured: false, source: null });
  const reader = new FirecrawlSettings(dir, () => undefined);
  expect(settings.save(`  ${first}  `)).toEqual({ configured: true, source: "settings" });
  expect(statSync(join(dir, "firecrawl.json")).mode & 0o777).toBe(0o600);
  expect(reader.apiKey()).toBe(first);
  settings.save(second);
  expect(reader.apiKey()).toBe(second);
  expect(JSON.stringify(reader.status())).not.toContain(second);
  expect(readFileSync(join(dir, "firecrawl.json"), "utf8")).not.toContain(first);
  expect(readdirSync(dir)).toEqual(["firecrawl.json"]);
});

test("environment migration never returns the secret, refuses overwrites and removal cannot resurrect fallback", () => {
  const { dir, settings } = fixture(() => first);
  expect(settings.status()).toEqual({ configured: true, source: "environment" });
  expect(settings.apiKey()).toBe(first);
  expect(settings.importEnvironment()).toEqual({ configured: true, source: "settings" });
  settings.save(second);
  expect(() => settings.importEnvironment()).toThrow("settings have changed");
  expect(settings.apiKey()).toBe(second);
  expect(settings.remove()).toEqual({ configured: false, source: null });
  const restarted = new FirecrawlSettings(dir, () => first);
  expect(restarted.apiKey()).toBeUndefined();
  expect(() => restarted.importEnvironment()).toThrow("settings have changed");
  expect(readFileSync(join(dir, "firecrawl.json"), "utf8")).not.toContain(first);
  expect(readFileSync(join(dir, "firecrawl.json"), "utf8")).not.toContain(second);
  restarted.save(first);
  expect(settings.apiKey()).toBe(first);
});

test("invalid credentials and corrupt storage fail closed without leaking or overwriting credentials", () => {
  const { dir, settings } = fixture(() => first);
  settings.save(second);
  for (const value of [undefined, null, 3, {}, "", "fc-short", "!echo private", "fc-" + "x".repeat(1022), second + "\nsecret"]) {
    expect(() => settings.save(value)).toThrow("valid Firecrawl API key");
    expect(settings.apiKey()).toBe(second);
  }
  writeFileSync(join(dir, "firecrawl.json"), `broken ${first}`);
  expect(() => settings.apiKey()).toThrow("settings could not be read");
  try { settings.status(); } catch (error) { expect(String(error)).not.toContain(first); }
  settings.save(second);
  expect(settings.apiKey()).toBe(second);
  expect(() => fixture().settings.importEnvironment()).toThrow("No Firecrawl key");
});

test("failed credential writes keep the prior setting and do not leave temporary secrets", () => {
  const { dir, settings } = fixture();
  settings.save(first);
  const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error(second); });
  try {
    expect(() => settings.save(second)).toThrow("Could not save Firecrawl settings");
  } finally { rename.mockRestore(); }
  expect(readdirSync(dir)).toEqual(["firecrawl.json"]);
  expect(settings.apiKey()).toBe(first);
});

test("already-created web tools use saved replacements immediately and stop after removal without environment fallback", async () => {
  const { settings } = fixture(() => first);
  settings.save(first);
  const used: string[] = [];
  const tools = webTools({
    apiKey: () => settings.apiKey(),
    requestsPerMinute: 0,
    fetch: (async (_input, init) => {
      used.push(new Headers(init?.headers).get("authorization")!);
      return Response.json({ success: true, data: { web: [] } });
    }) as typeof fetch,
  });
  const call = () => tools[0]!.execute("test", { query: "fixture" }, undefined, undefined, {} as ExtensionContext);
  await call();
  settings.save(second);
  await call();
  settings.remove();
  await expect(call()).rejects.toThrow("Settings → Firecrawl");
  expect(used).toEqual([`Bearer ${first}`, `Bearer ${second}`]);
});
