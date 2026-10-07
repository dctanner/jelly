import { expect, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { ChatGPTTransport } from "../src/server/chatgpt-transport";

function fixture(errors: (string | undefined)[]) {
  const requests: any[] = [];
  const session = {
    sessionId: "test-session",
    agent: {
      streamFunction: async (_model: unknown, context: unknown, options: unknown) => {
        requests.push({ context, options });
        const error = errors.shift();
        const stream = new AssistantMessageEventStream();
        // Include a partial tool call: a retry must not expose it to execution.
        stream.push({ type: "toolcall_delta", index: 0, delta: "partial", partial: {} } as unknown as AssistantMessageEvent);
        stream.push(error
          ? { type: "error", reason: "error", error: { errorMessage: error } } as AssistantMessageEvent
          : { type: "done", reason: "stop", message: { content: [] } } as unknown as AssistantMessageEvent);
        return stream;
      },
    },
  } as unknown as AgentSession;
  const transport = new ChatGPTTransport();
  transport.bind(session, crypto.randomUUID());
  const context = { messages: [{ role: "toolResult", content: [{ type: "text", text: "Already performed browser action" }] }] };
  const request = async (signal?: AbortSignal) => {
    const stream = await session.agent.streamFunction!(
      { provider: "openai-codex" } as any,
      context as any,
      { sessionId: session.sessionId, signal },
    );
    const events = [];
    for await (const event of stream) events.push(event);
    return events;
  };
  return { transport, requests, request, context };
}

test("premature close 1000 retries the same model input over SSE and stays on SSE", async () => {
  const f = fixture(["WebSocket closed 1000", undefined, undefined]);
  try {
    expect((await f.request()).map(e => e.type)).toEqual(["done"]);
    expect(f.requests.map(r => r.options.transport)).toEqual(["websocket-cached", "sse"]);
    expect(f.requests[0].context).toBe(f.context);
    expect(f.requests[1].context).toBe(f.context);
    expect(f.requests[1].options.sessionId).toBe(f.requests[0].options.sessionId);
    expect(f.requests[1].options.maxRetries).toBe(0);
    await f.request();
    expect(f.requests[2].options.transport).toBe("sse");
  } finally { f.transport.close(); }
});

test("SSE recovery is bounded to one retry", async () => {
  const f = fixture(["WebSocket closed 1000", "SSE failed"]);
  try {
    const events = await f.request();
    expect(events.map(e => e.type)).toEqual(["error"]);
    expect(f.requests).toHaveLength(2);
  } finally { f.transport.close(); }
});

for (const error of ["WebSocket closed 1008", "Invalid API key"]) {
  test(`does not recover non-transient error: ${error}`, async () => {
    const f = fixture([error]);
    try {
      expect((await f.request()).map(e => e.type)).toEqual(["error"]);
      expect(f.requests).toHaveLength(1);
    } finally { f.transport.close(); }
  });
}

test("does not retry a disconnected request after cancellation", async () => {
  const f = fixture(["WebSocket closed 1000"]);
  try {
    expect((await f.request(AbortSignal.abort())).map(e => e.type)).toEqual(["error"]);
    expect(f.requests).toHaveLength(1);
  } finally { f.transport.close(); }
});
