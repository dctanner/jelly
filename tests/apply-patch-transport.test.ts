import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { startApp } from "../src/server/app";
import { interventionTools } from "../src/server/agent-tools";
import { APPLY_PATCH_GRAMMAR } from "../src/server/vendor/apply-patch-grammar";

for (const mode of ["api", "chatgpt"] as const)
  for (const model of ["gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol"] as const) {
    test(`apply_patch ${mode}/${model}: actual Harness custom grammar, execution, and history replay`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "jelly-patch-transport-"));
      const patch =
        "*** Begin Patch\n*** Add File: transport.txt\n+héllo 🌊\n*** End Patch\n";
      const requests: any[] = [];
      const fake = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          if (req.method !== "POST")
            return new Response("Use SSE", { status: 426 });
          const body =
            req.headers.get("content-encoding") === "zstd"
              ? JSON.parse(
                  zstdDecompressSync(
                    Buffer.from(await req.arrayBuffer()),
                  ).toString(),
                )
              : await req.json();
          requests.push(body);
          const first = requests.length === 1;
          const item = first
            ? {
                type: "custom_tool_call",
                id: "ctc_patch",
                call_id: "call_patch",
                name: "apply_patch",
                input: patch,
                status: "completed",
              }
            : {
                type: "message",
                id: "msg_done",
                role: "assistant",
                status: "completed",
                content: [
                  { type: "output_text", text: "Done.", annotations: [] },
                ],
              };
          const events = [
            {
              type: "response.created",
              response: { id: `resp_${requests.length}` },
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: first ? { ...item, input: "" } : { ...item, content: [] },
            },
            ...(first
              ? [
                  {
                    type: "response.custom_tool_call_input.delta",
                    output_index: 0,
                    delta: patch.slice(0, 40),
                  },
                  {
                    type: "response.custom_tool_call_input.delta",
                    output_index: 0,
                    delta: patch.slice(40),
                  },
                  {
                    type: "response.custom_tool_call_input.done",
                    output_index: 0,
                    input: patch,
                  },
                ]
              : [
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
                    delta: "Done.",
                  },
                ]),
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id: `resp_${requests.length}`,
                status: "completed",
                output: [item],
                usage: {
                  input_tokens: 10,
                  output_tokens: 10,
                  total_tokens: 20,
                },
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
      const app = await startApp({
        dataDir: dir,
        configDir: join(dir, "config"),
        port: 0,
      });
      try {
        const h = app.service.harness;
        const provider = mode === "api" ? "openai" : "openai-codex";
        if (mode === "api")
          await h.auth.setRuntimeApiKey(provider, "test-only-not-a-real-key");
        else {
          const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
          h.auth.installLoginDriver(async () => ({
            access: token,
            refresh: "test-refresh",
            expires: Date.now() + 3600000,
            accountId: "test-account",
          }));
          await h.runtime.login(provider, "oauth", {
            prompt: async () => "",
            notify: () => {},
          });
        }
        h.registry.registerProvider(provider, {
          baseUrl: `http://127.0.0.1:${fake.port}/v1`,
        });
        const agent = app.store.agents()[0]!;
        const config = h.config(mode, { model, effort: "medium" });
        const session = await h.create(
          agent,
          [],
          config,
          app.store.instance(),
          interventionTools(
            app.service.computer,
            app.service.interventions,
            agent.id,
            "transport-fixture",
            agent.cwd,
          ),
        );
        try {
          expect(session.getActiveToolNames()).toContain("apply_patch");
          expect(session.getActiveToolNames()).toContain("edit");
          expect(session.getActiveToolNames()).toContain("write");
          // Execute unchanged native tools as well as asserting provider advertisement.
          const call = (name: string, args: unknown) =>
            session.agent.state.tools
              .find((tool) => tool.name === name)!
              .execute(name, args, new AbortController().signal);
          await call("write", { path: "native.txt", content: "before\n" });
          await call("edit", {
            path: "native.txt",
            edits: [{ oldText: "before", newText: "after" }],
          });
          expect(readFileSync(join(agent.cwd, "native.txt"), "utf8")).toBe(
            "after\n",
          );
          await session.prompt("Use apply_patch to add transport.txt");
          expect(requests).toHaveLength(2);
          expect(readFileSync(join(agent.cwd, "transport.txt"), "utf8")).toBe(
            "héllo 🌊\n",
          );
          const tool = requests[0].tools.find(
            (tool: any) => tool.name === "apply_patch",
          );
          expect(tool).toMatchObject({
            type: "custom",
            format: {
              type: "grammar",
              syntax: "lark",
              definition: APPLY_PATCH_GRAMMAR,
            },
          });
          expect(
            requests[0].tools.find((tool: any) => tool.name === "edit").type,
          ).toBe("function");
          expect(
            requests[0].tools.find((tool: any) => tool.name === "write").type,
          ).toBe("function");
          for (const name of [
            "browser_snapshot",
            "browser_click",
            "browser_fill",
            "browser_tabs",
            "browser_scroll",
            "browser_wait_for",
            "browser_diagnostics",
          ]) {
            expect(session.getActiveToolNames()).toContain(name);
            expect(
              requests[0].tools.find((tool: any) => tool.name === name),
            ).toMatchObject({ type: "function", parameters: { type: "object" } });
          }
          const replay = requests[1].input;
          expect(
            replay.find((item: any) => item.type === "custom_tool_call"),
          ).toMatchObject({
            name: "apply_patch",
            input: patch,
            call_id: "call_patch",
          });
          expect(
            replay.find((item: any) => item.type === "custom_tool_call_output")
              .output,
          ).toContain("Applied patch to 1 file");
          // Another turn replays the original custom call/result rather than a
          // JSON function call. All traffic remains on this local stub.
          await session.prompt("Remember the patch");
          expect(requests).toHaveLength(3);
          expect(
            requests[2].input.find(
              (item: any) => item.type === "custom_tool_call",
            ).input,
          ).toBe(patch);
          expect(
            requests[2].input.some(
              (item: any) => item.type === "custom_tool_call_output",
            ),
          ).toBe(true);
        } finally {
          await h.dispose(session);
        }
      } finally {
        await app.close();
        fake.stop(true);
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20000);
  }
