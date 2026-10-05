import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startApp } from "./fixtures/app";
import { Store } from "../src/server/store";
import { SubagentStore } from "../src/server/subagent-store";
import type { SubagentSnapshot } from "../src/shared/subagents";

test("subagent APIs enforce control session/run ownership and retain history without transcript paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-subagent-api-"));
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
  });
  const store = app.service.store;
  const agent = store.agents()[0]!;
  const other = app.service.createAgent({
    name: "Other",
    instructions: "",
    color: "#aabbcc",
  });
  const run = store.createRun(
    agent.id,
    "fixture-run",
    "test",
    "api",
    "test-model",
  );
  const sessionFile = join(dir, "child.jsonl");
  writeFileSync(
    sessionFile,
    [
      { type: "session", version: 3, id: "child", cwd: dir },
      {
        type: "message",
        id: "a",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Checking the changes",
              thinkingSignature: "SECRET",
            },
            { type: "text", text: "Working" },
          ],
          stopReason: "stop",
        },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  const snapshot: SubagentSnapshot = {
    version: 1,
    updatedAt: 10,
    omitted: 0,
    children: [
      {
        id: "child-view",
        rootId: "root",
        childId: "writer",
        agent: "worker",
        label: "Writer",
        state: "running",
        inspectable: true,
      },
    ],
  };
  app.service.subagents.save(agent.id, run.id, snapshot, {
    "child-view": { sessionFile, roots: [dir] },
  });
  const base = `http://127.0.0.1:${app.server.port}`;
  const url = `/api/agents/${agent.id}/runs/${run.id}/subagents`;
  let closed = false;
  try {
    const unauthenticated = await fetch(base + url);
    expect(unauthenticated.status).toBe(401);
    expect(
      ((await unauthenticated.json()) as { error: string }).error,
    ).toContain("control session");
    const auth = await fetch(base + "/api/control-session");
    const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
    const get = (path: string) => fetch(base + path, { headers: { cookie } });
    const response = await get(url);
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain(dir);
    expect(raw).not.toContain("sessionFile");
    expect(JSON.parse(raw).children[0].label).toBe("Writer");
    expect((await get(url.replace(agent.id, other.id))).status).toBe(404);
    expect((await get(url + "/unknown/transcript")).status).toBe(404);
    expect((await get(url + "/child-view/transcript?before=-1")).status).toBe(
      400,
    );
    const transcript = await (await get(url + "/child-view/transcript")).text();
    expect(transcript).toContain("Checking the changes");
    expect(transcript).not.toContain("SECRET");
    expect(transcript).not.toContain(dir);
    app.service.emit(agent.id, run.id, "subagents_updated", { snapshot });
    expect(
      store.events().some((event) => event.type === "subagents_updated"),
    ).toBe(true);
    expect(
      store
        .historyPage(agent.id)
        .events.some((event) => event.type === "subagents_updated"),
    ).toBe(false);
    store.finishRun(run.id, "interrupted", "Fixture stopped");
    const stopped = (await (await get(url)).json()) as SubagentSnapshot;
    expect(stopped.children[0]?.state).toBe("unknown");
    expect(stopped.children[0]?.attention).toContain("no longer observed");
    await app.close();
    closed = true;
    const restored = new Store(join(dir, "jelly.sqlite"));
    try {
      const views = new SubagentStore(restored.db);
      expect(views.snapshot(agent.id, run.id).children[0]?.label).toBe(
        "Writer",
      );
      rmSync(sessionFile);
      expect(
        (await views.transcript(agent.id, run.id, "child-view")).unavailable,
      ).toBeTruthy();
    } finally {
      restored.close();
    }
  } finally {
    if (!closed) await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
