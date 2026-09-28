import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { startApp } from "../src/server/app";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
function response(text: string) {
  const item = {
    type: "message",
    id: "msg_fixture",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    { type: "response.created", response: { id: "resp_fixture" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_fixture",
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 9, total_tokens: 19 },
      },
    },
  ];
  return new Response(
    events
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
async function fixture(mode: "api" | "chatgpt" = "api") {
  const dir = mkdtempSync(join(tmpdir(), "jelly-fresh-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const requests: any[] = [];
  let fail = false;
  let closedSockets = 0;
  let gate: Promise<void> | undefined;
  let release = () => {};
  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, server) {
      if (req.headers.get("upgrade") === "websocket") {
        if (server.upgrade(req)) return;
        return new Response("Upgrade failed", { status: 400 });
      }
      const body =
        req.headers.get("content-encoding") === "zstd"
          ? JSON.parse(
              zstdDecompressSync(
                Buffer.from(await req.arrayBuffer()),
              ).toString(),
            )
          : await req.json();
      requests.push(body);
      if (gate) await gate;
      if (fail)
        return new Response(
          JSON.stringify({
            error: {
              message: "Summary unavailable",
              type: "invalid_request_error",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      return response(
        "lantern-checkpoint: preserve the blue lantern decision.",
      );
    },
    websocket: {
      close() {
        closedSockets++;
      },
      async message(ws, raw) {
        requests.push(JSON.parse(String(raw)));
        if (gate) await gate;
        if (fail) {
          ws.send(
            JSON.stringify({ type: "error", code: "invalid_request_error" }),
          );
          return;
        }
        const sse = await response(
          "lantern-checkpoint: preserve the blue lantern decision.",
        ).text();
        for (const line of sse.split("\n"))
          if (line.startsWith("data: ")) ws.send(line.slice(6));
      },
    },
  });
  cleanups.push(() => {
    release();
    void fake.stop(true);
  });
  let app = await startApp({
    dataDir: dir,
    port: 0,
    configDir: join(dir, "config"),
  });
  cleanups.push(async () => {
    release();
    await app.close();
  });
  const configure = async () => {
    const provider = mode === "api" ? "openai" : "openai-codex";
    if (mode === "api")
      await app.service.harness.auth.setRuntimeApiKey(
        provider,
        "local-fixture-key",
      );
    else {
      const access = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
      app.service.harness.auth.installLoginDriver(async () => ({
        access,
        refresh: "fixture-refresh",
        expires: Date.now() + 3600000,
        accountId: "test-account",
      }));
      await app.service.harness.runtime.login(provider, "oauth", {
        prompt: async () => "",
        notify: () => {},
      });
    }
    app.service.harness.registry.registerProvider(provider, {
      baseUrl: `http://127.0.0.1:${fake.port}/v1`,
    });
    app.service.setMode(mode);
  };
  await configure();
  const id = app.store.agents()[0]!.id;
  return {
    get app() {
      return app;
    },
    get closedSockets() {
      return closedSockets;
    },
    id,
    requests,
    fail() {
      fail = true;
    },
    hold() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      gate = undefined;
      release();
    },
    async restart() {
      await app.close();
      app = await startApp({
        dataDir: dir,
        port: 0,
        configDir: join(dir, "config"),
      });
      await configure();
    },
    async seed() {
      app.service.start(
        id,
        crypto.randomUUID(),
        "Remember: the lantern must be blue.",
      );
      await app.service.settled();
      expect(app.store.runs(id)[0]!.status).toBe("completed");
    },
  };
}
async function until(predicate: () => boolean) {
  for (let n = 0; n < 1000; n++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Fixture did not reach expected state");
}

for (const mode of ["api", "chatgpt"] as const)
  test(`Fresh Session uses native Pi compaction (${mode}), rotates the session, preserves history and resumes after restart`, async () => {
    const f = await fixture(mode);
    await f.seed();
    const old = f.app.store.context(f.id)!;
    const history = f.app.store.history(f.id);
    const url = `${f.app.server.url.origin}/api/agents/${f.id}/fresh-session`;
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    const session = await fetch(
      `${f.app.server.url.origin}/api/control-session`,
    );
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const { csrf } = (await session.json()) as { csrf: string };
    const requestId = crypto.randomUUID();
    const request = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
        "x-jelly-csrf": csrf,
      },
      body: JSON.stringify({ requestId }),
    });
    expect(request.status).toBe(202);
    const started = (await request.json()) as any;
    await f.app.service.settled();
    expect(f.app.store.run(started.run.id)!.status).toBe("completed");
    const fresh = f.app.store.context(f.id)!;
    expect(fresh[0]!.id).not.toBe(old[0]!.id);
    expect(fresh.find((e) => e.type === "compaction")).toMatchObject({
      summary: expect.stringContaining("lantern-checkpoint"),
    });
    expect(f.app.store.history(f.id)).toEqual(history);
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[1])).toContain(
      "Remember: the lantern must be blue.",
    );
    expect(JSON.stringify(f.requests[1])).toContain("Original Request"); // Pi's split-turn summary prompt
    const events = f.app.service.snapshot(f.id).events;
    expect(
      events.some((e) => e.type === "compaction_completed" && e.data.success),
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "session_started" && e.data.sessionId === fresh[0]!.id,
      ),
    ).toBe(true);
    expect(events.filter((e) => e.type === "message")).toHaveLength(2);
    if (mode === "chatgpt") await until(() => f.closedSockets >= 1);
    await f.restart();
    expect(f.app.service.freshSession(f.id, requestId).reused).toBe(true);
    f.app.service.start(
      f.id,
      crypto.randomUUID(),
      "Continue from the checkpoint.",
    );
    await f.app.service.settled();
    expect(f.app.store.context(f.id)![0]!.id).toBe(fresh[0]!.id);
    expect(JSON.stringify(f.requests.at(-1).input)).toContain(
      "lantern-checkpoint",
    );
    expect(
      f.app.store.runs(f.id).every((run) => run.status === "completed"),
    ).toBe(true);
  });

