import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { controlHeaders } from "./fixtures/control-session";
async function launch(dir: string) {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/goals-server.ts"],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        JELLY_DATA_DIR: dir,
        JELLY_CONFIG_DIR: join(dir, "config"),
        JELLY_AUTH_FILE: join(dir, "auth.json"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = child.stdout.getReader();
  let log = "";
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done)
        throw new Error(
          `Goal fixture failed: ${log} ${await new Response(child.stderr).text()}`,
        );
      log += new TextDecoder().decode(part.value);
      const match = log.match(/Jelly goals fixture: (http:\/\/[^\s]+)/);
      if (match) {
        const origin = match[1]!,
          headers = await controlHeaders(origin);
        return {
          child,
          request: async (path: string, input?: unknown) => {
            const response = await fetch(origin + "/api" + path, {
              method: input ? "POST" : "GET",
              headers: { ...headers, "content-type": "application/json" },
              body: input ? JSON.stringify(input) : undefined,
            });
            if (!response.ok) throw new Error(await response.text());
            return response.json();
          },
        };
      }
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}
test("SIGKILL recovery pauses accepted goals without replay, preserves usage, and explicit resume admits only one new epoch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-goal-crash-"));
  let server: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    server = await launch(dir);
    const snapshot = await server.request("/state");
    const agentId = snapshot.agents[0].id;
    const path = `/agents/${agentId}/goal`;
    let { goal } = await server.request(path + "/create", {
      requestId: "create",
      objective: "Local crash fixture only",
      tokenBudget: 100000,
    });
    await server.request(path + "/resume", {
      goalId: goal.id,
      expectedRevision: goal.revision,
      requestId: "resume",
    });
    for (let i = 0; i < 200; i++) {
      ({ goal } = await server.request(path));
      if (goal.tokensUsed >= 18) break;
      await Bun.sleep(10);
    }
    expect(goal.tokensUsed).toBeGreaterThanOrEqual(18);
    server.child.kill("SIGKILL");
    await server.child.exited;
    server = await launch(dir);
    const recovered = (await server.request(path)).goal;
    expect(recovered.id).toBe(goal.id);
    expect(recovered.tokensUsed).toBeGreaterThanOrEqual(goal.tokensUsed);
    expect(recovered.state).toBe("paused");
    expect(recovered.reason).toContain("restarted");
    await Bun.sleep(300);
    expect((await server.request(path)).goal.tokensUsed).toBe(
      recovered.tokensUsed,
    );
    let state = await server.request(`/state?agentId=${agentId}`);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].status).toBe("interrupted");
    const input = {
      goalId: recovered.id,
      expectedRevision: recovered.revision,
      requestId: "new-epoch",
    };
    await server.request(path + "/resume", input);
    await server.request(path + "/resume", input);
    const current = (await server.request(path)).goal;
    await server.request(path + "/complete", {
      goalId: current.id,
      expectedRevision: current.revision,
      requestId: "complete",
      summary: "Operator inspected local crash fixture",
    });
    await Bun.sleep(400);
    state = await server.request(`/state?agentId=${agentId}`);
    expect(state.runs).toHaveLength(2);
    expect((await server.request(path)).goal.state).toBe("completed");
  } finally {
    if (server) {
      server.child.kill("SIGKILL");
      await server.child.exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
