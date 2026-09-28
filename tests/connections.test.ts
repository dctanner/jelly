import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startApp } from "../src/server/app";
import type { ChatGPTLogin } from "../src/server/connections";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
async function until(fn: () => Promise<boolean>) {
  const end = Date.now() + 3000;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const key = "sk-test-private-key-123456789";
const credentials = {
  access: "test-secret-access",
  refresh: "test-secret-refresh",
  expires: Date.now() + 3600000,
  accountId: "test-account",
};
async function fixture(login?: ChatGPTLogin, ttl = 10000) {
  const dir = mkdtempSync(join(tmpdir(), "jelly-connections-"));
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
    chatgptLogin: login,
    loginTtlMs: ttl,
  });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => app.close());
  const req = (
    path: string,
    data: unknown = {},
    headers: Record<string, string> = {},
  ) =>
    fetch(new URL("/api/auth" + path, app.server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(data),
    });
  const session = async () => {
    const res = await fetch(new URL("/api/control-session", app.server.url));
    return {
      cookie: res.headers.get("set-cookie")!.split(";")[0]!,
      "x-jelly-csrf": (await res.json()).csrf as string,
    };
  };
  return { app, dir, req, session };
}
const manualLogin: ChatGPTLogin = async (cb) => {
  cb.onAuth({
    url: "https://auth.openai.com/oauth/authorize?state=test-state",
  });
  await cb.onManualCodeInput!();
  return credentials;
};
test("API keys require private session+CSRF, save with private permissions and persist without appearing in state/events", async () => {
  const f = await fixture(),
    headers = await f.session();
  expect((await f.req("/api-key", { key })).status).toBe(401);
  expect(
    (await f.req("/api-key", { key }, { cookie: headers.cookie })).status,
  ).toBe(403);
  expect(
    (
      await f.req(
        "/api-key",
        { key },
        { ...headers, Origin: "https://evil.example" },
      )
    ).status,
  ).toBe(403);
  expect(
    (await f.req("/api-key", { key: "!echo unsafe" }, headers)).status,
  ).toBe(400);
  const saved = await f.req("/api-key", { key }, headers);
  expect(saved.status).toBe(200);
  expect(await saved.text()).not.toContain(key);
  expect(f.app.service.snapshot().config.activeMode).toBe("api");
  expect(f.app.service.harness.auth.get("openai")).toEqual({
    type: "api_key",
    key,
  });
  expect(statSync(join(f.dir, "auth.json")).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(f.app.service.snapshot())).not.toContain(key);
  expect(await (await f.req("/status", {}, headers)).text()).not.toContain(key);
  f.app.service.harness.auth.reload();
  expect(f.app.service.harness.auth.get("openai")).toEqual({
    type: "api_key",
    key,
  });
  expect((await f.req("/remove", { provider: "openai" }, headers)).status).toBe(
    200,
  );
  expect(readFileSync(join(f.dir, "auth.json"), "utf8")).not.toContain(key);
});
test("OAuth belongs to the starting session, validates callback state and saves only final tokens", async () => {
  const f = await fixture(manualLogin),
    headers = await f.session(),
    other = await f.session();
  const start = await (await f.req("/chatgpt/start", {}, headers)).json();
  await until(
    async () =>
      (await (await f.req("/status", {}, headers)).json()).flow?.status ===
      "waiting",
  );
  expect((await f.req("/chatgpt/start", {}, other)).status).toBe(409);
  expect((await (await f.req("/status", {}, other)).json()).flow).toBeNull();
  expect(
    (
      await f.req(
        "/chatgpt/callback",
        {
          id: start.id,
          callback:
            "http://localhost:1455/auth/callback?code=test-code&state=wrong",
        },
        headers,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.req(
        "/chatgpt/callback",
        {
          id: start.id,
          callback:
            "http://localhost:1455/auth/callback?code=test-code&state=test-state",
        },
        other,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await f.req(
        "/chatgpt/callback",
        {
          id: start.id,
          callback:
            "http://localhost:1455/auth/callback?code=test-code&state=test-state",
        },
        headers,
      )
    ).status,
  ).toBe(200);
  await until(async () => f.app.service.snapshot().config.chatgptReady);
  expect(f.app.service.snapshot().config.activeMode).toBe("chatgpt");
  expect(f.app.service.harness.auth.get("openai-codex")).toEqual({
    ...credentials,
    type: "oauth",
  });
  const snapshot = JSON.stringify(f.app.service.snapshot());
  for (const secret of [
    "test-code",
    "test-state",
    credentials.access,
    credentials.refresh,
  ])
    expect(snapshot).not.toContain(secret);
  expect(statSync(join(f.dir, "auth.json")).mode & 0o777).toBe(0o600);
  expect(
    (
      await f.req(
        "/chatgpt/callback",
        { id: start.id, callback: "duplicate" },
        headers,
      )
    ).status,
  ).toBe(409);
});
test("cancellation and expiry cannot save late OAuth results, errors do not echo provider secrets", async () => {
  let finish!: (v: typeof credentials) => void;
  const late: ChatGPTLogin = async (cb) => {
    cb.onAuth({
      url: "https://auth.openai.com/oauth/authorize?state=test-state",
    });
    return new Promise((r) => {
      finish = r;
    });
  };
  const f = await fixture(late),
    headers = await f.session();
  const flow = await (await f.req("/chatgpt/start", {}, headers)).json();
  await until(async () => !!finish);
  await f.req("/chatgpt/cancel", { id: flow.id }, headers);
  finish(credentials);
  await until(
    async () => !(await (await f.req("/status", {}, headers)).json()).busy,
  );
  expect(f.app.service.harness.auth.has("openai-codex")).toBe(false);
  const exp = await fixture(manualLogin, 20),
    h = await exp.session();
  await exp.req("/chatgpt/start", {}, h);
  await until(
    async () =>
      (await (await exp.req("/status", {}, h)).json()).flow?.status === "error",
  );
  expect(exp.app.service.harness.auth.has("openai-codex")).toBe(false);
  const fail = await fixture(async () => {
      throw new Error("provider leaked token test-secret-access");
    }),
    fh = await fail.session();
  await fail.req("/chatgpt/start", {}, fh);
  await until(
    async () =>
      (await (await fail.req("/status", {}, fh)).json()).flow?.status ===
      "error",
  );
  expect(await (await fail.req("/status", {}, fh)).text()).not.toContain(
    "test-secret-access",
  );
});
test("the installed Pi OAuth provider starts its real browser flow and cancels without storing credentials", async () => {
  const f = await fixture(),
    headers = await f.session();
  const flow = await (await f.req("/chatgpt/start", {}, headers)).json();
  let authorize = "";
  await until(async () => {
    const status = await (await f.req("/status", {}, headers)).json();
    authorize = status.flow?.url ?? "";
    return !!authorize;
  });
  const url = new URL(authorize);
  expect(url.origin).toBe("https://auth.openai.com");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("redirect_uri")).toBe(
    "http://localhost:1455/auth/callback",
  );
  expect(url.searchParams.get("state")).toBeTruthy();
  expect(
    (await f.req("/chatgpt/cancel", { id: flow.id }, headers)).status,
  ).toBe(200);
  await until(
    async () => !(await (await f.req("/status", {}, headers)).json()).busy,
  );
  expect(f.app.service.harness.auth.has("openai-codex")).toBe(false);
});