test("failed or cancelled compaction never replaces the previous checkpoint", async () => {
  const f = await fixture();
  await f.seed();
  const old = f.app.store.context(f.id);
  const history = f.app.store.history(f.id);
  f.fail();
  const failed = f.app.service.freshSession(f.id, crypto.randomUUID());
  await f.app.service.settled();
  expect(f.app.store.run(failed.run.id)!.status).toBe("failed");
  expect(f.app.store.context(f.id)).toEqual(old);
  expect(f.app.store.history(f.id)).toEqual(history);
  f.hold();
  const stopped = f.app.service.freshSession(f.id, crypto.randomUUID());
  await until(() => f.requests.length === 3);
  await f.app.service.stop(f.id);
  f.release();
  expect(f.app.store.run(stopped.run.id)!.status).toBe("cancelled");
  expect(f.app.store.context(f.id)).toEqual(old);
  expect(
    f.app.service
      .snapshot(f.id)
      .events.some((e) => e.type === "session_started"),
  ).toBe(false);
});

test("fresh-session work is exclusive, stoppable and queues the next prompt against the compacted session", async () => {
  const f = await fixture();
  await f.seed();
  f.hold();
  const run = f.app.service.freshSession(f.id, crypto.randomUUID()).run;
  await until(() => f.requests.length === 2);
  expect(() => f.app.service.freshSession(f.id, crypto.randomUUID())).toThrow(
    "Wait for this agent",
  );
  expect(() =>
    f.app.service.start(f.id, crypto.randomUUID(), "steer", "steer"),
  ).toThrow("Queue the message");
  const queued = f.app.service.start(
    f.id,
    crypto.randomUUID(),
    "Use the summary for this next step.",
  );
  expect(queued.run).toBeNull();
  f.release();
  await f.app.service.settled();
  expect(f.app.store.run(run.id)!.status).toBe("completed");
  expect(f.requests).toHaveLength(3);
  expect(JSON.stringify(f.requests[2].input)).toContain(
    "Use the summary for this next step.",
  );
  expect(JSON.stringify(f.requests[2].input)).toContain("lantern-checkpoint");
  expect(f.app.store.pendingMessages(f.id)).toHaveLength(0);
});

test("empty sessions rotate without invented summaries; demo, missing and archived agents reject the action", async () => {
  const f = await fixture();
  const run = f.app.service.freshSession(f.id, crypto.randomUUID()).run;
  await f.app.service.settled();
  expect(f.app.store.run(run.id)!.status).toBe("completed");
  expect(f.requests).toHaveLength(0);
  expect(f.app.store.context(f.id)![0]!.type).toBe("session");
  expect(
    f.app.service
      .snapshot(f.id)
      .events.find((e) => e.type === "session_started")!.data.compacted,
  ).toBe(false);
  expect(() =>
    f.app.service.freshSession("missing", crypto.randomUUID()),
  ).toThrow("Agent not found");
  f.app.service.archiveAgent(f.id, true);
  expect(() => f.app.service.freshSession(f.id, crypto.randomUUID())).toThrow(
    "Restore this agent",
  );
  f.app.service.archiveAgent(f.id, false);
  f.app.service.setMode("demo");
  expect(() => f.app.service.freshSession(f.id, crypto.randomUUID())).toThrow(
    "Connect ChatGPT",
  );
});

test("an already compacted session can rotate again without losing its summary", async () => {
  const f = await fixture();
  await f.seed();
  f.app.service.freshSession(f.id, crypto.randomUUID());
  await f.app.service.settled();
  const previous = f.app.store.context(f.id)!;
  const next = f.app.service.freshSession(f.id, crypto.randomUUID());
  await f.app.service.settled();
  expect(f.app.store.run(next.run.id)!.status).toBe("completed");
  expect(f.app.store.context(f.id)![0]!.id).not.toBe(previous[0]!.id);
  expect(f.app.store.context(f.id)!.slice(1)).toEqual(previous.slice(1));
  expect(f.requests).toHaveLength(2);
});
