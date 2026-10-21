import { fixtureBrowserPath } from "./fixtures/browser";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { chromium } from "playwright-core";
import { startApp } from "./fixtures/app";
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
  extra: { staticDir?: string; port?: number; allowedOrigins?: string[] } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "jelly-apps-api-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    authPath: join(dir, "auth.json"),
    port: 0,
    ...extra,
  });
  cleanups.push(() => app.close());
  const origin = app.server.url.origin;
  const bootstrap = await fetch(origin + "/api/control-session");
  const session = await bootstrap.json();
  const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
  const request = (
    path: string,
    method = "GET",
    input?: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(origin + path, {
      method,
      headers: {
        cookie,
        "x-jelly-csrf": session.csrf,
        "content-type": "application/json",
        ...extra,
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
  return { app, dir, origin, request, cookie, csrf: session.csrf };
}
test("Apps API routes use shared service, CSRF, explicit star/launch, metadata-only removal", async () => {
  const f = await fixture();
  expect((await f.request("/api/apps/capabilities")).status).toBe(200);
  const response = await f.request("/api/apps/register", "POST", {
    name: "Private fixture",
    url: "http://app.tailfixture.ts.net",
  });
  expect(response.status).toBe(200);
  const app = await response.json();
  expect(app.starredAt).toBeNull();
  expect((await f.request(`/api/apps/${app.id}`)).status).toBe(200);
  const starred = await (
    await f.request(`/api/apps/${app.id}/star`, "POST", { starred: true })
  ).json();
  expect(starred.starredAt).not.toBeNull();
  const launched = await (
    await f.request(`/api/apps/${app.id}/launch`, "POST", {
      navigationId: "same-entry",
    })
  ).json();
  const duplicate = await (
    await f.request(`/api/apps/${app.id}/launch`, "POST", {
      navigationId: "same-entry",
    })
  ).json();
  expect(duplicate.lastOpenedAt).toBe(launched.lastOpenedAt);
  const page = await (await f.request("/api/apps?q=fixture&limit=1")).json();
  expect(page.starred[0].id).toBe(app.id);
  expect(page.history).toEqual([]);
  expect(
    (await f.request(`/api/apps/${app.id}/star`, "POST", { starred: "true" }))
      .status,
  ).toBe(400);
  expect((await f.request("/api/apps?limit=NaN")).status).toBe(400);
  for (const path of [
    "/api/apps/deploy",
    `/api/apps/${app.id}/control`,
    `/api/apps/${app.id}/logs`,
  ])
    expect((await f.request(path, "POST", {})).status).toBe(404);
  expect(
    (await f.request(`/api/apps/${app.id}/remove`, "POST", { uninstall: true }))
      .status,
  ).toBe(400);
  expect(
    (await f.request(`/api/apps/${app.id}/remove`, "POST", {})).status,
  ).toBe(200);
  expect((await f.request(`/api/apps/${app.id}`)).status).toBe(404);
  expect(f.app.store.events().some((e) => e.type === "apps_changed")).toBe(
    true,
  );
});
test("Apps writes require existing CSRF; app origins cannot read API, bootstrap credentials or use same-site ports", async () => {
  const f = await fixture();
  expect((await fetch(f.origin + "/api/apps")).status).toBe(401);
  for (const endpoint of [
    "/api/apps/register",
    "/api/apps/absent/star",
    "/api/apps/absent/launch",
    "/api/apps/absent/remove",
  ]) {
    expect(
      (await f.request(endpoint, "POST", {}, { "x-jelly-csrf": "" })).status,
    ).toBe(403);
  }
  const appOrigin = f.origin.replace(/:\d+$/, ":39999");
  for (const endpoint of [
    "/api/control-session",
    "/api/state",
    "/api/events",
    "/api/apps",
    "/api/apps/capabilities",
    "/api/chrome/share/socket",
  ]) {
    expect(
      (await f.request(endpoint, "GET", undefined, { origin: appOrigin }))
        .status,
    ).toBe(403);
    expect(
      (
        await f.request(endpoint, "GET", undefined, {
          "sec-fetch-site": "same-site",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request(endpoint, "GET", undefined, {
          "sec-fetch-site": "cross-site",
        })
      ).status,
    ).toBe(403);
  }
  expect(
    (
      await f.request(
        "/api/apps/register",
        "POST",
        { name: "evil" },
        { origin: appOrigin },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request("/api/apps/register", "POST", {
        name: "inline-secret",
        runtimePort: 1234,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.request("/api/apps/register", "POST", {
        name: "same-host",
        url: f.origin.replace(/:\d+$/, ":39999"),
      })
    ).status,
  ).toBe(200);
  // Successful registration does not grant the app origin control privileges.
  expect(
    (await f.request("/api/apps", "GET", undefined, { origin: appOrigin }))
      .status,
  ).toBe(403);
  expect(
    (
      await f.request("/api/control-session", "GET", undefined, {
        origin: appOrigin,
      })
    ).status,
  ).toBe(403);
});
test("Apps viewer deep links receive only SPA, not an app same-origin content proxy", async () => {
  const staticDir = mkdtempSync(join(tmpdir(), "jelly-apps-static-"));
  cleanups.push(() => rmSync(staticDir, { recursive: true, force: true }));
  writeFileSync(join(staticDir, "index.html"), "<h1>Jelly SPA fixture</h1>");
  const f = await fixture({ staticDir });
  const viewer = await fetch(f.origin + "/apps/fixture");
  expect(viewer.status).toBe(200);
  expect(await viewer.text()).toContain("Jelly SPA fixture");
  for (const path of [
    "/apps/fixture/reports/1",
    "/apps",
    "/agents",
    "/agents/fixture",
  ]) {
    const head = await fetch(f.origin + path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("x-frame-options")).toBe("DENY");
  }
  expect(viewer.headers.get("content-security-policy")).toBe(
    "frame-ancestors 'none'; frame-src http: https:",
  );
  expect(viewer.headers.get("x-frame-options")).toBe("DENY");
  expect(viewer.headers.get("referrer-policy")).toBe("no-referrer");
  expect((await f.request("/api/apps/anything/content")).status).toBe(404);
});
test("central policy protects all legacy mutations/private reads and preserves trusted proxy aliases", async () => {
  const alias = "http://localhost:5173";
  const f = await fixture({ allowedOrigins: [alias] });
  const agentId = f.app.store.agents()[0]!.id;
  for (const [path, method] of [
    ["/api/agents", "POST"],
    ["/api/config", "PUT"],
    [`/api/agents/${agentId}`, "PATCH"],
    ...["archive", "restore", "messages", "steer", "stop"].map((action) => [
      `/api/agents/${agentId}/${action}`,
      "POST",
    ]),
  ])
    expect(
      (await f.request(path!, method!, {}, { "x-jelly-csrf": "" })).status,
    ).toBe(403);
  for (const path of [
    "/api/state",
    "/api/events",
    "/api/projects",
    "/api/agents/archived",
    `/api/agents/${agentId}/history`,
    "/api/apps",
    "/api/apps/capabilities",
  ]) {
    expect((await fetch(f.origin + path)).status).toBe(401);
    expect(
      (await f.request(path, "GET", undefined, { origin: "null" })).status,
    ).toBe(403);
    expect(
      (
        await f.request(path, "GET", undefined, {
          "sec-fetch-site": "same-site",
          "sec-fetch-mode": "no-cors",
          "sec-fetch-dest": "image",
        })
      ).status,
    ).toBe(403);
  }
  expect(await (await fetch(f.origin + "/api/health")).json()).toEqual({
    ok: true,
  });
  expect(
    (
      await f.request("/api/state", "GET", undefined, {
        origin: alias,
        "sec-fetch-site": "same-site",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.request("/api/apps", "GET", undefined, {
        origin: alias,
        "sec-fetch-site": "cross-site",
      })
    ).status,
  ).toBe(200);
  expect((await f.request("/api/apps", "OPTIONS")).status).toBe(405);
});
test("bootstrap rejects navigation/no-cors/frame modes and duplicate/path-shadow control namespaces", async () => {
  const f = await fixture();
  const bootstrapHeaders: Record<string, string>[] = [
    { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
    { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" },
    { "sec-fetch-mode": "cors", "sec-fetch-dest": "image" },
    {
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      "sec-fetch-site": "same-site",
    },
  ];
  for (const headers of bootstrapHeaders)
    expect(
      (await f.request("/api/control-session", "GET", undefined, headers))
        .status,
    ).toBe(403);
  const bootstrap = await f.request("/api/control-session", "GET", undefined, {
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  });
  expect(bootstrap.status).toBe(200);
  expect(bootstrap.headers.get("x-content-type-options")).toBe("nosniff");
  expect(bootstrap.headers.get("cache-control")).toBe("no-store");
  const name = f.cookie.split("=")[0]!;
  for (const path of ["/api/control-session", "/api/state", "/api/apps"])
    expect(
      (
        await f.request(path, "GET", undefined, {
          cookie: `${name}=forged; ${f.cookie}`,
        })
      ).status,
    ).toBe(400);
  expect((await f.request("/api/state")).status).toBe(200);
});
test("real browser cannot expose or replace accepted Jelly control cookie via parent Domain/path shadows or frame Jelly", async () => {
  const reserve = createServer();
  await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const staticDir = mkdtempSync(join(tmpdir(), "jelly-control-browser-"));
  cleanups.push(() => rmSync(staticDir, { recursive: true, force: true }));
  writeFileSync(
    join(staticDir, "index.html"),
    "<h1>Protected Jelly fixture</h1>",
  );
  const controlOrigin = `http://control.tailfixture.ts.net:${port}`;
  const f = await fixture({ port, staticDir, allowedOrigins: [controlOrigin] });
  const attacker = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response("<h1>Attacker fixture</h1>", {
        headers: { "content-type": "text/html" },
      }),
  });
  cleanups.push(() => attacker.stop(true));
  const browser = await chromium.launch({
    executablePath: fixtureBrowserPath(process.env.CHROME_BIN),
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--host-resolver-rules=MAP *.tailfixture.ts.net 127.0.0.1",
      "--no-proxy-server",
    ],
  });
  cleanups.push(() => browser.close());
  const context = await browser.newContext();
  const control = await context.newPage();
  await control.goto(controlOrigin);
  const bootstrap = await control.evaluate(async () =>
    (await fetch("/api/control-session")).json(),
  );
  expect(bootstrap.csrf).toBeTruthy();
  expect(
    await control.evaluate(async () => (await fetch("/api/state")).status),
  ).toBe(200);
  const accepted = (await context.cookies(controlOrigin + "/api/state")).find(
    (cookie) => cookie.httpOnly,
  )!;
  expect(accepted).toBeTruthy();
  const malicious = await context.newPage();
  const appOrigin = `http://app.tailfixture.ts.net:${attacker.port}`;
  await malicious.goto(appOrigin + "/api/state");
  expect(await malicious.evaluate(() => document.cookie)).not.toContain(
    accepted.value,
  );
  await malicious.evaluate((name) => {
    document.cookie = `${name}=forged; Domain=tailfixture.ts.net; Path=/api/state`;
  }, accepted.name);
  expect(await malicious.evaluate(() => document.cookie)).not.toContain(
    accepted.value,
  );
  const shadowStatus = await control.evaluate(
    async () => (await fetch("/api/state")).status,
  );
  expect(accepted.name.startsWith("__Host-") ? [200] : [400]).toContain(
    shadowStatus,
  );
  expect(
    (await context.cookies()).find(
      (cookie) =>
        cookie.name === accepted.name &&
        cookie.domain === accepted.domain &&
        cookie.path === accepted.path,
    )!.value,
  ).toBe(accepted.value);
  await malicious.evaluate((name) => {
    document.cookie = `${name}=; Domain=tailfixture.ts.net; Path=/api/state; Max-Age=0`;
  }, accepted.name);
  expect(
    await control.evaluate(async () => (await fetch("/api/state")).status),
  ).toBe(200);
  expect(
    (
      await control.evaluate(async () =>
        (await fetch("/api/control-session")).json(),
      )
    ).csrf,
  ).toBe(bootstrap.csrf);
  const cors = await malicious.evaluate(async (target) => {
    try {
      await fetch(target + "/api/state", { credentials: "include" });
      return "unexpected-success";
    } catch {
      return "blocked";
    }
  }, controlOrigin);
  expect(cors).toBe("blocked");
  await malicious.evaluate((target) => {
    const iframe = document.createElement("iframe");
    iframe.src = target;
    document.body.append(iframe);
  }, controlOrigin + "/apps/fixture");
  await malicious.waitForTimeout(300);
  expect(
    malicious.frames().some((frame) => frame.url().startsWith(controlOrigin)),
  ).toBe(false);
}, 15000);
test("binary icon API validates format/size/ownership and keeps reads private", async () => {
  const f = await fixture();
  const app = await (
    await f.request("/api/apps/register", "POST", {
      name: "Icon API",
      url: "http://127.0.0.1:3007",
    })
  ).json();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=",
    "base64",
  );
  const upload = (
    bytes: Uint8Array,
    contentType = "image/png",
    csrf = f.csrf,
  ) =>
    fetch(f.origin + `/api/apps/${app.id}/icon`, {
      method: "POST",
      headers: {
        cookie: f.cookie,
        "x-jelly-csrf": csrf,
        "content-type": contentType,
      },
      body: new Uint8Array(bytes),
    });
  expect((await f.request(`/api/apps/${app.id}/icon`)).status).toBe(404);
  expect((await upload(png, "image/png", "wrong")).status).toBe(403);
  expect((await upload(Buffer.from("<svg/>"), "image/svg+xml")).status).toBe(
    415,
  );
  expect((await upload(Buffer.from("<svg/>"))).status).toBe(400);
  expect((await upload(png, "image/jpeg")).status).toBe(415);
  expect((await upload(new Uint8Array(1024 * 1024 + 1))).status).toBe(413);
  const saved = await upload(png);
  expect(saved.status).toBe(200);
  const updated = await saved.json();
  expect(updated.iconAssetId).toMatch(/^[a-f0-9-]{36}$/);
  const icon = await f.request(
    `/api/apps/${app.id}/icon?url=file:///etc/passwd`,
  );
  expect(icon.status).toBe(200);
  expect(icon.headers.get("content-type")).toBe("image/png");
  expect(icon.headers.get("x-content-type-options")).toBe("nosniff");
  expect(icon.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(Buffer.from(await icon.arrayBuffer())).toEqual(png);
  expect((await fetch(f.origin + `/api/apps/${app.id}/icon`)).status).toBe(401);
  expect(
    (
      await f.request(`/api/apps/${app.id}/icon`, "GET", undefined, {
        "sec-fetch-site": "same-site",
      })
    ).status,
  ).toBe(403);
  const other = await (
    await f.request("/api/apps/register", "POST", {
      name: "Other icon owner",
      url: "https://app.tailfixture.ts.net",
    })
  ).json();
  expect(
    (
      await f.request("/api/apps/register", "POST", {
        id: other.id,
        name: other.name,
        iconAssetId: updated.iconAssetId,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.request("/api/apps/register", "POST", {
        id: app.id,
        name: app.name,
        iconAssetId: "../../private.png",
      })
    ).status,
  ).toBe(400);
});

test("session/CSRF matrix fails before every Apps/legacy mutation without mutating registry or agents", async () => {
  const f = await fixture();
  const id = f.app.store.agents()[0]!.id;
  const before = f.app.store.cursor();
  const endpoints: [string, string][] = [
    ["/api/apps/register", "POST"],
    ...["star", "launch", "remove", "icon"].map(
      (action) => [`/api/apps/missing/${action}`, "POST"] as [string, string],
    ),
    ["/api/agents", "POST"],
    ["/api/config", "PUT"],
    [`/api/agents/${id}`, "PATCH"],
    ...["archive", "restore", "messages", "steer", "stop", "fresh-session"].map(
      (action) => [`/api/agents/${id}/${action}`, "POST"] as [string, string],
    ),
  ];
  for (const [path, method] of endpoints) {
    for (const [headers, status] of [
      [{ cookie: "" }, 401],
      [{ "x-jelly-csrf": "" }, 403],
      [{ "x-jelly-csrf": "wrong" }, 403],
      [
        {
          origin: f.origin.replace(/:\d+$/, ":39999"),
          "sec-fetch-site": "same-site",
        },
        403,
      ],
      [{ origin: "null" }, 403],
      [{ cookie: f.cookie + "; " + f.cookie }, 400],
    ] as [Record<string, string>, number][]) {
      const response = await f.request(path, method, {}, headers);
      expect(response.status, `${method} ${path}`).toBe(status);
    }
  }
  expect(f.app.store.cursor()).toBe(before);
  expect(f.app.service.apps.list().history).toEqual([]);
});

test("real HTTPS browser uses host-prefixed control credentials, retires legacy paths and resists same-host app-port JS injection", async () => {
  const tlsDir = mkdtempSync(join(tmpdir(), "jelly-secure-control-"));
  cleanups.push(() => rmSync(tlsDir, { recursive: true, force: true }));
  writeFileSync(join(tlsDir, "index.html"), "<h1>Secure Jelly fixture</h1>");
  const key = join(tlsDir, "test.key"),
    cert = join(tlsDir, "test.crt");
  const generated = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=control.tailfixture.ts.net",
      "-addext",
      "subjectAltName=DNS:control.tailfixture.ts.net",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  expect(generated.exitCode).toBe(0);
  let backendOrigin = "";
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(key), cert: Bun.file(cert) },
    async fetch(req) {
      const url = new URL(req.url);
      const response = await fetch(backendOrigin + url.pathname + url.search, {
        method: req.method,
        headers: req.headers,
        ...(req.method !== "GET" && req.method !== "HEAD"
          ? { body: req.body }
          : {}),
      });
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    },
  });
  cleanups.push(() => proxy.stop(true));
  const origin = `https://control.tailfixture.ts.net:${proxy.port}`;
  const f = await fixture({ staticDir: tlsDir, allowedOrigins: [origin] });
  backendOrigin = f.origin;
  const attacker = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(key), cert: Bun.file(cert) },
    fetch: () =>
      new Response("<h1>Same-host attacker</h1>", {
        headers: { "content-type": "text/html" },
      }),
  });
  cleanups.push(() => attacker.stop(true));
  const browser = await chromium.launch({
    executablePath: fixtureBrowserPath(process.env.CHROME_BIN),
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--host-resolver-rules=MAP control.tailfixture.ts.net 127.0.0.1",
      "--no-proxy-server",
    ],
  });
  cleanups.push(() => browser.close());
  // Self-signed disposable proxy certificate only; this is not production TLS provisioning.
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([
    {
      name: "jelly_control",
      value: f.cookie.split("=")[1]!,
      domain: "control.tailfixture.ts.net",
      path: "/api",
      sameSite: "Strict",
      secure: false,
      httpOnly: true,
    },
  ]);
  const control = await context.newPage();
  await control.goto(origin);
  const initial = await control.evaluate(async () =>
    (await fetch("/api/control-session")).json(),
  );
  const cookies = await context.cookies(origin);
  expect(cookies.some((cookie) => cookie.name === "jelly_control")).toBe(false);
  const accepted = cookies.find(
    (cookie) => cookie.name === "__Host-jelly_control",
  )!;
  expect(accepted.httpOnly).toBe(true);
  expect(accepted.secure).toBe(true);
  expect(accepted.path).toBe("/");
  expect(accepted.domain).toBe("control.tailfixture.ts.net");
  expect(accepted.value).not.toBe(f.cookie.split("=")[1]);
  const malicious = await context.newPage();
  await malicious.goto(
    `https://control.tailfixture.ts.net:${attacker.port}/api/state`,
  );
  expect(await malicious.evaluate(() => document.cookie)).not.toContain(
    accepted.value,
  );
  await malicious.evaluate(() => {
    document.cookie = "__Host-jelly_control=forged; Secure; Path=/";
    document.cookie = "__Host-jelly_control=forged; Secure; Path=/api/state";
    document.cookie =
      "__Host-jelly_control=forged; Secure; Domain=tailfixture.ts.net; Path=/";
  });
  expect(
    (await context.cookies(origin)).find(
      (cookie) => cookie.name === accepted.name,
    )!.value,
  ).toBe(accepted.value);
  expect(
    await control.evaluate(async () => (await fetch("/api/state")).status),
  ).toBe(200);
  expect(
    (
      await control.evaluate(async () =>
        (await fetch("/api/control-session")).json(),
      )
    ).csrf,
  ).toBe(initial.csrf);
  expect(
    await malicious.evaluate(async (target) => {
      try {
        await fetch(target + "/api/state", { credentials: "include" });
        return "leaked";
      } catch {
        return "blocked";
      }
    }, origin),
  ).toBe("blocked");
}, 15000);

test("authenticated URL edits retain one canonical URL and no URL is fetched by registration", async () => {
  const f = await fixture();
  let fetched = 0;
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      fetched++;
      return new Response("app");
    },
  });
  cleanups.push(() => target.stop(true));
  const initial = await (
    await f.request("/api/apps/register", "POST", {
      name: "Editable",
      url: target.url.origin + "/dashboard",
    })
  ).json();
  expect(fetched).toBe(0);
  const edited = await (
    await f.request("/api/apps/register", "POST", {
      id: initial.id,
      url: "https://box.tailfixture.ts.net:3007/report",
    })
  ).json();
  expect(edited.url).toBe("https://box.tailfixture.ts.net:3007/report");
  expect(edited.id).toBe(initial.id);
  for (const url of [
    "javascript:alert(1)",
    "http://user:pass@example.test",
    "https://example.test/?token=secret",
    f.origin + "/apps/" + initial.id,
  ])
    expect(
      (await f.request("/api/apps/register", "POST", { id: initial.id, url }))
        .status,
    ).toBe(400);
});
