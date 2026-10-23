import { startApp as startProductionApp } from "../src/server/app";
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createClaudeCodeProvider,
  streamClaudeCode,
} from "@earendil-works/pi-claude-code/src/index.ts";
import { CLAUDE_CODE_MODELS } from "@earendil-works/pi-claude-code/src/model-catalog.ts";
import {
  describeUsageCreditsRejection,
  usageCreditsAllowed,
} from "@earendil-works/pi-claude-code/src/billing.ts";
import { ClaudeCodeConnection } from "../src/server/claude-code";
import { createJellyClaudeProvider } from "../src/server/claude-code-provider";
import { Store } from "../src/server/store";
import { preparePi } from "../src/server/pi-setup";
import { effortsForModel, modelsForMode } from "../src/shared/models";
import { startApp } from "./fixtures/app";
import { fixtureModel, fixtureStream } from "./fixtures/model";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-claude-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(delay = 1) {
  const dir = directory();
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
    fixtureDelayMs: delay,
  });
  cleanups.push(() => app.close());
  const url = `http://127.0.0.1:${app.server.port}`;
  const bootstrap = await fetch(`${url}/api/control-session`);
  const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
  const { csrf } = await bootstrap.json();
  const request = (path: string, method = "GET", body?: unknown) =>
    fetch(`${url}/api${path}`, {
      method,
      headers: {
        cookie,
        "x-jelly-csrf": csrf,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { app, dir, request, id: app.store.agents()[0]!.id };
}
function fakeClaude(app: Awaited<ReturnType<typeof startApp>>, delay = 1) {
  let ready = true;
  app.service.harness.claude.status = () => ({
    claudeReady: ready,
    claudeNotice: ready
      ? "Claude fixture ready"
      : "Claude fixture disconnected; check Settings",
  });
  app.service.harness.runtime.registerProvider("claude-code", {
    api: "openai-responses",
    baseUrl: fixtureModel.baseUrl,
    apiKey: "test-only",
    models: modelsForMode("claude-code").map(({ id }) => ({
      ...fixtureModel,
      id,
    })),
    streamSimple: fixtureStream(delay),
  });
  return (next: boolean) => {
    ready = next;
  };
}

test("Claude status is explicit, bounded, coalesced and never inferred from CLI presence", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const check = mock(async () => {
    await gate;
    return { available: true, loggedIn: true, subscription: true };
  });
  const connection = new ClaudeCodeConnection(check, () => ({}));
  for (let i = 0; i < 50; i++)
    expect(connection.status().claudeReady).toBe(false);
  expect(check).not.toHaveBeenCalled();
  const first = connection.refresh();
  expect(connection.refresh(true)).toBe(first);
  release();
  expect((await first).claudeReady).toBe(true);
  await connection.refresh();
  await connection.refresh(true);
  expect(check).toHaveBeenCalledTimes(1);
  for (const result of [
    { available: false, loggedIn: false, subscription: false },
    { available: true, loggedIn: false, subscription: false },
    { available: true, loggedIn: true, subscription: false },
  ]) {
    const status = await new ClaudeCodeConnection(
      async () => result,
      () => ({}),
    ).refresh();
    expect(status.claudeReady).toBe(false);
    expect(status.claudeNotice).toMatch(/install|login/i);
  }
  const failed = await new ClaudeCodeConnection(
    async () => {
      throw new Error("secret CLI stderr");
    },
    () => ({}),
  ).refresh();
  expect(failed.claudeNotice).not.toContain("secret");
});

test("Claude subscription auth, backend override and billing guards remain upstream-owned", async () => {
  const provider = createClaudeCodeProvider();
  expect(provider.auth?.oauth?.isSubscription).toBe(true);
  await expect(provider.auth!.oauth!.login({} as never)).rejects.toThrow(
    "claude auth login",
  );
  expect(usageCreditsAllowed({})).toBe(false);
  expect(
    describeUsageCreditsRejection(
      "third-party apps now draw from your extra usage",
    ),
  ).toContain("will not retry");
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ]) {
    const status = new ClaudeCodeConnection(
      async () => ({ available: true, loggedIn: true, subscription: true }),
      () => ({ [key]: "1" }),
    );
    await status.refresh();
    expect(status.status().claudeReady).toBe(false);
    expect(status.status().claudeNotice).toContain(key);
    // Upstream rejects before resolving/spawning the CLI or making any request.
    const result = await streamClaudeCode(
      CLAUDE_CODE_MODELS[1]!,
      normalizeContext({
        messages: [{ role: "user", content: "Never sent", timestamp: 0 }],
      }),
      { env: { [key]: "1" } },
    ).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      "refuses conflicting auth/backend overrides",
    );
  }
});

