import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Snapshot } from "../src/shared/types";
async function launch(dir: string) {
  const child = Bun.spawn(["bun", "tests/fixtures/server.ts"], {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      JELLY_DATA_DIR: dir,
      JELLY_CONFIG_DIR: join(dir, "config"),
      JELLY_AUTH_FILE: join(dir, "auth.json"),
      JELLY_PORT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let log = "";
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    while (true) {
      const part = await reader.read();
      if (part.done)
        throw new Error(
          `Server failed: ${log} ${await new Response(child.stderr).text()}`,
        );
      log += new TextDecoder().decode(part.value);
      const match = log.match(/Jelly server: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) return { child, url: match[1]! };
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}
test("a fresh process recovers SQLite identity, profiles, transcript and interrupted work after a crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-restart-"));
  let process = await launch(dir);
  const request = async (path: string, method = "GET", data?: unknown) => {
    const r = await fetch(process.url + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    expect(r.ok).toBe(true);
    return r.json();
  };
  const state = () => request("/api/state") as Promise<Snapshot>;
  async function waitFor(predicate: (s: Snapshot) => boolean) {
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      const s = await state();
      if (predicate(s)) return s;
      await Bun.sleep(10);
    }
    throw new Error("Timed out waiting for persisted run");
  }
  try {
    const initial = await state();
    const id = initial.agents[0]!.id;
    await request("/api/config", "PUT", { mode: "api" });
    await request(`/api/agents/${id}`, "PATCH", {
      name: "Persistent Jelly",

      instructions: "Remember the context",
      color: "#a4c8e8",
    });
    await request(`/api/agents/${id}/messages`, "POST", {
      text: "Remember the word marmalade",
      requestId: "first",
    });
    await waitFor((s) => s.runs[0]?.status === "completed");
    await request(`/api/agents/${id}/messages`, "POST", {
      text: "Interrupt this run",
      requestId: "interrupted",
    });
    await waitFor((s) =>
      s.events.some(
        (e) => e.type === "tool_started" && e.runId === s.runs[1]?.id,
      ),
    );
    process.child.kill("SIGKILL");
    await process.child.exited;
    process = await launch(dir);
    const recovered = await state();
    expect(recovered.instance.id).toBe(initial.instance.id);
    expect(recovered.agents[0]?.id).toBe(id);
    expect(recovered.agents[0]?.name).toBe("Persistent Jelly");
    expect(recovered.agents[0]?.instructions).toBe("Remember the context");
    expect(recovered.config.mode).toBe("api");
    expect(recovered.runs[0]?.status).toBe("completed");
    expect(recovered.runs[1]?.status).toBe("interrupted");
    expect(recovered.agents[0]?.status).toBe("interrupted");
    expect(
      recovered.events.some(
        (e) =>
          e.type === "message" && e.data.text === "Remember the word marmalade",
      ),
    ).toBe(true);
    expect(recovered.events.at(-1)?.type).toBe("run_interrupted");
    await request(`/api/agents/${id}/messages`, "POST", {
      text: "Continue after restart",
      requestId: "third",
    });
    const continued = await waitFor((s) => s.runs[2]?.status === "completed");
    expect(
      continued.events.filter((e) => e.type === "message").at(-1)?.data.text,
    ).toContain("2 saved user messages");
    expect(continued.agents[0]?.status).toBe("idle");
  } finally {
    process.child.kill("SIGTERM");
    await process.child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
