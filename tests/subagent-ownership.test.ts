import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSync } from "../node_modules/pi-subagents/src/runs/foreground/execution.js";
import {
  createDefaultChildSessionFactory,
  createOwnedChildSessionFactory,
  type ChildSessionLaunch,
  type PiCodingAgentModule,
} from "../node_modules/pi-subagents/src/runs/shared/child-session.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Exercise the installed factory without model requests, file-backed sessions,
// environment mutation, or production resources. Each owner gets its own real
// default factory; only the underlying Pi session is a test double.
function fixture() {
  const events: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const started = new Map<string, ReturnType<typeof deferred>>();
  const sdk = {
    ModelRuntime: { create: async () => ({}) },
    SettingsManager: { create: () => ({ getTheme: () => "dark" }) },
    DefaultResourceLoader: class {
      loaded = false;
      async reload() {}
      getExtensions() { return { errors: [], runtime: {} }; }
    },
    SessionManager: { inMemory: (cwd: string) => ({ cwd }) },
    async createAgentSession(options: { cwd: string }) {
      const id = options.cwd;
      events.push(`create:${id}`);
      started.get(id)?.resolve();
      await gates.get(id)?.promise;
      return { session: {
        agent: {}, messages: [], sessionId: id,
        extensionRunner: { hasHandlers: () => false },
        async bindExtensions() {},
        subscribe: () => () => {},
        async prompt() { events.push(`prompt:${id}`); },
        async steer() {}, async followUp() {},
        async abort() { events.push(`abort:${id}`); },
        dispose() { events.push(`dispose:${id}`); },
      } };
    },
  } as unknown as PiCodingAgentModule;
  const owner = () => createOwnedChildSessionFactory(
    createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk }),
  );
  const launch = (cwd: string): ChildSessionLaunch => ({
    cwd, storage: { kind: "memory" }, extensionPaths: [],
    ambientExtensions: false, hooks: [], noSkills: true, noContextFiles: true,
    runtime: {} as ChildSessionLaunch["runtime"],
  });
  return { events, gates, started, owner, launch };
}

describe("parent-scoped native child shutdown", () => {
  test("shutdown cancels only its owner's children and is idempotent", async () => {
    const f = fixture(), a = f.owner(), b = f.owner();
    const a1 = await a.create(f.launch("a1"));
    const a2 = await a.create(f.launch("a2"));
    const b1 = await b.create(f.launch("b1"));
    try {
      // Ordinary child completion must not close its siblings or another owner.
      await a1.dispose();
      expect(f.events).not.toContain("abort:a2");
      expect(f.events).not.toContain("abort:b1");
      const closing = a.dispose();
      expect(a.dispose()).toBe(closing);
      await closing;
      expect(a2.shutDown).toBe(true);
      expect(b1.shutDown).toBeUndefined();
      expect(f.events).toContain("abort:a2");
      expect(f.events).not.toContain("abort:b1");
      await b1.prompt("continue");
      expect(f.events).toContain("prompt:b1");
      await expect(a.create(f.launch("late"))).rejects.toThrow("parent session shut down");
      expect(f.events).not.toContain("create:late");
      await b.dispose();
      expect(b1.shutDown).toBe(true);
      expect(f.events.filter((e) => e === "dispose:b1")).toHaveLength(1);
    } finally {
      await Promise.all([a.dispose(), b.dispose()]);
    }
  });

  test("shutdown drains an in-flight creation without returning an orphan", async () => {
    const f = fixture(), a = f.owner(), b = f.owner();
    const other = await b.create(f.launch("other"));
    const gate = deferred(), started = deferred();
    f.gates.set("pending", gate); f.started.set("pending", started);
    const creation = a.create(f.launch("pending"));
    const outcome = creation.then(() => "unexpected success", (error: Error) => error.message);
    await started.promise;
    let closed = false;
    const closing = a.dispose().then(() => { closed = true; });
    try {
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(other.shutDown).toBeUndefined();
      gate.resolve();
      expect(await outcome).toContain("parent session shut down");
      await closing;
      expect(f.events).toContain("abort:pending");
      expect(f.events).toContain("dispose:pending");
      expect(f.events).not.toContain("prompt:pending");
      expect(f.events).not.toContain("abort:other");
    } finally {
      gate.resolve();
      await Promise.all([closing, b.dispose()]);
    }
  });

  test("failed creation settles shutdown and keeps admission closed", async () => {
    const f = fixture(), a = f.owner();
    const gate = deferred(), started = deferred();
    f.gates.set("fails", gate); f.started.set("fails", started);
    const creation = a.create(f.launch("fails"));
    const outcome = creation.catch((error: Error) => error.message);
    await started.promise;
    const closing = a.dispose();
    gate.reject(new Error("fixture creation failure"));
    expect(await outcome).toBe("fixture creation failure");
    await closing;
    await expect(a.create(f.launch("late"))).rejects.toThrow("parent session shut down");
    expect(f.events).not.toContain("create:late");
  });

  test("shutdown before queued creation starts prevents the launch", async () => {
    const f = fixture(), a = f.owner();
    const creation = a.create(f.launch("queued"));
    const outcome = creation.catch((error: Error) => error.message);
    await a.dispose();
    expect(await outcome).toContain("parent session shut down");
    expect(f.events).toEqual([]);
  });

  test("detachment during creation is refused before any accepted receipt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "jelly-detach-creation-"));
    const f = fixture(), owner = f.owner();
    const gate = deferred(), started = deferred();
    f.gates.set(cwd, gate); f.started.set(cwd, started);
    let detach!: (reason?: string) => boolean;
    const run = runSync(cwd, [{
      name: "fixture", description: "No provider calls", source: "project",
      filePath: join(cwd, "fixture.md"), systemPrompt: "Fixture",
      systemPromptMode: "replace", inheritProjectContext: false,
      inheritGlobalContext: false, inheritSkills: false, tools: [],
    }], "fixture", "Wait for creation", {
      runId: crypto.randomUUID(), childSessionFactory: owner,
      acceptance: false, timeoutMs: 5000,
      onDetachReady: (callback) => { detach = callback; },
    });
    try {
      await started.promise;
      // The real foreground executor publishes this callback before create()
      // settles. A true return publishes a detached receipt to its caller.
      expect(detach("user request")).toBe(false);
      const closing = owner.dispose();
      gate.resolve();
      await closing;
      const result = await run;
      expect(result.detached).not.toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain("parent session shut down");
      expect(f.events).not.toContain(`prompt:${cwd}`);
      expect(f.events).toContain(`dispose:${cwd}`);
    } finally {
      gate.resolve();
      await owner.dispose();
      await run;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("explicitly detached children retain their existing lifecycle", async () => {
    const f = fixture(), a = f.owner();
    const child = await a.create(f.launch("detached"));
    child.detached = true;
    try {
      await a.dispose();
      expect(child.shutDown).toBeUndefined();
      expect(f.events).not.toContain("abort:detached");
      expect(f.events).not.toContain("dispose:detached");
      await child.prompt("continue detached");
    } finally {
      await child.dispose();
    }
    expect(f.events).toContain("dispose:detached");
  });
});