test("request auth rechecks subscription on every call, including scoped config and OAuth markers", async () => {
  let subscribed = true;
  const check = mock(async (_env: Record<string, string | undefined>, signal: AbortSignal) => {
    expect(signal.aborted).toBe(false);
    return { available: true, loggedIn: true, subscription: subscribed };
  });
  const provider = createJellyClaudeProvider(check);
  const input = {
    ctx: {
      env: async (name: string) => name === "PI_CLAUDE_CODE_CONFIG_DIR" ? "/fixture/claude-config" : undefined,
      fileExists: async () => false,
    },
    signal: new AbortController().signal,
  };
  expect(await provider.auth.apiKey.resolve(input)).toBeDefined();
  expect(check.mock.calls[0]![0].PI_CLAUDE_CODE_CONFIG_DIR).toBe("/fixture/claude-config");
  // Even an immediately subsequent request must not reuse startup/UI readiness.
  subscribed = false;
  await expect(provider.auth.apiKey.resolve(input)).rejects.toThrow("No model request was sent");
  expect(check).toHaveBeenCalledTimes(2);
  const marker = { type: "oauth" as const, access: "external", refresh: "external", expires: Date.now() + 3600000 };
  await expect(provider.auth.oauth.toAuth(marker)).rejects.toThrow("subscription login is required");
  subscribed = true;
  expect(await provider.auth.apiKey.resolve(input)).toBeDefined();
  const failing = createJellyClaudeProvider(async () => { throw new Error("secret stderr"); });
  await expect(failing.auth.apiKey.resolve(input)).rejects.toThrow("could not be verified");
  await expect(failing.auth.apiKey.resolve(input)).rejects.not.toThrow("secret stderr");
  const aborted = { ...input, signal: AbortSignal.abort() };
  await expect(provider.auth.apiKey.resolve(aborted)).rejects.toThrow();
  expect(check).toHaveBeenCalledTimes(4);
});

function namingReply(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", api: "claude-code", provider: "claude-code", model: "claude-opus-5-5",
    content: [{ type: "text", text: "Code Reviewer" }], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...overrides,
  };
}

test("Claude automatically names a new agent once with an unthemed, tool-free request", async () => {
  const { app } = await fixture();
  fakeClaude(app);
  app.service.setMode("claude-code");
  const agent = app.service.createAgent({ name: "New Agent", instructions: "", color: "#fff" });
  const complete = spyOn(app.service.harness.runtime, "completeSimple").mockResolvedValue(namingReply());
  const create = spyOn(app.service.harness, "create");
  try {
    app.service.start(agent.id, "claude-naming", "Review my code");
    await app.service.settled();
    expect(complete).toHaveBeenCalledTimes(1);
    const [model, context, options] = complete.mock.calls[0]!;
    expect(model.provider).toBe("claude-code");
    expect(context.systemPrompt).toContain("Base the name on the task without imposing a theme");
    expect(context.systemPrompt).not.toMatch(/sea-themed|ocean|sea-creature|Coral Coder|Octopus Organizer/i);
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]).toMatchObject({ role: "user", content: "Review my code" });
    expect(context.tools).toBeUndefined();
    expect(options).toMatchObject({ reasoning: "low", maxRetries: 0 });
    expect(app.store.agent(agent.id)?.name).toBe("Code Reviewer");
    expect(create.mock.calls[0]![0].name).toBe("Code Reviewer");
    expect(app.store.runs(agent.id)[0]?.status).toBe("completed");
    app.service.start(agent.id, "claude-naming-next", "Continue reviewing");
    await app.service.settled();
    expect(complete).toHaveBeenCalledTimes(1);
  } finally {
    complete.mockRestore();
    create.mockRestore();
  }
});

