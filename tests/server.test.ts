import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startApp } from "./fixtures/app";
import type { Activity, Snapshot } from "../src/shared/types";
const eventControllers = new WeakMap<Response, AbortController>();
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(extra: Partial<Parameters<typeof startApp>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jelly-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
    fixtureDelayMs: 1,
    ...extra,
  });
  cleanups.push(() => app.close());
  app.service.setMode("api");
  const url = `http://127.0.0.1:${app.server.port}`;
  const id = app.store.agents()[0]!.id;
  const request = async (
    path: string,
    method = "GET",
    data?: unknown,
    headers?: Record<string, string>,
  ) => {
    const controller = new AbortController();
    if (path.startsWith("/api/events")) cleanups.push(() => controller.abort());
    const response = await fetch(url + path, {
      signal: controller.signal,
      method,
      headers: {
        "Content-Type": "application/json",
        Connection: "close",
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (path.startsWith("/api/events"))
      eventControllers.set(response, controller);
    return response;
  };
  return { app, dir, url, id, request };
}
async function sseUntil(
  response: Response,
  condition: (events: Activity[]) => boolean,
) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Activity[] = [];
  const timeout = setTimeout(() => void reader.cancel(), 3000);
  try {
    while (!condition(events)) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const item = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = item.split("\n").find((l) => l.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
    }
  } finally {
    clearTimeout(timeout);
    eventControllers.get(response)?.abort();
    await reader.cancel().catch(() => {});
  }
  return events;
}

test.each(["turns", "duration"] as const)(
  "run limit: %s stops work and records the limit reason",
  async (limit) => {
    const { app, id } = await fixture();
    const harness = app.service.harness;
    let onEvent: (event: { type: string }) => void = () => {};
    let expire: () => void = () => {};
    const abort = mock(() => {});
    const session = {
      subscribe: () => {},
      agent: {
        subscribe: (listener: typeof onEvent) => {
          onEvent = listener;
        },
        abort,
      },
      prompt: async () => {
        if (limit === "turns") {
          for (let turn = 1; turn < 1_000; turn++)
            onEvent({ type: "turn_end" });
          expect(abort).not.toHaveBeenCalled();
          onEvent({ type: "turn_end" });
          expect(abort).toHaveBeenCalledTimes(1);
        } else {
          expire();
        }
        throw new Error("Aborted after reaching limit");
      },
    } as unknown as AgentSession;
    const create = spyOn(harness, "create").mockResolvedValue(session);
    const stop = spyOn(harness, "stop").mockResolvedValue(undefined);
    const dispose = spyOn(harness, "dispose").mockResolvedValue(undefined);
    const realSetTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delay: number,
    ) => {
      if (delay === 5 * 60 * 60 * 1_000) expire = callback;
      return realSetTimeout(callback, delay);
    }) as typeof setTimeout);
    try {
      app.service.start(id, `limit-${limit}`, "Keep working");
      await app.service.settled();
      expect(stop).toHaveBeenCalledWith(session);
      expect(dispose).toHaveBeenCalledWith(session, false);
      expect(app.store.runs(id)[0]).toMatchObject({
        status: "failed",
        error: `The run reached the ${limit === "turns" ? "1,000-turn" : "5-hour"} limit. Send a new message to continue.`,
      });
    } finally {
      timer.mockRestore();
      dispose.mockRestore();
      stop.mockRestore();
      create.mockRestore();
    }
  },
);

