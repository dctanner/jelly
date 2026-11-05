import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { controlHeaders } from "./fixtures/control-session";

async function launch(dir: string) {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/human-todos-server.ts"],
    {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, JELLY_DATA_DIR: dir },
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
          `Fixture failed: ${log} ${await new Response(child.stderr).text()}`,
        );
      log += new TextDecoder().decode(part.value);
      const match = log.match(/Jelly human todos fixture: (http:\/\/[^\s]+)/);
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
test("SIGKILL before and after admission preserves completion, requires explicit retry and never replays uncertain effects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-todo-crash-"));
  let server: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    server = await launch(dir);
    const agentId = (await server.request("/state")).agents[0].id;
    const create = {
      requestId: "create",
      title: "Durable human action",
      agentId,
    };
    const { todo } = await server.request("/human-todos", create);
    await server.request(`/agents/${agentId}/messages`, {
      requestId: "busy",
      text: "Disposable busy work",
    });
    const completion = {
      requestId: "complete",
      expectedRevision: 1,
      continueAgent: true,
      resolutionNote: "Human attestation",
    };
    const receipt = await server.request(
      `/human-todos/${todo.id}/complete`,
      completion,
    );
    expect(
      (await server.request(`/human-todos/${todo.id}`)).delivery.state,
    ).toBe("waiting");
    server.child.kill("SIGKILL");
    await server.child.exited;
    server = await launch(dir);
    let detail = await server.request(`/human-todos/${todo.id}`);
    expect(detail.todo.status).toBe("done");
    expect(detail.todo.resolutionNote).toBe("Human attestation");
    expect(detail.delivery.state).toBe("needs_retry");
    expect(detail.delivery.id).toBe(receipt.delivery.id);
    expect(
      await server.request(`/human-todos/${todo.id}/complete`, completion),
    ).toEqual(receipt);
    expect(
      (await server.request(`/human-todos/${todo.id}`)).delivery.state,
    ).toBe("needs_retry");
    const confirm = {
      requestId: "retry",
      expectedRevision: detail.todo.revision,
    };
    await server.request(`/human-todos/${todo.id}/continue`, confirm);
    detail = await server.request(`/human-todos/${todo.id}`);
    expect(detail.delivery.state).toBe("admitted");
    const admittedId = detail.delivery.runId;
    expect(detail.run.status).toBe("running");
    server.child.kill("SIGKILL");
    await server.child.exited;
    server = await launch(dir);
    detail = await server.request(`/human-todos/${todo.id}`);
    expect(detail.delivery.state).toBe("admitted");
    expect(detail.delivery.runId).toBe(admittedId);
    expect(detail.run.status).toBe("interrupted");
    await server.request(`/human-todos/${todo.id}/continue`, confirm);
    const snapshot = await server.request(`/state?agentId=${agentId}`);
    expect(
      snapshot.runs.filter((run: any) => run.source?.source === "human_todo"),
    ).toHaveLength(1);
    expect((await server.request("/human-todos", create)).todo.id).toBe(
      todo.id,
    );
  } finally {
    if (server) {
      server.child.kill("SIGKILL");
      await server.child.exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
