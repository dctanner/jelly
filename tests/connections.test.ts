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
const deviceInfo = {
  userCode: "ABCD-EFGH",
  verificationUri: "https://auth.openai.com/codex/device",
  expiresInSeconds: 900,
};
const waitingLogin: ChatGPTLogin = async (cb) => {
  cb.onDeviceCode(deviceInfo);
  return new Promise((_, reject) => {
    cb.signal!.addEventListener("abort", () => reject(new Error("Cancelled")), {
      once: true,
    });
  });
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
  expect(f.app.service.snapshot().config.ready).toBe(true);
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
test("device login belongs to its starting session and automatically saves only final tokens", async () => {
  let finish!: () => void;
  const f = await fixture(async (cb) => {
    expect(
      await cb.onSelect({
        message: "Method",
        options: [
          { id: "browser", label: "Browser" },
          { id: "device_code", label: "Device" },
        ],
      }),
    ).toBe("device_code");
    cb.onDeviceCode(deviceInfo);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return credentials;
  });
  const headers = await f.session(),
    other = await f.session();
  const start = await (await f.req("/chatgpt/start", {}, headers)).json();
  await until(async () => !!finish);
  const status = await (await f.req("/status", {}, headers)).json();
  expect(status.flow).toMatchObject({
    status: "waiting",
    url: deviceInfo.verificationUri,
    userCode: deviceInfo.userCode,
  });
  expect((await f.req("/chatgpt/start", {}, other)).status).toBe(409);
  expect((await (await f.req("/status", {}, other)).json()).flow).toBeNull();
  expect((await f.req("/chatgpt/cancel", { id: start.id }, other)).status).toBe(
    404,
  );
  expect(f.app.service.harness.auth.has("openai-codex")).toBe(false);
  expect(JSON.stringify(f.app.service.snapshot())).not.toContain(
    deviceInfo.userCode,
  );
  finish();
  await until(async () => f.app.service.snapshot().config.chatgptReady);
  expect(f.app.service.snapshot().config.activeMode).toBe("chatgpt");
  expect(f.app.service.harness.auth.get("openai-codex")).toEqual({
    ...credentials,
    type: "oauth",
  });
  expect(statSync(join(f.dir, "auth.json")).mode & 0o777).toBe(0o600);
  const completed = await (await f.req("/status", {}, headers)).json();
  expect(completed.flow).toMatchObject({
    status: "connected",
    url: null,
    userCode: null,
  });
  for (const secret of [
    deviceInfo.userCode,
    credentials.access,
    credentials.refresh,
  ])
    expect(JSON.stringify(f.app.service.snapshot())).not.toContain(secret);
});
test("cancellation and expiry cannot save late OAuth results, errors do not echo provider secrets", async () => {
  let finish!: (v: typeof credentials) => void;
  const late: ChatGPTLogin = async (cb) => {
    cb.onDeviceCode(deviceInfo);
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
  const exp = await fixture(waitingLogin, 20),
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
test("installed Pi provider requests and polls device codes and cancels without credentials", async () => {
  const originalFetch = globalThis.fetch;
  let polls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://auth.openai.com/")) {
      if (url.endsWith("/api/accounts/deviceauth/usercode"))
        return Response.json({
          device_auth_id: "private-device-id",
          user_code: deviceInfo.userCode,
          interval: "0.01",
        });
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        polls++;
        return new Response("", { status: 403 });
      }
      throw new Error("Unexpected OAuth request");
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  cleanups.push(() => {
    globalThis.fetch = originalFetch;
  });
  const f = await fixture(),
    headers = await f.session();
  const flow = await (await f.req("/chatgpt/start", {}, headers)).json();
  await until(async () => polls > 0);
  const status = await (await f.req("/status", {}, headers)).json();
  expect(status.flow).toMatchObject({
    url: deviceInfo.verificationUri,
    userCode: deviceInfo.userCode,
  });
  expect(JSON.stringify(status)).not.toContain("private-device-id");
  expect(
    (await f.req("/chatgpt/cancel", { id: flow.id }, headers)).status,
  ).toBe(200);
  await until(
    async () => !(await (await f.req("/status", {}, headers)).json()).busy,
  );
  expect(
    (await (await f.req("/status", {}, headers)).json()).flow,
  ).toMatchObject({ userCode: null, url: null, status: "cancelled" });
  expect(f.app.service.harness.auth.has("openai-codex")).toBe(false);
});

test("production startup has no scripted provider and requires credentials even for direct session creation", async () => {
  const { app } = await fixture();
  const h = app.service.harness;
  h.auth.hasAuth = () => false;
  const snapshot = app.service.snapshot();
  expect(snapshot.config).toMatchObject({
    mode: "auto",
    activeMode: null,
    ready: false,
    provider: "",
  });
  expect(h.registry.find("jelly-demo", "local-demo")).toBeUndefined();
  expect(h.runtime.getProviders().some((p) => p.id === "jelly-demo")).toBe(
    false,
  );
  await expect(
    h.create(snapshot.agents[0]!, [], snapshot.config, snapshot.instance),
  ).rejects.toThrow("Connect ChatGPT");
  const headers = await (async () => {
    const res = await fetch(new URL("/api/control-session", app.server.url));
    return {
      cookie: res.headers.get("set-cookie")!.split(";")[0]!,
      "x-jelly-csrf": (await res.json()).csrf,
      "Content-Type": "application/json",
    };
  })();
  const response = await fetch(
    new URL(
      `/api/agents/${snapshot.agents[0]!.id}/fresh-session`,
      app.server.url,
    ),
    {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId: "missing-credentials" }),
    },
  );
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("Settings");
  expect(app.store.runs(snapshot.agents[0]!.id)).toEqual([]);
});