test.each(["returned billing", "thrown billing", "auth", "aborted"])(
  "Claude naming %s failure stops the task and queued work with a visible error",
  async (kind) => {
    const { app } = await fixture();
    fakeClaude(app);
    app.service.setMode("claude-code");
    const agent = app.service.createAgent({ name: "New Agent", instructions: "", color: "#fff" });
    const error = kind === "auth" ? "Claude subscription login is required" : kind === "aborted" ? "Naming timed out" : "Claude Code billing: usage credits; will not retry";
    const complete = spyOn(app.service.harness.runtime, "completeSimple").mockImplementation(async () => {
      if (kind === "thrown billing" || kind === "auth") throw new Error(error);
      return namingReply({ stopReason: kind === "aborted" ? "aborted" : "error", errorMessage: error });
    });
    const create = spyOn(app.service.harness, "create");
    try {
      app.service.start(agent.id, "naming-failure", "Review code");
      app.service.start(agent.id, "queued-after-naming", "Do more work");
      await app.service.settled();
      expect(complete).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
      expect(app.store.agent(agent.id)?.name).toBe("New Agent");
      expect(app.store.runs(agent.id)).toHaveLength(1);
      expect(app.store.runs(agent.id)[0]).toMatchObject({ status: "failed", error });
      expect(app.store.pendingMessage("queued-after-naming")?.status).toBe("cancelled");
      expect(app.service.snapshot(agent.id).events.some(event => event.type === "run_failed" && event.data.error === error)).toBe(true);
    } finally {
      complete.mockRestore();
      create.mockRestore();
    }
  },
);

test("Claude model and effort choices match the pinned explicit upstream catalog", () => {
  for (const model of modelsForMode("claude-code")) {
    const upstream = CLAUDE_CODE_MODELS.find(
      (option) => option.id === model.id,
    )!;
    expect(upstream).toBeDefined();
    expect(upstream.reasoning).toBe(true);
    for (const effort of effortsForModel(model.id))
      expect(upstream.thinkingLevelMap?.[effort.id]).not.toBeNull();
  }
  expect(
    modelsForMode("api").every((model) => model.id.startsWith("gpt-")),
  ).toBe(true);
});

test("pre-session selection, coexistence and selected-agent readiness ignore new-agent defaults", async () => {
  const { app, request, id } = await fixture();
  fakeClaude(app);
  const original = app.store.agent(id)!;
  expect(
    (await request("/config", "PUT", { agentId: id, mode: "claude-code" }))
      .status,
  ).toBe(200);
  expect(app.store.agent(id)).toMatchObject({
    mode: "claude-code",
    model: "claude-opus-5-5",
    providerLocked: 0,
  });
  const claude = app.service.createAgent({
    name: "Claude",
    instructions: "",
    color: "#fff",
  });
  app.service.setConfig({ mode: "chatgpt" });
  expect(app.store.agent(id)?.mode).toBe("claude-code");
  expect(app.store.agent(claude.id)?.mode).toBe("claude-code");
  expect(app.service.snapshot(id)).toMatchObject({
    config: { mode: "chatgpt", ready: false },
    agentConfig: { mode: "claude-code", ready: true },
  });
  expect(
    (await request("/config", "PUT", { agentId: id, model: original.model }))
      .status,
  ).toBe(400);
  expect(
    (await request("/config", "PUT", { mode: "api", model: "claude-sonnet-5" }))
      .status,
  ).toBe(400);
  expect(
    (await request("/config", "PUT", { agentId: id, effort: "off" })).status,
  ).toBe(400);
  expect(
    (await request("/config", "PUT", { agentId: id, mode: "api" })).status,
  ).toBe(200);
  expect(app.store.agent(id)).toMatchObject({
    mode: "api",
    model: "gpt-6-astra",
  });
  expect(app.store.agent(claude.id)?.mode).toBe("claude-code");
});

