import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

type TerminalEvent = Extract<AssistantMessageEvent, { type: "done" | "error" }>;
async function completedResponse(
  stream: AssistantMessageEventStream,
): Promise<TerminalEvent> {
  let terminal: TerminalEvent | undefined;
  // Drain rather than retain deltas. Nothing reaches Pi's tool executor until
  // the response is complete, so a failed generation can be safely discarded.
  for await (const event of stream) {
    if (event.type === "done" || event.type === "error") terminal = event;
  }
  if (!terminal)
    throw new Error("Model stream ended without a terminal event.");
  return terminal;
}
function recoverableDisconnect(event: TerminalEvent): boolean {
  return (
    event.type === "error" &&
    event.reason === "error" &&
    /^WebSocket (?:closed (?:1001|1005|1006|1011|1012|1013)\b|idle timeout\b|error\b|stream closed before response\.completed)/i.test(
      event.error.errorMessage ?? "",
    )
  );
}
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketDebugStats,
} from "@earendil-works/pi-ai/api/openai-codex-responses";

/** Transport lifetime is per Jelly agent, not per disposable Pi run. */
export class ChatGPTTransport {
  private connections = new Map<
    string,
    {
      id: string;
      sseForRun?: boolean;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private owners = new WeakMap<AgentSession, string>();

  bind(session: AgentSession, agentId: string) {
    let connection = this.connections.get(agentId);
    if (!connection) {
      connection = { id: crypto.randomUUID() };
      this.connections.set(agentId, connection);
    }
    clearTimeout(connection.timer);
    this.owners.set(session, agentId);
    const transportId = connection.id;
    const stream = session.agent.streamFunction;
    const state = connection;
    session.agent.streamFunction = async (model, context, options) => {
      if (
        model.provider !== "openai-codex" ||
        options?.sessionId !== session.sessionId
      )
        return stream(model, context, options);
      const requestOptions = {
        ...options,
        sessionId: transportId,
        transport: state.sseForRun
          ? ("sse" as const)
          : ("websocket-cached" as const),
        cacheRetention: "short" as const,
        // Bound retries at this request boundary, not at the whole-agent level.
        maxRetries: 0,
      };
      let terminal = await completedResponse(
        await stream(model, context, requestOptions),
      );
      if (
        !state.sseForRun &&
        !options.signal?.aborted &&
        recoverableDisconnect(terminal)
      ) {
        closeOpenAICodexWebSocketSessions(transportId);
        resetOpenAICodexWebSocketDebugStats(transportId);
        state.sseForRun = true;
        // Same input, including completed tool results; not a replay of the run.
        // Partial text/tool calls from the failed generation were never exposed.
        terminal = await completedResponse(
          await stream(model, context, {
            ...requestOptions,
            transport: "sse",
          }),
        );
      }
      const output = new AssistantMessageEventStream();
      output.push(terminal);
      return output;
    };
  }

  release(session: AgentSession, keep: boolean) {
    const agentId = this.owners.get(session);
    if (!agentId) return;
    this.owners.delete(session);
    const connection = this.connections.get(agentId);
    if (!connection) return;
    if (!keep || connection.sseForRun) return this.reset(agentId);
    // Match Pi's idle socket expiry and bound Jelly's own bookkeeping too.
    connection.timer = setTimeout(() => this.reset(agentId), 5 * 60 * 1000);
    connection.timer.unref();
  }

  reset(agentId: string) {
    const connection = this.connections.get(agentId);
    if (!connection) return;
    clearTimeout(connection.timer);
    closeOpenAICodexWebSocketSessions(connection.id);
    resetOpenAICodexWebSocketDebugStats(connection.id);
    this.connections.delete(agentId);
  }

  close() {
    for (const agentId of this.connections.keys()) this.reset(agentId);
  }
}
