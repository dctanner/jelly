import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/server/app";
import {
  GeneratedImages,
  generateSubscriptionImages,
  imageGenerationTool,
} from "../src/server/image-generation";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7L8AAAAASUVORK5CYII=";
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-imagegen-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startApp({
    dataDir: dir,
    port: 0,
    configDir: join(dir, "config"),
  });
  cleanups.push(() => app.close());
  const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "image-test" } })).toString("base64url")}.test`;
  app.service.harness.auth.installLoginDriver(async () => ({
    access: token,
    refresh: "test-refresh",
    expires: Date.now() + 3600000,
    accountId: "image-test",
  }));
  await app.service.harness.runtime.login("openai-codex", "oauth", {
    prompt: async () => "",
    notify: () => {},
  });
  const headers: Headers[] = [],
    requests: any[] = [];
  const sockets = new Set<{ terminate(): void }>();
  let behavior:
    | "success"
    | "denied"
    | "close"
    | "wait"
    | "invalid"
    | "incomplete"
    | "none" = "success";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      headers.push(req.headers);
      if (server.upgrade(req)) return;
      return new Response("WebSocket only", { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, raw) {
        requests.push(JSON.parse(String(raw)));
        if (behavior === "wait") return;
        if (behavior === "denied") {
          ws.send(
            JSON.stringify({
              type: "error",
              error: {
                code: "invalid_request_error",
                message: `Secret ${token}`,
              },
            }),
          );
          return;
        }
        if (behavior === "close") {
          ws.terminate();
          return;
        }
        if (behavior === "invalid") {
          ws.send("not JSON");
          return;
        }
        if (behavior === "incomplete") {
          ws.send(JSON.stringify({ type: "response.incomplete" }));
          return;
        }
        const item = {
          type: "image_generation_call",
          id: "ig_one",
          status: "completed",
          result: PNG,
        };
        ws.send(
          JSON.stringify({
            type: "response.image_generation_call.partial_image",
            partial_image_b64: PNG,
          }),
        );
        if (behavior !== "none")
          ws.send(JSON.stringify({ type: "response.output_item.done", item }));
        ws.send(
          JSON.stringify({
            type: "response.completed",
            response: {
              status: "completed",
              output: behavior === "none" ? [] : [item],
            },
          }),
        );
      },
    },
  });
  cleanups.push(() => {
    for (const ws of sockets) ws.terminate();
    void server.stop(true);
  });
  app.service.harness.registry.registerProvider("openai-codex", {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
  });
  const model = app.service.harness.registry.find(
    "openai-codex",
    "gpt-6-astra",
  )!;
  return {
    app,
    dir,
    token,
    headers,
    requests,
    model,
    setBehavior: (next: typeof behavior) => {
      behavior = next;
    },
  };
}

test("subscription image tool uses native WebSocket generation, private files and durable image activity", async () => {
  const f = await fixture();
  const { app, model, token } = f;
  app.service.setMode("chatgpt");
  const agent = app.store.agents()[0]!;
  const config = app.service.snapshot().config;
  const session = await app.service.harness.create(
    agent,
    [],
    config,
    app.service.snapshot().instance,
    [],
    (type, data) => app.store.event(agent.id, null, type, data),
  );
  try {
    const tool = session.agent.state.tools.find(
      (tool) => tool.name === "generate_image",
    )!;
    expect(tool).toBeDefined();
    const result = await tool.execute(
      "image-call",
      { prompt: "A friendly crab" },
      new AbortController().signal,
    );
    expect(f.requests).toHaveLength(1);
    expect(f.headers[0]!.get("authorization")).toBe(`Bearer ${token}`);
    expect(f.headers[0]!.get("chatgpt-account-id")).toBe("image-test");
    expect(f.requests[0]).toMatchObject({
      type: "response.create",
      model: "gpt-6-astra",
      store: false,
      tools: [{ type: "image_generation", output_format: "png" }],
      tool_choice: { type: "image_generation" },
    });
    const event = app.store
      .historyPage(agent.id)
      .events.find((event) => event.type === "image_generated")!;
    const [image] = event.data.images as any[];
    expect(event.data.images).toHaveLength(1); // done + completed deduplicated
    expect(JSON.stringify(result)).not.toContain(PNG);
    expect(JSON.stringify(app.service.snapshot())).not.toContain(token);
    const file = join(f.dir, "generated-images", `${image.id}.png`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const url = `${app.server.url.origin}${image.url}`;
    expect((await fetch(url)).status).toBe(401);
    const control = await fetch(`${app.server.url.origin}/api/control-session`);
    const cookie = control.headers.get("set-cookie")!.split(";")[0]!;
    const imageResponse = await fetch(url, { headers: { cookie } });
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get("content-type")).toBe("image/png");
    expect(imageResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(
      Buffer.from(await imageResponse.arrayBuffer()).toString("base64"),
    ).toBe(PNG);
    expect(
      (
        await fetch(url, {
          headers: { cookie, origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(url.replace(".png", ".svg"), { headers: { cookie } }))
        .status,
    ).toBe(404);
    expect(await new GeneratedImages(f.dir).read(image.url)).toEqual(
      Buffer.from(PNG, "base64"),
    );
    const { Store } = await import("../src/server/store");
    const reopened = new Store(join(f.dir, "jelly.sqlite"));
    try {
      expect(
        reopened
          .historyPage(agent.id)
          .events.find((event) => event.type === "image_generated")?.data
          .images,
      ).toEqual([image]);
    } finally {
      reopened.close();
    }
  } finally {
    await app.service.harness.dispose(session);
  }
  app.service.setMode("demo");
  const demo = await app.service.harness.create(
    agent,
    [],
    app.service.snapshot().config,
    app.service.snapshot().instance,
  );
  try {
    expect(
      demo.getAllTools().some((tool) => tool.name === "generate_image"),
    ).toBe(false);
  } finally {
    await app.service.harness.dispose(demo);
  }
});

test("image generation fails safely on rejection, malformed output, disconnect, cancellation and timeout without retries", async () => {
  const f = await fixture();
  for (const behavior of [
    "denied",
    "close",
    "invalid",
    "incomplete",
    "none",
  ] as const) {
    f.setBehavior(behavior);
    const before = f.requests.length;
    try {
      await generateSubscriptionImages(
        f.app.service.harness.runtime,
        f.model,
        "Crab",
        undefined,
        1000,
      );
      throw new Error("Unexpected success");
    } catch (error) {
      expect(String(error)).not.toContain(f.token);
      expect(String(error)).not.toContain("Unexpected success");
    }
    expect(f.requests.length).toBe(before + 1);
  }
  f.setBehavior("wait");
  const controller = new AbortController();
  const job = generateSubscriptionImages(
    f.app.service.harness.runtime,
    f.model,
    "Crab",
    controller.signal,
  );
  setTimeout(() => controller.abort(), 20);
  await expect(job).rejects.toThrow("cancelled");
  await expect(
    generateSubscriptionImages(
      f.app.service.harness.runtime,
      f.model,
      "Crab",
      undefined,
      30,
    ),
  ).rejects.toThrow("timed out");
  await expect(
    generateSubscriptionImages(
      f.app.service.harness.runtime,
      { ...f.model, provider: "openai" },
      "Crab",
    ),
  ).rejects.toThrow("subscription mode");
  expect(readdirSync(f.dir)).not.toContain("generated-images");
});

test("image storage rejects traversal, SVG, bad base64 and symlinks and cleans up failed publication", async () => {
  const f = await fixture();
  const images = f.app.service.harness.images;
  await expect(images.save(["not base64"], "test")).rejects.toThrow();
  await expect(
    images.save(
      [Buffer.from('<svg onload="alert(1)"/>').toString("base64")],
      "test",
    ),
  ).rejects.toThrow();
  expect(await images.read("/api/images/../../auth.json")).toBeNull();
  const saved = await images.save([PNG], "test");
  expect(saved[0]).toMatchObject({ width: 1, height: 1 });
  const id = crypto.randomUUID();
  symlinkSync(
    join(f.dir, "generated-images", `${saved[0]!.id}.png`),
    join(f.dir, "generated-images", `${id}.png`),
  );
  expect(await images.read(`/api/images/${id}.png`)).toBeNull();
  const badId = crypto.randomUUID();
  writeFileSync(
    join(f.dir, "generated-images", `${badId}.png`),
    "<script>bad</script>",
  );
  expect(await images.read(`/api/images/${badId}.png`)).toBeNull();
  const tool = imageGenerationTool(
    f.app.service.harness.runtime,
    f.model,
    images,
    () => {
      throw new Error("Publish failed");
    },
  );
  const count = readdirSync(images.directory).length;
  await expect(
    tool.execute(
      "call",
      { prompt: "test" },
      new AbortController().signal,
      undefined,
      {} as never,
    ),
  ).rejects.toThrow("Publish failed");
  expect(readdirSync(images.directory)).toHaveLength(count);
});