test.each(["failed", "cancelled"] as const)(
  "first accepted %s run pins Auto atomically, survives restart and rejects API switching",
  async (outcome) => {
    const { app, request, id, dir } = await fixture();
    const create = spyOn(app.service.harness, "create").mockRejectedValue(
      new Error("fixture failure"),
    );
    app.service.setConfig({ agentId: id, mode: "auto" });
    const started = app.service.start(id, "first", "Hello");
    expect(app.store.agent(id)).toMatchObject({
      mode: "api",
      providerLocked: 1,
    });
    if (outcome === "cancelled") app.service.stop(id);
    await app.service.settled();
    create.mockRestore();
    expect(app.store.run(started.run!.id)?.status).toBe(outcome);
    for (const mode of ["auto", "chatgpt", "claude-code"]) {
      const response = await request("/config", "PUT", { agentId: id, mode });
      expect(response.status).toBe(409);
      expect(await response.text()).toContain("new agent");
    }
    fakeClaude(app);
    app.service.setMode("claude-code");
    app.service.harness.auth.hasAuth = (provider) =>
      provider === "openai-codex";
    expect(app.service.snapshot(id).agentConfig).toMatchObject({
      mode: "api",
      ready: false,
    });
    expect(() =>
      app.service.start(id, "after-disconnect", "No fallback"),
    ).toThrow("OpenAI API");
    expect(() => app.service.freshSession(id, "fresh-disconnected")).toThrow(
      "OpenAI API",
    );
    const reader = new Store(join(dir, "jelly.sqlite"));
    try {
      expect(reader.agent(id)).toMatchObject({
        mode: "api",
        providerLocked: 1,
      });
      expect(() =>
        reader.setAgentConfig(id, "claude-sonnet-5", "high", "claude-code"),
      ).toThrow("locked");
      expect(() =>
        reader.createRun(
          id,
          "wrong",
          "Wrong provider",
          "chatgpt",
          "gpt-6-astra",
        ),
      ).toThrow("locked");
    } finally {
      reader.close();
    }
  },
);

test("Claude active and queued runs capture model/effort, keep provider, and auth removal never falls back", async () => {
  const { app, id } = await fixture();
  const readiness = fakeClaude(app, 20);
  app.service.setConfig({
    agentId: id,
    mode: "claude-code",
    model: "claude-sonnet-5",
    effort: "low",
  });
  const create = spyOn(app.service.harness, "create");
  try {
    app.service.start(id, "claude-first", "First");
    app.service.start(id, "claude-next", "Second");
    app.service.setConfig({
      agentId: id,
      model: "claude-opus-5-5",
      effort: "max",
    });
    app.service.setMode("api");
    expect(() => app.service.setConfig({ agentId: id, mode: "api" })).toThrow(
      "locked",
    );
    await app.service.settled();
    expect(
      app.store.runs(id).map((run) => [run.mode, run.model, run.status]),
    ).toEqual([
      ["claude-code", "claude-sonnet-5", "completed"],
      ["claude-code", "claude-opus-5-5", "completed"],
    ]);
    expect(
      create.mock.calls.map((call) => [
        call[2].provider,
        call[2].selectedModel,
        call[2].effort,
      ]),
    ).toEqual([
      ["claude-code", "claude-sonnet-5", "low"],
      ["claude-code", "claude-opus-5-5", "max"],
    ]);
    readiness(false);
    expect(() => app.service.start(id, "no-fallback", "Third")).toThrow(
      "Settings",
    );
    expect(app.service.snapshot(id)).toMatchObject({
      config: { ready: true, mode: "api" },
      agentConfig: { ready: false, mode: "claude-code" },
    });
  } finally {
    create.mockRestore();
  }
});

