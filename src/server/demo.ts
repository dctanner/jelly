import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type Api,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
export const demoModel: Model<Api> = {
  id: "local-demo",
  name: "Local demo",
  provider: "jelly-demo",
  api: "openai-responses",
  baseUrl: "http://localhost/unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};
export function demoStream(delayMs = 220, fail = false) {
  return (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    void (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          if (options?.signal?.aborted) return reject(new Error("Stopped"));
          const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("Stopped"));
          };
          const timer = setTimeout(() => {
            options?.signal?.removeEventListener("abort", onAbort);
            resolve();
          }, delayMs);
          options?.signal?.addEventListener("abort", onAbort, { once: true });
        });
        if (fail) throw new Error("Demo provider failure");
        const last = context.messages.at(-1);
        const currentUser = context.messages
          .filter((m) => m.role === "user")
          .at(-1);
        const command =
          typeof currentUser?.content === "string"
            ? currentUser.content
            : (currentUser?.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n") ?? "");
        const sudo = command.trim() === "/demo sudo";
        const login = command.startsWith("/demo login ");
        if (last?.role !== "toolResult") {
          message.content = [
            {
              type: "text",
              text: sudo
                ? "I’ll run this administrator command."
                : login
                  ? "Please sign in through the private browser handoff."
                  : "I’ll check this Jelly workspace.",
            },
            {
              type: "toolCall",
              id: crypto.randomUUID(),
              name: sudo
                ? "request_sudo"
                : login
                  ? "request_browser_login"
                  : "instance_info",
              arguments: sudo
                ? {
                    executable: "/usr/bin/id",
                    args: ["-u"],
                    reason:
                      "Demonstrate an administrator command by reading the effective user ID.",
                  }
                : login
                  ? {
                      url: command.slice(12).trim(),
                      reason:
                        "Sign in privately, then return browser control to this agent.",
                    }
                  : {},
            },
          ];
          message.stopReason = "toolUse";
        } else {
          const users = context.messages.filter((m) => m.role === "user");
          const current = users.at(-1)!;
          const text =
            typeof current.content === "string"
              ? current.content
              : current.content
                  .filter((c) => c.type === "text")
                  .map((c) => c.text)
                  .join("\n");
          message.content = [
            {
              type: "text",
              text:
                sudo || login
                  ? `The tool finished. Result: ${JSON.stringify(last.content)}\n\nThis is a scripted demonstration through the real Pi tool loop.`
                  : `Your local agent is working. I received: “${text}”\n\nI used the instance_info tool and completed this turn through Pi. This conversation has ${users.length} saved user message${users.length === 1 ? "" : "s"}.\n\nThis is a deterministic demo, not an AI-generated answer. Choose ChatGPT or an OpenAI API key in Connection settings for real model responses.`,
            },
          ];
        }
        stream.push({ type: "start", partial: message });
        stream.push({
          type: "done",
          reason: message.stopReason as "stop" | "toolUse",
          message,
        });
        stream.end(message);
      } catch (error) {
        message.stopReason = options?.signal?.aborted ? "aborted" : "error";
        message.errorMessage =
          error instanceof Error ? error.message : "Demo failed";
        stream.push({
          type: "error",
          reason: message.stopReason,
          error: message,
        });
        stream.end(message);
      }
    })();
    return stream;
  };
}
