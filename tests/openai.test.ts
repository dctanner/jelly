import { zstdDecompressSync } from "node:zlib";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/server/app";
import { ultrafastOptions } from "../src/server/ultrafast";
import { getModel } from "@earendil-works/pi-ai/compat";

test("Ultrafast preserves payload hooks and does not affect other models", async () => {
  const astra = getModel("openai", "gpt-6-astra")!;
  const sol = getModel("openai", "gpt-6-sol")!;
  const options = ultrafastOptions({
    onPayload: async (payload: unknown) => ({ ...(payload as object), instructions: "preserved" }),
  });
  expect(await options.onPayload!({ model: astra.id }, astra)).toEqual({
    model: astra.id, instructions: "preserved", service_tier: "ultrafast",
  });
  expect(await options.onPayload!({ model: sol.id }, sol)).toEqual({
    model: sol.id, instructions: "preserved",
  });
});
for (const mode of ["api", "chatgpt"] as const)
  test(`the ${mode} adapter sends GPT-6 model and effort choices, tools and history to Responses`, async () => {
    const provider = mode === "api" ? "openai" : "openai-codex";
    const token =
      mode === "api"
        ? "jelly-local-test-key"
        : `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
    const requests: { path: string; auth: string | null; body: any }[] = [];
    let denyUltrafast = false;
    const fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        if (req.method !== "POST")
          return new Response("Use SSE", { status: 426 });
        requests.push({
          path: new URL(req.url).pathname,
          auth: req.headers.get("authorization"),
          body:
            req.headers.get("content-encoding") === "zstd"
              ? JSON.parse(
                  zstdDecompressSync(
                    Buffer.from(await req.arrayBuffer()),
                  ).toString(),
                )
              : await req.json(),
        });
        if (denyUltrafast && requests.at(-1)?.body.service_tier === "ultrafast")
          return Response.json({ error: { message: "Ultrafast is not enabled for this account", type: "invalid_request_error" } }, { status: 403 });
        const item = {
          type: "message",
          id: "msg_test",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "A response from the local API fixture.",
              annotations: [],
            },
          ],
        };
        const events = [
          { type: "response.created", response: { id: "resp_test" } },
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
            delta: "A response from the local API fixture.",
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "resp_test",
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
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "jelly-api-"));
    const app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
    try {
      if (mode === "api")
        await app.service.harness.auth.setRuntimeApiKey(provider, token);
      else {
        app.service.harness.auth.installLoginDriver(async () => ({
          access: token,
          refresh: "test-refresh",
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
      const id = app.store.agents()[0]!.id;
      const untouched = app.service.createAgent({ name: "Untouched", instructions: "", color: "#fff" });
      app.service.start(id, "api-one", "Hello via API");
      await app.service.settled();
      expect(app.store.runs(id)[0]?.error).toBeNull();
      expect(app.store.runs(id)[0]?.status).toBe("completed");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.path).toBe(
        mode === "api" ? "/v1/responses" : "/v1/codex/responses",
      );
      expect(requests[0]?.auth).toBe(`Bearer ${token}`);
      expect(requests[0]?.body.model).toBe("gpt-6-astra");
      expect(requests[0]?.body.reasoning.effort).toBe("medium");
      if (mode === "api") {
        expect(requests[0]?.body.prompt_cache_retention).toBeUndefined();
        expect(requests[0]?.body.prompt_cache_retention).toBeUndefined();
      }
      expect(
        requests[0]?.body.tools.some((t: any) => t.name === "instance_info"),
      ).toBe(true);
      expect(JSON.stringify(requests[0]?.body.input)).toContain(
        "Hello via API",
      );
      expect(
        app.store
          .events(0, id)
          .filter((e) => e.type === "message")
          .at(-1)?.data.text,
      ).toBe("A response from the local API fixture.");
      expect(
        app.store.events(0, id).some((e) => e.type.includes("delta")),
      ).toBe(false);
      app.service.setConfig({ agentId: id, model: "gpt-6-sol", effort: "high" });
      app.service.start(id, "api-two", "Remember the previous message");
      await app.service.settled();
      expect(requests[1]?.body.model).toBe("gpt-6-sol");
      expect(requests[1]?.body.reasoning.effort).toBe("high");
      expect(JSON.stringify(requests[1]?.body.input)).toContain(
        "Hello via API",
      );
      expect(JSON.stringify(requests[1]?.body.input)).toContain(
        "A response from the local API fixture.",
      );
      for (const model of ["gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra-ultrafast"] as const)
        for (const effort of [
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ] as const) {
          app.service.setConfig({ agentId: id, model, effort });
          app.service.start(id, `${model}-${effort}`, "Verify settings");
          await app.service.settled();
          expect(requests.at(-1)?.body.model).toBe(model === "gpt-6-astra-ultrafast" ? "gpt-6-astra" : model);
          expect(requests.at(-1)?.body.service_tier).toBe(model === "gpt-6-astra-ultrafast" ? "ultrafast" : undefined);
          expect(requests.at(-1)?.body.reasoning.effort).toBe(effort);
          expect(app.store.runs(id).at(-1)?.status).toBe("completed");
          expect(requests.at(-1)?.body.temperature).toBeUndefined();
        }
      await app.service.harness.generateAgentName(
        "Test name",
        app.service.harness.config(mode, { model: "gpt-6.1-sol", effort: "medium" }),
        new AbortController().signal,
      );
      expect(requests.at(-1)?.body.model).toBe("gpt-6.1-sol");
      expect(requests.at(-1)?.body.reasoning.effort).toBe("low");
      const beforeSummary = requests.length;
      app.service.freshSession(id, "ultrafast-summary");
      await app.service.settled();
      expect(requests.length).toBeGreaterThan(beforeSummary);
      for (const request of requests.slice(beforeSummary)) {
        expect(request.body.model).toBe("gpt-6-astra");
        expect(request.body.service_tier).toBe("ultrafast");
      }
      await app.service.harness.generateAgentName("Test name", app.service.snapshot().config, new AbortController().signal);
      expect(requests.at(-1)?.body.service_tier).toBe("ultrafast");
      denyUltrafast = true;
      const beforeDenied = requests.length;
      app.service.start(id, "ultrafast-denied", "No fallback please");
      await app.service.settled();
      expect(requests.length).toBe(beforeDenied + 1);
      expect(app.store.runs(id).at(-1)?.status).toBe("failed");
      expect(app.store.runs(id).at(-1)?.error).toContain("Ultrafast is not enabled");
      app.service.setConfig({ agentId: id, model: "gpt-6-astra" });
      app.service.start(id, "standard-again", "Back to standard");
      await app.service.settled();
      expect(requests.at(-1)?.body.service_tier).toBeUndefined();
      expect(app.store.runs(id).at(-1)?.status).toBe("completed");
      // Creation defaults can change without changing any existing agent.
      app.service.setConfig({ model: "gpt-6.1-sol", effort: "low" });
      const newer = app.service.createAgent({ name: "New defaults", instructions: "", color: "#fff" });
      for (const [agentId, expectedModel, expectedEffort] of [
        [untouched.id, "gpt-6-astra", "medium"],
        [id, "gpt-6-astra", "max"],
        [newer.id, "gpt-6.1-sol", "low"],
      ] as const) {
        app.service.start(agentId, `pinned-${agentId}`, "Verify pinned settings");
        await app.service.settled();
        expect(requests.at(-1)?.body.model).toBe(expectedModel);
        expect(requests.at(-1)?.body.reasoning.effort).toBe(expectedEffort);
        expect(app.store.runs(agentId).at(-1)?.status).toBe("completed");
      }
      const beforeFresh = requests.length;
      app.service.freshSession(untouched.id, "pinned-fresh");
      await app.service.settled();
      expect(requests.length).toBeGreaterThan(beforeFresh);
      expect(requests.slice(beforeFresh).every(r => r.body.model === "gpt-6-astra")).toBe(true);
      // A switch during an active run takes effect on the next queued run only.
      app.service.setConfig({ agentId: id, model: "gpt-6-sol", effort: "high" });
      const beforeSwitch = requests.length;
      app.service.start(id, "before-agent-switch", "Keep this running model");
      app.service.start(id, "after-agent-switch", "Use my next model");
      app.service.setConfig({ agentId: id, model: "gpt-6.1-sol", effort: "max" });
      app.service.setConfig({ model: "gpt-6-astra", effort: "low" });
      await app.service.settled();
      expect(requests.slice(beforeSwitch).map(r => [r.body.model, r.body.reasoning.effort]))
        .toEqual([["gpt-6-sol", "high"], ["gpt-6.1-sol", "max"]]);
    } finally {
      await app.close();
      fake.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

test("ChatGPT uses cached WebSockets across runs, isolates agents, and reconnects safely", async () => {
  const frames: { connection: number; body: any }[] = [];
  const sockets = new Set<any>();
  let connections = 0,
    posts = 0;
  let behavior:
    | "normal"
    | "fail"
    | "wait"
    | "tool"
    | "missing"
    | "tool-then-fail"
    | "api-error" = "normal";
  let recoverOverHttp = false;
  const httpInputs: any[] = [];
  const fake = Bun.serve<{ id: number }>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, server) {
      if (req.method === "POST") {
        posts++;
        httpInputs.push(
          req.headers.get("content-encoding") === "zstd"
            ? JSON.parse(
                zstdDecompressSync(
                  Buffer.from(await req.arrayBuffer()),
                ).toString(),
              )
            : await req.json(),
        );
        if (!recoverOverHttp)
          return new Response("Fixture HTTP failure", { status: 503 });
        const item = {
          type: "message",
          id: "msg_recovered",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Recovered over HTTP.",
              annotations: [],
            },
          ],
        };
        const events = [
          { type: "response.created", response: { id: "resp_recovered" } },
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
            delta: "Recovered over HTTP.",
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "resp_recovered",
              status: "completed",
              output: [item],
              usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
            },
          },
        ];
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (server.upgrade(req, { data: { id: ++connections } })) return;
      return new Response("Upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, raw) {
        const body = JSON.parse(String(raw));
        frames.push({ connection: ws.data.id, body });
        const id = `resp_${frames.length}`;
        if (behavior === "missing") {
          behavior = "normal";
          ws.send(
            JSON.stringify({
              type: "error",
              code: "previous_response_not_found",
              message: "Fixture expired response",
            }),
          );
          return;
        }
        if (behavior === "api-error") {
          ws.send(
            JSON.stringify({
              type: "error",
              code: "invalid_request_error",
              message: "Fixture invalid request",
            }),
          );
          return;
        }
        if (behavior === "tool" || behavior === "tool-then-fail") {
          behavior = behavior === "tool" ? "normal" : "fail";
          const item = {
            type: "function_call",
            id: "fc_test",
            call_id: "call_test",
            name: "instance_info",
            arguments: "{}",
            status: "completed",
          };
          for (const event of [
            { type: "response.created", response: { id } },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, arguments: "" },
            },
            {
              type: "response.function_call_arguments.delta",
              output_index: 0,
              delta: "{}",
            },
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id,
                status: "completed",
                output: [item],
                usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
              },
            },
          ])
            ws.send(JSON.stringify(event));
          return;
        }
        ws.send(JSON.stringify({ type: "response.created", response: { id } }));
        if (behavior === "wait") return;
        const item = {
          type: "message",
          id: `msg_${frames.length}`,
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "WebSocket response.",
              annotations: [],
            },
          ],
        };
        for (const event of [
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
            delta: "WebSocket response.",
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id,
              status: "completed",
              output: [item],
              usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
            },
          },
        ]) {
          if (
            behavior === "fail" &&
            event.type === "response.output_item.done"
          ) {
            // Even a fully streamed call is unsafe without response.completed.
            ws.send(
              JSON.stringify({
                type: "response.output_item.added",
                output_index: 1,
                item: {
                  type: "function_call",
                  id: "fc_discarded",
                  call_id: "discarded",
                  name: "instance_info",
                  arguments: "",
                },
              }),
            );
            ws.send(
              JSON.stringify({
                type: "response.function_call_arguments.delta",
                output_index: 1,
                delta: "{}",
              }),
            );
            setTimeout(() => ws.terminate(), 10); // Real abnormal close code 1006.
            break;
          }
          ws.send(JSON.stringify(event));
        }
      },
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "jelly-websocket-"));
  const app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 4000;
    while (!condition()) {
      if (Date.now() > deadline)
        throw new Error("Timed out waiting for websocket");
      await Bun.sleep(10);
    }
  };
  try {
    const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "ws-account" } })).toString("base64url")}.test`;
    app.service.harness.auth.installLoginDriver(async () => ({
      access: token,
      refresh: "test-refresh",
      expires: Date.now() + 3600000,
      accountId: "ws-account",
    }));
    await app.service.harness.runtime.login("openai-codex", "oauth", {
      prompt: async () => "",
      notify: () => {},
    });
    app.service.harness.registry.registerProvider("openai-codex", {
      baseUrl: `http://127.0.0.1:${fake.port}/v1`,
    });
    app.service.setMode("chatgpt");
    const agent = app.store.agents()[0]!;
    const run = async (text: string, id = agent.id) => {
      app.service.start(id, crypto.randomUUID(), text);
      await app.service.settled();
      expect(app.store.runs(id).at(-1)?.error).toBeNull();
      expect(app.store.runs(id).at(-1)?.status).toBe("completed");
    };
    await run("First message");
    expect(frames[0]!.body.type).toBe("response.create");
    expect(frames[0]!.body.store).toBe(false);
    await run("Second message");
    expect(connections).toBe(1);
    expect(frames[1]!.body.previous_response_id).toBe("resp_1");
    expect(JSON.stringify(frames[1]!.body.input)).toContain("Second message");
    expect(JSON.stringify(frames[1]!.body.input)).not.toContain(
      "First message",
    );
    const other = app.service.createAgent({
      name: "Other",
      instructions: "",
      color: "#b5bafc",
    });
    await run("Other agent secret", other.id);
    expect(connections).toBe(2);
    expect(frames[2]!.body.previous_response_id).toBeUndefined();
    expect(JSON.stringify(frames[2]!.body.input)).not.toContain(
      "First message",
    );
    app.service.setConfig({ agentId: agent.id, model: "gpt-6-sol", effort: "high" });
    await run("Changed model");
    expect(frames[3]!.body.previous_response_id).toBeUndefined();
    expect(JSON.stringify(frames[3]!.body.input)).toContain("First message");
    expect(JSON.stringify(frames[3]!.body.input)).not.toContain(
      "Other agent secret",
    );
    for (const ws of sockets) ws.close(1000, "fixture reconnect");
    await until(() => sockets.size === 0);
    // Let the client consume the peer's close frame before issuing a new request.
    await Bun.sleep(30);
    await run("After reconnect");
    expect(frames[4]!.body.previous_response_id).toBeUndefined();
    expect(JSON.stringify(frames[4]!.body.input)).toContain("First message");
    behavior = "fail";
    app.service.start(agent.id, crypto.randomUUID(), "Midstream failure");
    await app.service.settled();
    expect(app.store.runs(agent.id).at(-1)?.status).toBe("failed");
    expect(posts).toBe(1); // One bounded HTTP recovery, not an entire run replay.
    expect(app.store.runs(agent.id).at(-1)?.error).toContain(
      "Fixture HTTP failure",
    );
    behavior = "wait";
    const count = frames.length;
    app.service.start(agent.id, crypto.randomUUID(), "Cancel me");
    await until(() => frames.length > count);
    await app.service.stop(agent.id);
    await app.service.settled();
    expect(app.store.runs(agent.id).at(-1)?.status).toBe("cancelled");
    behavior = "normal";
    await run("Recover after cancellation");
    expect(frames.at(-1)!.body.previous_response_id).toBeUndefined();
    behavior = "tool";
    const beforeTool = frames.length;
    await run("Check workspace using a tool");
    expect(frames.length).toBe(beforeTool + 2);
    expect(frames.at(-1)!.body.previous_response_id).toBe(
      `resp_${beforeTool + 1}`,
    );
    expect(
      frames
        .at(-1)!
        .body.input.some((item: any) => item.type === "function_call_output"),
    ).toBe(true);
    expect(JSON.stringify(frames.at(-1)!.body.input)).not.toContain(
      "First message",
    );
    behavior = "missing";
    const beforeMissing = frames.length;
    await run("Recover expired response");
    expect(frames.length).toBe(beforeMissing + 2);
    expect(frames.at(-1)!.body.previous_response_id).toBeUndefined();
    expect(JSON.stringify(frames.at(-1)!.body.input)).toContain(
      "First message",
    );
    app.service.updateAgent(agent.id, {
      name: agent.name,
      color: agent.color,
      instructions: "New instructions for this agent.",
    });
    await run("Use changed instructions");
    // Pi may deliver changed instructions as a mid-conversation system delta.
    expect(JSON.stringify(frames.at(-1)!.body)).toContain(
      "New instructions for this agent.",
    );
    expect(posts).toBe(1); // Cancellation did not trigger a retry.
    app.service.setConfig({ agentId: agent.id, model: "gpt-6-astra-ultrafast" });
    const beforeUltrafast = frames.length;
    recoverOverHttp = true;
    behavior = "tool-then-fail";
    const callsBefore = app.store
      .events(0, agent.id)
      .filter((e) => e.type === "tool_started").length;
    await run("Use a tool then recover a dropped connection");
    const recovered = app.store.runs(agent.id).at(-1)!;
    expect(posts).toBe(2);
    expect(frames.length).toBeGreaterThan(beforeUltrafast);
    for (const frame of frames.slice(beforeUltrafast)) {
      expect(frame.body.model).toBe("gpt-6-astra");
      expect(frame.body.service_tier).toBe("ultrafast");
    }
    expect(httpInputs.at(-1).service_tier).toBe("ultrafast");
    expect(httpInputs.at(-1).previous_response_id).toBeUndefined();
    expect(httpInputs.at(-1).store).toBe(false);
    expect(
      httpInputs
        .at(-1)
        .input.some((item: any) => item.type === "function_call_output"),
    ).toBe(true);
    expect(JSON.stringify(httpInputs.at(-1))).not.toContain("fc_discarded");
    const events = app.store.events(0, agent.id);
    expect(events.filter((e) => e.type === "tool_started").length).toBe(
      callsBefore + 1,
    );
    expect(
      events
        .filter(
          (e) =>
            e.runId === recovered.id &&
            e.type === "message" &&
            e.data.role === "assistant",
        )
        .map((e) => e.data.text),
    ).toEqual(["Recovered over HTTP."]);
    behavior = "api-error";
    app.service.start(
      agent.id,
      crypto.randomUUID(),
      "Do not retry invalid requests",
    );
    await app.service.settled();
    expect(app.store.runs(agent.id).at(-1)?.status).toBe("failed");
    expect(posts).toBe(2);
    expect(frames.every((frame) => frame.body.store === false)).toBe(true);
  } finally {
    await app.close();
    await until(() => sockets.size === 0);
    fake.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