test.each([12, 15])(
  "schema v%s pins latest recorded run, including failed/cancelled and archived sessions, never current credentials",
  (version) => {
    const path = join(directory(), "jelly.sqlite");
    let store = new Store(path);
    const profile = { name: "Legacy", instructions: "", color: "#fff" };
    const used = store.addAgent(profile),
      unknown = store.addAgent(profile),
      unused = store.addAgent(profile);
    const first = store.createRun(
      used.id,
      "first",
      "First",
      "api",
      "gpt-6-astra",
    );
    store.finishRun(first.id, "completed", null);
    const last = store.createRun(used.id, "last", "Last", "api", "gpt-6-astra");
    // Represent a pre-lock historical switch; migration must use the latest run, not the first.
    store.db
      .query("UPDATE runs SET mode='chatgpt',status='cancelled' WHERE id=?")
      .run(last.id);
    store.archiveAgent(used.id, true);
    const legacy = store.createRun(
      unknown.id,
      "unknown",
      "Old demo",
      "demo",
      "local-demo",
    );
    store.finishRun(legacy.id, "failed", "old fixture");
    store.setMode("api");
    store.db.exec(
      `ALTER TABLE agents DROP COLUMN mode; ALTER TABLE agents DROP COLUMN providerLocked; PRAGMA user_version=${version};`,
    );
    store.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      store = new Store(path);
      try {
        expect(store.agent(used.id)).toMatchObject({
          mode: "chatgpt",
          providerLocked: 1,
        });
        expect(store.agent(unknown.id)).toMatchObject({
          mode: "auto",
          providerLocked: 1,
        });
        expect(store.agent(unused.id)).toMatchObject({
          mode: "api",
          providerLocked: 0,
        });
        expect(store.runs(used.id).map((run) => run.mode)).toEqual([
          "api",
          "chatgpt",
        ]);
        expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
        store.setMode("claude-code");
      } finally {
        store.close();
      }
    }
  },
);

test("detached native Pi discovers Claude while shared harness sessions never re-register its provider", async () => {
  const { app, dir, id } = await fixture();
  preparePi(dir);
  preparePi(dir);
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(
    settings.extensions.filter((path: string) =>
      path.endsWith("/claude-code-provider.ts"),
    ),
  ).toHaveLength(1);
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.create(dir, dir),
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  expect(
    loader
      .getExtensions()
      .runtime.pendingNativeProviderRegistrations.map(
        (entry) => entry.provider.id,
      ),
  ).toContain("claude-code");
  const childProvider = loader.getExtensions().runtime.pendingNativeProviderRegistrations
    .find(entry => entry.provider.id === "claude-code")!.provider;
  await expect(childProvider.auth!.apiKey!.resolve({
    ctx: {
      env: async name => name === "PI_CLAUDE_CODE_COMMAND" ? join(dir, "missing-claude") : undefined,
      fileExists: async () => false,
    },
    signal: new AbortController().signal,
  })).rejects.toThrow("subscription login is required");
  const registered =
    app.service.harness.runtime.getRegisteredNativeProvider("claude-code");
  await expect(registered!.auth!.apiKey!.resolve({
    ctx: {
      env: async name => name === "PI_CLAUDE_CODE_COMMAND" ? join(dir, "missing-claude") : undefined,
      fileExists: async () => false,
    },
    signal: new AbortController().signal,
  })).rejects.toThrow("subscription login is required");
  const register = spyOn(app.service.harness.runtime, "registerNativeProvider");
  try {
    for (let count = 0; count < 2; count++) {
      app.service.start(id, `session-${count}`, "Fixture");
      await app.service.settled();
    }
    expect(
      register.mock.calls.filter(([provider]) => provider.id === "claude-code"),
    ).toHaveLength(0);
    expect(
      app.service.harness.runtime.getRegisteredNativeProvider("claude-code"),
    ).toBe(registered);
  } finally {
    register.mockRestore();
  }
});

