import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/server/app";
import { readToolImage } from "../src/server/tool-images";
import {
  isToolImageContent,
  toolImages,
  toolResultForDisplay,
} from "../src/shared/tool-images";
import { groupActivity } from "../src/client/activityGroups";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7L8AAAAASUVORK5CYII=";
const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-tool-image-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
  });
  cleanups.push(() => app.close());
  const agent = app.store.agents()[0]!;
  const control = await fetch(new URL("/api/control-session", app.server.url));
  const cookie = control.headers.get("set-cookie")!.split(";")[0]!;
  return { app, agent, cookie };
}

test("historical read image attachments survive replay pruning and are private raster endpoints", async () => {
  const { app, agent, cookie } = await fixture();
  const start = app.store.event(agent.id, null, "tool_started", {
    name: "read",
    toolCallId: "read-image",
    args: { path: "ad.png" },
  });
  const content = [
    { type: "text", text: "Read image file [image/png]" },
    { type: "image", mimeType: "image/png", data: PNG },
    { type: "image", mimeType: "image/gif", data: GIF },
  ];
  const end = app.store.event(agent.id, null, "tool_completed", {
    name: "read",
    toolCallId: "read-image",
    result: { content },
    isError: false,
  });
  const images = toolImages(end);
  expect(images).toHaveLength(2);
  expect(images[0]!.url).toBe(`/api/tool-images/${end.id}/1`);
  expect(groupActivity([start, end])).toEqual([[start], [end]]);
  expect(JSON.stringify(toolResultForDisplay(end.data.result))).not.toContain(
    PNG,
  );
  expect(content[1]!.data).toBe(PNG); // Model context is unmodified.
  app.store.pruneReplay(end.id + 10001);
  expect(app.store.timelineEvent(end.id)).not.toBeNull();
  for (const [index, mime, expected] of [
    [1, "image/png", PNG],
    [2, "image/gif", GIF],
  ] as const) {
    const url = new URL(`/api/tool-images/${end.id}/${index}`, app.server.url);
    expect((await fetch(url)).status).toBe(401);
    const response = await fetch(url, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(mime);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox",
    );
    expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(
      expected,
    );
    expect(
      (
        await fetch(url, {
          headers: { cookie, origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
  }
  expect(readToolImage(app.store, `/api/tool-images/${end.id}/0`)).toBeNull();
  expect(readToolImage(app.store, `/api/tool-images/${end.id}/99`)).toBeNull();
  expect(readToolImage(app.store, `/api/tool-images/${start.id}/0`)).toBeNull();
});

test("tool attachments reject failed results, wrong MIME, active content, malformed data and unsafe URLs", async () => {
  const { app, agent, cookie } = await fixture();
  for (const [mimeType, data, isError] of [
    ["image/png", PNG, true],
    [
      "image/svg+xml",
      Buffer.from('<svg onload="alert(1)"></svg>').toString("base64"),
      false,
    ],
    [
      "image/png",
      Buffer.from("<html><script>alert(1)</script></html>").toString("base64"),
      false,
    ],
    ["image/jpeg", PNG, false],
    ["image/png", PNG + "!!!", false],
  ] as const) {
    const event = app.store.event(agent.id, null, "tool_completed", {
      name: "read",
      isError,
      result: { content: [{ type: "image", mimeType, data }] },
    });
    const response = await fetch(
      new URL(`/api/tool-images/${event.id}/0`, app.server.url),
      { headers: { cookie } },
    );
    expect(response.status).toBe(404);
  }
  expect(
    isToolImageContent({ type: "image", mimeType: "toString", data: PNG }),
  ).toBe(false);
  expect(
    isToolImageContent({
      type: "image",
      mimeType: "image/png",
      data: "x".repeat(28 * 1024 * 1024),
    }),
  ).toBe(false);
  for (const url of [
    "/api/tool-images/1/-1",
    "/api/tool-images/1/1.5",
    "/api/tool-images/99999999999999999999/0",
    "/api/tool-images/../../auth.json",
    "https://evil.example/1.png",
  ])
    expect(readToolImage(app.store, url)).toBeNull();
});