describe("Jelly local client/server foundation", () => {
  test("real Pi harness executes tools, persists boundaries, and replays missed events without deltas", async () => {
    const { app, id, request } = await fixture();
    const initial = (await (await request("/api/state")).json()) as Snapshot;
    const eventResponse = await request(`/api/events?after=${initial.cursor}`);
    expect(eventResponse.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    const reading = sseUntil(eventResponse, (events) =>
      events.some((e) => e.type === "run_completed"),
    );
    const response = await request(`/api/agents/${id}/messages`, "POST", {
      text: "Hello from the client",
      requestId: "request-one",
    });
    expect(response.status).toBe(202);
    await app.service.settled();
    const events = await reading;
    const types = events.map((e) => e.type);
    expect(types).toContain("tool_started");
    expect(types).toContain("tool_completed");
    expect(types.filter((t) => t === "turn_completed")).toHaveLength(2);
    expect(types).toContain("run_completed");
    expect(types.some((t) => t.includes("delta"))).toBe(false);
    expect(
      events.find((e) => e.type === "tool_completed")?.data.result,
    ).toHaveProperty("content");
    const snapshot = (await (await request("/api/state")).json()) as Snapshot;
    expect(snapshot.agents[0]?.status).toBe("idle");
    expect(snapshot.runs[0]?.status).toBe("completed");
    expect(
      app.store
        .history(id)
        .filter((m) => m.role !== "system")
        .map((m) => m.role),
    ).toEqual(["user", "assistant", "toolResult", "assistant"]);
    const replay = await request("/api/events", "GET", undefined, {
      "Last-Event-ID": String(events[2]!.id),
    });
    const replayed = await sseUntil(replay, (items) =>
      items.some((e) => e.type === "run_completed"),
    );
    expect(replayed.map((e) => e.id)).toEqual(events.slice(3).map((e) => e.id));
  });
  test("idempotency prevents duplicate sends and busy agents queue work in order", async () => {
    const { app, id, request } = await fixture({ fixtureDelayMs: 30 });
    const first = await (
      await request(`/api/agents/${id}/messages`, "POST", {
        text: "First",
        requestId: "same",
      })
    ).json();
    const duplicate = await (
      await request(`/api/agents/${id}/messages`, "POST", {
        text: "First",
        requestId: "same",
      })
    ).json();
    expect(duplicate.reused).toBe(true);
    expect(duplicate.run.id).toBe(first.run.id);
    expect(
      (
        await request(`/api/agents/${id}/messages`, "POST", {
          text: "Second",
          requestId: "new",
        })
      ).status,
    ).toBe(202);
    const queued = await (
      await request(`/api/agents/${id}/messages`, "POST", {
        text: "Second",
        requestId: "new",
      })
    ).json();
    expect(queued.reused).toBe(true);
    expect(queued.message).toMatchObject({ mode: "queue", status: "pending" });
    expect(app.service.snapshot(id).pendingMessages).toHaveLength(1);
    expect(
      (
        await request(`/api/agents/${id}/messages`, "POST", {
          text: "Changed",
          requestId: "same",
        })
      ).status,
    ).toBe(409);
    await app.service.settled();
    expect(app.store.runs(id)).toHaveLength(2);
    expect(
      app.store
        .events(0, id)
        .filter((e) => e.type === "message" && e.data.role === "user"),
    ).toHaveLength(2);
    expect(
      app.store
        .history(id)
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["First", "Second"]);
    expect(app.service.snapshot(id).pendingMessages).toEqual([]);
  });
  test("agents have isolated profiles, runs, and model context", async () => {
    const { app, id, request } = await fixture();
    const second = await (
      await request("/api/agents", "POST", {
        name: "Scout",

        instructions: "Cite evidence",
        color: "#a3d0b0",
      })
    ).json();
    await request(`/api/agents/${id}/messages`, "POST", {
      text: "Remember alpha",
      requestId: "a",
    });
    await request(`/api/agents/${second.id}/messages`, "POST", {
      text: "Remember beta",
      requestId: "b",
    });
    await app.service.settled();
    expect(JSON.stringify(app.store.history(id))).toContain("Remember alpha");
    expect(JSON.stringify(app.store.history(id))).not.toContain(
      "Remember beta",
    );
    const snapshot = (await (
      await request(`/api/state?agentId=${second.id}`)
    ).json()) as Snapshot;
    expect(snapshot.selectedAgentId).toBe(second.id);
    expect(snapshot.events.every((e) => e.agentId === second.id)).toBe(true);
    const edit = await request(`/api/agents/${second.id}`, "PATCH", {
      name: "Scout 2",

      instructions: "Use primary sources",
      color: "#a3d0b0",
    });
    expect(edit.status).toBe(200);
    expect(app.store.agent(second.id)?.instructions).toBe(
      "Use primary sources",
    );
  });
  test("cancellation and provider failures settle runs and allow subsequent work", async () => {
    const { app, id, request } = await fixture({ fixtureDelayMs: 500 });
    await request(`/api/agents/${id}/messages`, "POST", {
      text: "Stop me",
      requestId: "stop",
    });
    expect((await request(`/api/agents/${id}/stop`, "POST", {})).status).toBe(
      200,
    );
    expect(app.store.runs(id)[0]?.status).toBe("cancelled");
    expect(app.store.agent(id)?.status).toBe("idle");
    expect(app.store.history(id)).toHaveLength(0);
    app.service.start(id, "after-stop", "Continue");
    await app.service.settled();
    expect(app.store.runs(id)[1]?.status).toBe("completed");
    const failing = await fixture({ fixtureFail: true });
    failing.app.service.start(failing.id, "fail", "Hello");
    await failing.app.service.settled();
    expect(failing.app.store.runs(failing.id)[0]?.status).toBe("failed");
    expect(failing.app.store.agent(failing.id)?.status).toBe("error");
    expect(failing.app.store.events(0, failing.id).at(-1)?.type).toBe(
      "run_failed",
    );
  });
  test("missing credentials reject messages before persistence and demo cannot be selected", async () => {
    const { app, id, request } = await fixture();
    app.service.harness.auth.hasAuth = () => false;
    for (const mode of ["auto", "chatgpt", "api"] as const) {
      await request("/api/config", "PUT", { mode });
      const response = await request(`/api/agents/${id}/messages`, "POST", {
        text: "Hello", requestId: `missing-${mode}`,
      });
      expect(response.status).toBe(409);
      expect(await response.text()).toContain("Settings");
      expect(() => app.service.start(id, `direct-${mode}`, "Hello")).toThrow("Settings");
      expect(() => app.service.freshSession(id, `fresh-${mode}`)).toThrow("Settings");
    }
    expect((await request("/api/config", "PUT", { mode: "demo" })).status).toBe(400);
    expect(() => app.service.setMode("demo" as never)).toThrow("Unknown connection mode");
    expect(app.store.runs(id)).toEqual([]);
    expect(app.store.pendingMessages(id)).toEqual([]);
    expect(app.store.historyPage(id).events.filter((e) => e.type === "message")).toEqual([]);
    expect(app.store.agent(id)?.status).toBe("idle");
  });
  test("Automatic prefers ChatGPT then API, and requires a connection when neither is available", async () => {
    const { app } = await fixture();
    const auth = app.service.harness.auth;
    const original = auth.hasAuth.bind(auth);
    auth.hasAuth = (provider) =>
      provider === "openai-codex" || provider === "openai";
    expect(app.service.harness.config("auto").activeMode).toBe("chatgpt");
    auth.hasAuth = (provider) => provider === "openai";
    expect(app.service.harness.config("auto").activeMode).toBe("api");
    auth.hasAuth = () => false;
    expect(app.service.harness.config("auto")).toMatchObject({ activeMode: null, ready: false });
    expect(app.service.harness.config("api").ready).toBe(false);
    expect(app.service.harness.config("api").activeMode).toBe("api");
    auth.hasAuth = original;
    expect(
      app.service.harness.registry.find("openai", "gpt-6-astra"),
    ).toBeDefined();
    expect(
      app.service.harness.registry.find("openai-codex", "gpt-6-astra"),
    ).toBeDefined();
    expect(auth.getOAuthProviders().some((p) => p.id === "openai-codex")).toBe(
      true,
    );
  });
  test("validates input, rejects cross-origin requests and never serves private storage", async () => {
    const { request } = await fixture();
    expect((await request("/api/agents", "POST", { name: "" })).status).toBe(
      400,
    );
    expect(
      (
        await request("/api/agents", "POST", {
          name: "Test",

          color: "url(evil)",
        })
      ).status,
    ).toBe(400);
    expect(
      (await request("/api/config", "PUT", { mode: "unknown" })).status,
    ).toBe(400);
    expect(
      (
        await request(
          "/api/config",
          "PUT",
          { mode: "api" },
          { Origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/state", "GET", undefined, {
          Origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("/api/state", "GET", undefined, { Host: "evil.example" }))
        .status,
    ).toBe(403);
    expect((await request("/api/events?after=NaN")).status).toBe(400);
    const reset = await request("/api/events?after=999999");
    expect(reset.status).toBe(200);
    expect(await reset.text()).toContain("event: reset");
    expect((await request("/.jelly/auth.json")).status).toBe(404);
    expect((await request("/api/unknown")).status).toBe(404);
    expect((await request("/api/state?agentId=missing")).status).toBe(404);
  });
});
test("model and effort defaults, validation, mode-only updates and restart persistence", async () => {
  const f = await fixture();
  const initial = f.app.service.snapshot().config;
  expect(initial.selectedModel).toBe("gpt-6-astra");
  expect(initial.effort).toBe("medium");
  for (const data of [
    { model: "gpt-5.4" },
    { effort: "none" },
    { effort: "invalid" },
    { model: null },
  ])
    expect((await f.request("/api/config", "PUT", data)).status).toBe(400);
  const response = await f.request("/api/config", "PUT", {
    model: "gpt-6-astra-ultrafast",
    effort: "max",
  });
  expect(response.status).toBe(200);
  expect((await response.json()).selectedModel).toBe("gpt-6-astra-ultrafast");
  f.app.service.setMode("auto");
  expect(f.app.service.snapshot().config.effort).toBe("max");
  expect(f.app.service.snapshot().config.selectedModel).toBe("gpt-6-astra-ultrafast");
  // An independent connection sees the committed settings; no browser preference is involved.
  const { Store } = await import("../src/server/store");
  const reader = new Store(join(f.dir, "jelly.sqlite"));
  try {
    expect(reader.instance().model).toBe("gpt-6-astra-ultrafast");
    expect(reader.instance().effort).toBe("max");
  } finally {
    reader.close();
  }
});
test("schema v2 upgrades existing instances to Astra/Medium without losing agents", async () => {
  const { Store } = await import("../src/server/store");
  const dir = mkdtempSync(join(tmpdir(), "jelly-model-migrate-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "jelly.sqlite");
  let store = new Store(path);
  const id = store.instance().id;
  store.addAgent({
    name: "Existing",

    instructions: "Keep me",
    color: "#b5bafc",
  });
  store.db.exec(
    "ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT ''; DROP TABLE contexts; DROP TABLE timeline; DROP INDEX idx_agents_archive; DROP INDEX idx_agents_project; ALTER TABLE agents DROP COLUMN projectId; ALTER TABLE agents DROP COLUMN cwd; ALTER TABLE agents DROP COLUMN managedCwd; ALTER TABLE agents DROP COLUMN avatarId; ALTER TABLE agents DROP COLUMN archivedAt; DROP TABLE projects; ALTER TABLE instance DROP COLUMN model; ALTER TABLE instance DROP COLUMN effort; PRAGMA user_version=2;",
  );
  store.close();
  store = new Store(path);
  try {
    expect(store.instance()).toMatchObject({
      id,
      model: "gpt-6-astra",
      effort: "medium",
    });
    expect(store.agents()[0]?.name).toBe("Existing");
  } finally {
    store.close();
  }
});

test("schema v5 removes Role, preserves it in Instructions, and migrates only once", async () => {
  const { Store } = await import("../src/server/store");
  const dir = mkdtempSync(join(tmpdir(), "jelly-role-migrate-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "jelly.sqlite");
  let store = new Store(path);
  const withInstructions = store.addAgent({
    name: "Scout",
    instructions: "Cite sources",
    color: "#b5bafc",
  });
  const roleOnly = store.addAgent({
    name: "Builder",
    instructions: "",
    color: "#b5bafc",
  });
  const noRole = store.addAgent({
    name: "Helper",
    instructions: "Keep this",
    color: "#b5bafc",
  });
  store.db.exec(
    "ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT ''; PRAGMA user_version=5;",
  );
  store.db
    .query("UPDATE agents SET role=? WHERE id=?")
    .run("Researcher", withInstructions.id);
  store.db
    .query("UPDATE agents SET role=? WHERE id=?")
    .run("Coder", roleOnly.id);
  store.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    store = new Store(path);
    try {
      expect(store.agent(withInstructions.id)?.instructions).toBe(
        "Researcher\nCite sources",
      );
      expect(store.agent(roleOnly.id)?.instructions).toBe("Coder");
      expect(store.agent(noRole.id)?.instructions).toBe("Keep this");
      expect(store.agent(withInstructions.id)).not.toHaveProperty("role");
      expect(store.agent(withInstructions.id)?.cwd).toBe(withInstructions.cwd);
      expect(store.db.query("PRAGMA user_version").get()).toEqual({
        user_version: 9,
      });
    } finally {
      store.close();
    }
  }
});

test("queued messages can be promoted to steer without duplication and remaining messages stay queued", async () => {
  const { app, id, request } = await fixture({ fixtureDelayMs: 100 });
  const first = app.service.start(id, "steer-first", "First");
  app.service.start(id, "queue-second", "Second");
  app.service.start(id, "queue-third", "Third");
  const promoted = await request(`/api/agents/${id}/steer`, "POST", {
    messageId: "queue-third",
  });
  expect(promoted.status).toBe(200);
  expect(await promoted.json()).toMatchObject({
    mode: "steer",
    status: "pending",
  });
  expect(
    (
      await request(`/api/agents/${id}/steer`, "POST", {
        messageId: "queue-third",
      })
    ).status,
  ).toBe(200);
  await app.service.settled();
  expect(app.store.runs(id)).toHaveLength(2);
  expect(app.store.pendingMessage("queue-third")).toMatchObject({
    status: "delivered",
    runId: first.run!.id,
    mode: "steer",
  });
  const users = app.store
    .events(0, id)
    .filter((event) => event.type === "message" && event.data.role === "user");
  expect(users.map((event) => event.data.text)).toEqual([
    "First",
    "Third",
    "Second",
  ]);
  expect(
    app.store
      .history(id)
      .filter((message) => message.role === "user")
      .map((message) => message.content),
  ).toEqual(["First", "Third", "Second"]);
  expect(app.service.snapshot(id).pendingMessages).toEqual([]);
  expect(
    (
      await request(`/api/agents/${id}/steer`, "POST", {
        messageId: "queue-second",
      })
    ).status,
  ).toBe(409);
});

test("steering reaches a running Pi session and does not start another run", async () => {
  const { app, id, request } = await fixture({ fixtureDelayMs: 100 });
  const first = app.service.start(id, "direct-first", "First");
  for (
    let count = 0;
    count < 200 &&
    !app.store.events(0, id).some((event) => event.type === "tool_started");
    count++
  )
    await Bun.sleep(5);
  expect(
    app.store.events(0, id).some((event) => event.type === "tool_started"),
  ).toBe(true);
  const response = await request(`/api/agents/${id}/messages`, "POST", {
    requestId: "direct-steer",
    text: "Change direction",
    mode: "steer",
  });
  expect(response.status).toBe(202);
  await app.service.settled();
  expect(app.store.runs(id)).toHaveLength(1);
  expect(app.store.pendingMessage("direct-steer")).toMatchObject({
    status: "delivered",
    runId: first.run!.id,
  });
  expect(
    app.store.history(id).filter((message) => message.role === "user"),
  ).toHaveLength(2);
  expect(
    app.store
      .events(0, id)
      .filter(
        (event) =>
          event.type === "message" && event.data.text === "Change direction",
      ),
  ).toHaveLength(1);
});

test.each([false, true])(
  "stopped or failed runs keep queued messages visible as unsent (failure=%s)",
  async (fail) => {
    const { app, id } = await fixture({ fixtureDelayMs: 100, fixtureFail: fail });
    app.service.start(id, "cancel-first", "First");
    app.service.start(id, "cancel-queued", "Do this later");
    if (!fail) await app.service.stop(id);
    await app.service.settled();
    expect(app.store.runs(id)).toHaveLength(1);
    expect(app.store.pendingMessage("cancel-queued")?.status).toBe("cancelled");
    expect(app.service.snapshot(id).pendingMessages).toEqual([]);
    expect(
      app.store
        .events(0, id)
        .find(
          (event) =>
            event.data.messageId === "cancel-queued" &&
            event.type === "message",
        )?.data,
    ).toMatchObject({ text: "Do this later", deliveryStatus: "cancelled" });
  },
);

test("message modes and steering targets are validated and isolated by agent", async () => {
  const { app, id, request } = await fixture({ fixtureDelayMs: 100 });
  expect(
    (
      await request(`/api/agents/${id}/messages`, "POST", {
        requestId: "invalid",
        text: "Hello",
        mode: "invalid",
      })
    ).status,
  ).toBe(400);
  app.service.start(id, "validation-first", "First");
  app.service.start(id, "validation-pending", "Later");
  const second = app.service.createAgent({
    name: "Other",
    instructions: "",
    color: "#b5bafc",
  });
  expect(app.service.snapshot(second.id).pendingMessages).toEqual([]);
  expect(
    (
      await request(`/api/agents/${second.id}/steer`, "POST", {
        messageId: "validation-pending",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await request(`/api/agents/${id}/messages`, "POST", {
        requestId: "validation-pending",
        text: "Different",
        mode: "steer",
      })
    ).status,
  ).toBe(409);
  await app.service.settled();
});

test("recovery preserves pending message text as unsent and never silently executes it", async () => {
  const { app, id } = await fixture();
  app.store.enqueueMessage("restart-pending", id, "Survive a restart", "queue");
  app.store.recover();
  expect(app.store.pendingMessages(id)).toEqual([]);
  expect(app.store.pendingMessage("restart-pending")?.status).toBe("cancelled");
  expect(app.store.events(0, id).at(-1)?.data).toMatchObject({
    text: "Survive a restart",
    deliveryStatus: "cancelled",
  });
  expect(app.store.runs(id)).toEqual([]);
});

test("steering arriving while a run settles is delivered once by the next run", async () => {
  const { app, id } = await fixture();
  const harness = app.service.harness;
  const originalSettle = harness.settle.bind(harness);
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const settling = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let first = true;
  const settle = spyOn(harness, "settle").mockImplementation(
    async (session) => {
      await originalSettle(session);
      if (first) {
        first = false;
        reached();
        await gate;
      }
    },
  );
  try {
    app.service.start(id, "boundary-first", "First");
    await settling;
    app.service.start(id, "boundary-next", "A late correction", "steer");
    expect(app.store.pendingMessage("boundary-next")?.status).toBe("pending");
    release();
    await app.service.settled();
    expect(app.store.runs(id)).toHaveLength(2);
    expect(app.store.pendingMessage("boundary-next")?.status).toBe("delivered");
    expect(
      app.store
        .events(0, id)
        .filter(
          (event) =>
            event.type === "message" && event.data.text === "A late correction",
        ),
    ).toHaveLength(1);
  } finally {
    release();
    settle.mockRestore();
  }
});

test("distinct steering requests with identical text are each delivered exactly once", async () => {
  const { app, id } = await fixture({ fixtureDelayMs: 30 });
  app.service.start(id, "identical-first", "First");
  app.service.start(id, "identical-one", "Keep going", "steer");
  app.service.start(id, "identical-two", "Keep going", "steer");
  app.service.steer(id, "identical-one");
  app.service.start(id, "identical-two", "Keep going", "steer");
  await app.service.settled();
  expect(app.store.runs(id)).toHaveLength(1);
  expect(app.store.pendingMessages(id)).toEqual([]);
  expect(
    app.store
      .history(id)
      .filter((message) => message.role === "user")
      .map((message) => message.content),
  ).toEqual(["First", "Keep going", "Keep going"]);
});

test("displayable provider thinking is durable before replies without redacted content or signatures", async () => {
  const { app, id } = await fixture();
  let onEvent: (event: any) => void = () => {};
  const message = { role: "assistant", content: [
    { type: "thinking", thinking: "Check the visible layout.", thinkingSignature: "opaque-signature" },
    { type: "thinking", thinking: "redacted-placeholder", redacted: true, thinkingSignature: "opaque-redacted" },
    { type: "text", text: "Here is the result." },
  ], stopReason: "stop", timestamp: Date.now() };
  const session = {
    subscribe: () => {},
    agent: { subscribe: (listener: typeof onEvent) => { onEvent = listener; } },
    prompt: async () => { onEvent({ type: "message_end", message }); },
    sessionManager: { buildSessionContext: () => ({ messages: [message] }) },
  } as unknown as AgentSession;
  const harness = app.service.harness;
  const create = spyOn(harness, "create").mockResolvedValue(session);
  const settle = spyOn(harness, "settle").mockResolvedValue(undefined);
  const dispose = spyOn(harness, "dispose").mockResolvedValue(undefined);
  const checkpoint = spyOn(harness, "checkpoint").mockReturnValue(null as any);
  try {
    app.service.start(id, "thinking-test", "Inspect the layout");
    await app.service.settled();
    const page = app.store.historyPage(id);
    const thinking = page.events.filter((event) => event.type === "thinking");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]!.data).toEqual({ text: "Check the visible layout." });
    expect(thinking[0]!.id).toBeLessThan(page.events.find((event) => event.type === "message" && event.data.role === "assistant")!.id);
    expect(JSON.stringify(page.events)).not.toContain("opaque-");
    expect(JSON.stringify(page.events)).not.toContain("redacted-placeholder");
    expect(page.runs[0]!.status).toBe("completed");
  } finally {
    create.mockRestore(); settle.mockRestore(); dispose.mockRestore(); checkpoint.mockRestore();
  }
});

test("agent activity previews follow outstanding tools across all agents without exposing tool data", async () => {
  const { app, id } = await fixture();
  const old = app.store.createRun(id, "old-preview", "Old work", "api", "model");
  app.service.emit(id, old.id, "tool_started", { toolCallId: "old", name: "write", args: {} });
  app.service.emit(id, old.id, "tool_completed", { toolCallId: "read", name: "read", result: "Old result" });
  app.store.finishRun(old.id, "completed", null);
  const run = app.store.createRun(id, "active-preview", "Current work", "api", "model");
  app.store.setStatus(id, "running");
  const other = app.service.createAgent({ name: "Other worker", instructions: "Test", color: "#abc" });
  const otherRun = app.store.createRun(other.id, "other-preview", "Other work", "api", "model");
  app.store.setStatus(other.id, "running");
  expect(app.service.snapshot(other.id).agentActivity?.[id]).toBe("Thinking…");
  app.service.emit(id, run.id, "tool_started", { toolCallId: "read", name: "read", args: { path: "/private/never-in-preview" } });
  expect(app.store.agentActivity()[id]).toBe("Reading files…");
  app.service.emit(other.id, otherRun.id, "tool_started", { toolCallId: "read", name: "web_search", args: { query: "private query" } });
  app.service.emit(other.id, otherRun.id, "tool_completed", { toolCallId: "read", name: "web_search", result: "private result" });
  expect(app.store.agentActivity()).toEqual({ [id]: "Reading files…", [other.id]: "Thinking…" });
  app.service.emit(id, run.id, "tool_started", { toolCallId: "check", name: "bash", args: { command: "bun run check --private-value" } });
  expect(app.service.snapshot(other.id).agentActivity?.[id]).toBe("Running checks…");
  expect(JSON.stringify(app.store.agentActivity())).not.toContain("private");
  app.service.emit(id, run.id, "tool_completed", { toolCallId: "check", name: "bash", result: "Check complete" });
  expect(app.store.agentActivity()[id]).toBe("Reading files…");
  app.service.emit(id, run.id, "tool_completed", { toolCallId: "read", name: "read", result: "Read complete" });
  expect(app.store.agentActivity()[id]).toBe("Thinking…");
  app.store.setStatus(id, "waiting");
  expect(app.store.agentActivity()[id]).toBeUndefined();
  app.store.finishRun(run.id, "completed", null);
  app.store.setStatus(id, "idle");
  expect(app.service.snapshot(other.id).agentActivity?.[id]).toBeUndefined();
  const { activityPreview } = await import("../src/server/activity-preview");
  expect(activityPreview("bash", "echo secret")).toBe("Running a command…");
  expect(activityPreview("functions.edit", null)).toBe("Editing files…");
  expect(activityPreview("unknown_sensitive_tool", null)).toBe("Using a tool…");
  expect(activityPreview("generate_image", null)).toBe("Creating an image…");
});

test("disconnecting cancels queued work instead of starting a credential-free run", async () => {
  const { app, id } = await fixture({ fixtureDelayMs: 20 });
  let removed = false;
  const unsubscribe = app.service.subscribe((event) => {
    // Lose credentials only after the first real session has started.
    if (!removed && event.type === "tool_started") {
      app.service.start(id, "queued-before-disconnect", "Keep this unsent");
      app.service.harness.auth.hasAuth = () => false;
      removed = true;
      expect(() => app.service.start(id, "new-after-disconnect", "No new queue")).toThrow("Settings");
      expect(() => app.service.steer(id, "queued-before-disconnect")).toThrow("Settings");
    }
  });
  try {
    app.service.start(id, "connected-run", "First message");
    await app.service.settled();
    expect(removed).toBe(true);
    expect(app.store.runs(id)).toHaveLength(1);
    expect(app.store.runs(id)[0]?.status).toBe("completed");
    expect(app.store.pendingMessages(id)).toEqual([]);
    expect(app.store.pendingMessage("queued-before-disconnect")?.status).toBe("cancelled");
    expect(app.store.pendingMessage("new-after-disconnect")).toBeNull();
    expect(app.store.historyPage(id).events.find((e) => e.data.messageId === "queued-before-disconnect" && e.data.deliveryStatus === "cancelled")?.data.reason).toContain("Settings");
  } finally {
    unsubscribe();
  }
});

test.each(["demo", "api", "chatgpt", "auto"])("schema v7 migrates %s safely without changing conversation history", async (mode) => {
  const { Store } = await import("../src/server/store");
  const dir = mkdtempSync(join(tmpdir(), "jelly-access-migrate-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "jelly.sqlite");
  let store = new Store(path);
  const agent = store.addAgent({ name: "Existing", instructions: "Keep me", color: "#ffffff" });
  const run = store.createRun(agent.id, "legacy", "Hello", "demo", "local-demo");
  const event = store.event(agent.id, run.id, "message", { role: "assistant", text: "Existing conversation" });
  store.finishRun(run.id, "completed", null);
  const id = store.instance().id;
  store.db.query("UPDATE instance SET mode=?").run(mode);
  store.db.exec("PRAGMA user_version=7;");
  store.close();
  store = new Store(path);
  try {
    expect(store.instance()).toMatchObject({ id, mode: mode === "demo" ? "auto" : mode });
    expect(store.db.query("PRAGMA user_version").get()).toEqual({ user_version: 9 });
    expect(store.agent(agent.id)).toEqual(agent);
    expect(store.run(run.id)?.mode).toBe("demo");
    expect(store.historyPage(agent.id).events).toContainEqual(event);
  } finally {
    store.close();
  }
});

test("working previews stream the latest displayable thinking line across agents without leaking redaction or signatures", async () => {
  const { app, id } = await fixture();
  const other = app.service.createAgent({ name: "Observer", instructions: "Test", color: "#abc" });
  let onEvent: (event: any) => void = () => {};
  let ready!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let notified!: () => void;
  const notification = new Promise<void>(resolve => { notified = resolve; });
  const unsubscribe = app.service.subscribe(event => {
    if (event.type === "agent_activity") {
      expect(event.agentId).toBeNull();
      expect(event.data).toEqual({ agentId: id });
      notified();
    }
  });
  const message: any = { role: "assistant", content: [{ type: "thinking", thinking: "First line.\n**Latest visible thought.**", thinkingSignature: "opaque-secret" }], stopReason: "stop", timestamp: Date.now() };
  const update = (index = 0) => onEvent({ type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", contentIndex: index, delta: "ignored delta", partial: message } });
  const session = {
    subscribe: () => {},
    agent: { subscribe: (listener: typeof onEvent) => { onEvent = listener; } },
    prompt: async () => { update(); ready(); await gate; onEvent({ type: "message_end", message }); },
    sessionManager: { buildSessionContext: () => ({ messages: [message] }) },
  } as unknown as AgentSession;
  const harness = app.service.harness;
  const create = spyOn(harness, "create").mockResolvedValue(session);
  const settle = spyOn(harness, "settle").mockResolvedValue(undefined);
  const dispose = spyOn(harness, "dispose").mockResolvedValue(undefined);
  const checkpoint = spyOn(harness, "checkpoint").mockReturnValue(null as any);
  try {
    const { run } = app.service.start(id, "streamed-thinking", "Inspect the layout");
    await started;
    expect(app.service.snapshot(other.id).agentActivity?.[id]).toBe("Latest visible thought.");
    expect(app.store.historyPage(id).events.filter(event => event.type === "thinking")).toHaveLength(0);
    message.content[0].thinking += "\n  **Now checking   the header.** \n\n";
    update();
    message.content.push({ type: "thinking", thinking: "redacted-secret", redacted: true, thinkingSignature: "opaque-redacted" });
    update(1);
    await notification;
    app.service.emit(id, run!.id, "tool_started", { name: "read", toolCallId: "one", args: { path: "private-path" } });
    expect(app.service.snapshot(other.id).agentActivity?.[id]).toBe("Now checking the header.");
    expect(JSON.stringify(app.service.snapshot(other.id))).not.toContain("opaque-secret");
    expect(JSON.stringify(app.service.snapshot(other.id))).not.toContain("redacted-secret");
    app.store.setStatus(id, "waiting");
    expect(app.service.snapshot(other.id).agentActivity?.[id]).toBeUndefined();
    app.store.setStatus(id, "running");
    finish(); await app.service.settled();
    expect(app.service.snapshot(other.id).agentActivity?.[id]).toBeUndefined();
    const next = app.store.createRun(id, "new-thinking-run", "New work", "api", "model");
    app.store.setStatus(id, "running");
    expect(app.store.agentActivity()[id]).toBe("Thinking…");
    app.service.emit(id, next.id, "thinking", { text: "Old line\r\n## **Persisted latest line**\n" });
    expect(app.store.agentActivity()[id]).toBe("Persisted latest line");
    app.store.finishRun(next.id, "completed", null); app.store.setStatus(id, "idle");
    const { thinkingPreview } = await import("../src/server/activity-preview");
    expect(thinkingPreview("x".repeat(500)).length).toBe(220);
    expect(thinkingPreview("\n\t")).toBe("");
    expect(thinkingPreview("## **Checking the header**")).toBe("Checking the header");
    expect(thinkingPreview("**Checking the header")).toBe("Checking the header");
    expect(thinkingPreview("- Read [the docs](https://example.com) and *compare* ~~old~~ styles")).toBe("Read the docs and compare old styles");
    expect(thinkingPreview("__Checking__ _styles_")).toBe("Checking styles");
    expect(thinkingPreview("Use `__init__` and `a ** b` in src/my_file.ts")).toBe("Use __init__ and a ** b in src/my_file.ts");
    expect(thinkingPreview("```ts\nconst value = 2 * 3;\n```")).toBe("const value = 2 * 3;");
    expect(thinkingPreview("**" + "x".repeat(300) + "**")).toBe("x".repeat(219) + "…");
  } finally {
    finish(); await app.service.settled(); unsubscribe();
    create.mockRestore(); settle.mockRestore(); dispose.mockRestore(); checkpoint.mockRestore();
  }
});

test("computer endpoints require a validated explicit agent identity", async () => {
  const { request, id } = await fixture();
  const response = await request("/api/control-session");
  const headers = { cookie: response.headers.get("set-cookie")!.split(";")[0]!, "x-jelly-csrf": (await response.json()).csrf };
  expect((await request("/api/computer", "GET", undefined, headers)).status).toBe(404);
  expect((await request("/api/computer/start?agentId=..%2Fcredentials", "POST", {}, headers)).status).toBe(404);
  const state = await request(`/api/computer?agentId=${id}`, "GET", undefined, headers);
  expect(state.status).toBe(200);
  expect((await state.json()).status).toBe("stopped");
  expect((await request(`/api/computer/close?agentId=${id}`, "POST", {}, headers)).status).toBe(200);
});

for (const authenticated of [false, true]) {
  test(`computer state reads ${authenticated ? "with" : "without"} cookies do not allocate browser sessions`, async () => {
    const { app, request } = await fixture();
    let headers: Record<string, string> | undefined;
    if (authenticated) {
      const session = await request("/api/control-session");
      headers = { cookie: session.headers.get("set-cookie")!.split(";")[0]! };
    }
    const createAgent = (name: string) => app.service.createAgent({ name, instructions: "Test", color: "#abc" });
    // Use disjoint agents for reads and allocations: reusing the read agents
    // would conceal get() allocating them as a side effect of the state route.
    for (let i = 0; i < 8; i++) {
      const agent = createAgent(`State reader ${i}`);
      const response = await request(`/api/computer?agentId=${agent.id}`, "GET", undefined, headers);
      expect(response.status).toBe(authenticated ? 200 : 401);
      if (authenticated) expect((await response.json()).status).toBe("stopped");
    }
    expect((await request("/api/computer?agentId=missing", "GET", undefined, headers)).status).toBe(authenticated ? 404 : 401);
    for (let i = 0; i < 8; i++) {
      const agent = createAgent(`Browser owner ${i}`);
      expect(app.service.computer.get(agent.id).state().status).toBe("stopped");
    }
    const overflow = createAgent("Overflow");
    expect(() => app.service.computer.get(overflow.id)).toThrow("limit 8");
  });
}