test("ChatGPT and Claude run side by side, and disconnecting either never retargets a pinned or explicitly selected agent", async () => {
  const { app, id, request } = await fixture();
  const setClaudeReady = fakeClaude(app);
  const harness = app.service.harness;
  harness.runtime.registerProvider("openai-codex", {
    api: "openai-responses",
    baseUrl: fixtureModel.baseUrl,
    apiKey: "test-only-chatgpt",
    models: modelsForMode("chatgpt").map(({ id }) => ({ ...fixtureModel, id })),
    streamSimple: fixtureStream(1),
  });
  let chatgptReady = true;
  harness.auth.hasAuth = (provider) =>
    provider === "openai-codex" ? chatgptReady : provider === "openai";
  app.service.setConfig({ agentId: id, mode: "chatgpt" });
  const unstarted = app.service.createAgent({
    name: "Explicit ChatGPT",
    instructions: "",
    color: "#fff",
  });
  app.service.setMode("claude-code");
  const claude = app.service.createAgent({
    name: "Claude",
    instructions: "",
    color: "#fff",
  });
  app.service.start(id, "chatgpt", "Hello ChatGPT fixture");
  app.service.start(claude.id, "claude", "Hello Claude fixture");
  await app.service.settled();
  expect(app.store.runs(id)[0]).toMatchObject({
    mode: "chatgpt",
    status: "completed",
  });
  expect(app.store.runs(claude.id)[0]).toMatchObject({
    mode: "claude-code",
    status: "completed",
  });
  expect(app.service.snapshot(id).agentConfig).toMatchObject({
    chatgptReady: true,
    claudeReady: true,
  });
  chatgptReady = false;
  expect(
    (
      await request(`/agents/${id}/messages`, "POST", {
        requestId: "disconnected",
        text: "Do not fall back",
      })
    ).status,
  ).toBe(409);
  expect(app.service.snapshot(unstarted.id).agentConfig).toMatchObject({
    mode: "chatgpt",
    ready: false,
  });
  expect(app.store.agent(unstarted.id)).toMatchObject({
    mode: "chatgpt",
    providerLocked: 0,
  });
  expect(app.service.snapshot(claude.id).agentConfig?.ready).toBe(true);
  setClaudeReady(false);
  chatgptReady = true;
  expect(
    (
      await request(`/agents/${claude.id}/messages`, "POST", {
        requestId: "claude-disconnected",
        text: "Do not fall back",
      })
    ).status,
  ).toBe(409);
  expect(
    (await request("/config", "PUT", { agentId: claude.id, mode: "chatgpt" }))
      .status,
  ).toBe(409);
  expect(app.service.snapshot(id).agentConfig?.ready).toBe(true);
});

test("Claude queued work is cancelled rather than rerouted when its subscription disappears", async () => {
  const { app, id } = await fixture();
  const setReady = fakeClaude(app, 15);
  app.service.setConfig({ agentId: id, mode: "claude-code" });
  let removed = false;
  const unsubscribe = app.service.subscribe((event) => {
    if (!removed && event.type === "tool_started") {
      removed = true;
      app.service.start(id, "queued-claude", "Keep unsent");
      setReady(false);
      app.service.setMode("api");
    }
  });
  try {
    app.service.start(id, "active-claude", "First");
    await app.service.settled();
    expect(removed).toBe(true);
    expect(app.store.runs(id)).toHaveLength(1);
    expect(app.store.runs(id)[0]).toMatchObject({
      mode: "claude-code",
      status: "completed",
    });
    expect(app.store.pendingMessage("queued-claude")?.status).toBe("cancelled");
    expect(app.store.agent(id)).toMatchObject({
      mode: "claude-code",
      providerLocked: 1,
    });
  } finally {
    unsubscribe();
  }
});

test("startup and restart check Claude once before serving restored agents, with no snapshot probes", async () => {
  const dir = directory();
  const check = mock(async () => ({
    available: true,
    loggedIn: true,
    subscription: true,
  }));
  const options = {
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
    claudeStatusCheck: check,
  };
  let app = await startProductionApp(options);
  let closed = false;
  cleanups.push(async () => {
    if (!closed) await app.close();
  });
  const id = app.store.agents()[0]!.id;
  app.service.setConfig({ agentId: id, mode: "claude-code" });
  const run = app.store.createRun(
    id,
    "persisted",
    "Fixture",
    "claude-code",
    "claude-opus-5-5",
  );
  app.store.finishRun(run.id, "failed", "Fixture only");
  expect(app.service.snapshot(id).agentConfig).toMatchObject({
    ready: true,
    mode: "claude-code",
  });
  expect(check).toHaveBeenCalledTimes(1);
  expect(
    app.service.harness.runtime
      .getAvailableSnapshot()
      .some((model) => model.provider === "claude-code"),
  ).toBe(true);
  await app.close();
  closed = true;
  app = await startProductionApp(options);
  closed = false;
  expect(check).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 50; i++) {
    expect(app.service.snapshot(id).agentConfig).toMatchObject({
      ready: true,
      mode: "claude-code",
    });
  }
  expect(check).toHaveBeenCalledTimes(2);
  expect(app.store.agent(id)).toMatchObject({
    mode: "claude-code",
    providerLocked: 1,
  });
});
