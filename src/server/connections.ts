import { JellyAuth, type ChatGPTLogin } from "./auth";
export type { ChatGPTLogin } from "./auth";
import type { LoginFlow } from "../shared/types";
import { HttpError } from "./errors";
type Flow = {
  view: LoginFlow;
  owner: string;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  done?: Promise<void>;
  finished: boolean;
};
export class Connections {
  private flow?: Flow;
  private closed = false;
  constructor(
    private auth: JellyAuth,
    private connected: (mode: "chatgpt" | "api" | "auto") => void,
    login: ChatGPTLogin | undefined,
    private ttlMs = 15 * 60 * 1000,
  ) {
    if (login) auth.installLoginDriver(login);
  }
  status(owner: string) {
    this.auth.reload();
    return {
      chatgptReady: this.auth.hasAuth("openai-codex"),
      apiReady: this.auth.hasAuth("openai"),
      apiStored: this.auth.get("openai")?.type === "api_key",
      apiSource: this.auth.getAuthStatus("openai").source ?? null,
      busy: !!this.flow && !this.flow.finished,
      flow: this.flow?.owner === owner ? this.flow.view : null,
    };
  }
  async saveKey(key: unknown) {
    if (this.flow && !this.flow.finished)
      throw new HttpError(409, "Finish or cancel ChatGPT sign-in first.");
    if (
      typeof key !== "string" ||
      !/^sk-[A-Za-z0-9_-]{16,1020}$/.test(key.trim())
    )
      throw new HttpError(
        400,
        "Enter a valid OpenAI API key beginning with sk-.",
      );
    await this.auth.saveKey(key.trim());
    this.flow = undefined;
    this.connected("api");
    return { ok: true };
  }
  async remove(provider: "openai" | "openai-codex") {
    if (this.flow && !this.flow.finished)
      throw new HttpError(409, "Finish or cancel ChatGPT sign-in first.");
    await this.auth.remove(provider);
    this.flow = undefined;
    this.connected("auto");
    return { ok: true };
  }
  start(owner: string) {
    if (this.closed) throw new HttpError(503, "Jelly is shutting down.");
    if (this.flow && !this.flow.finished) {
      if (this.flow.owner === owner) return this.flow.view;
      throw new HttpError(
        409,
        "ChatGPT sign-in is already open in another browser session.",
      );
    }
    const flow: Flow = {
      owner,
      view: {
        id: crypto.randomUUID(),
        status: "starting",
        url: null,
        userCode: null,
        error: null,
      },
      controller: new AbortController(),
      finished: false,
      timer: setTimeout(
        () => this.abort(flow, "Sign-in expired. Try connecting again."),
        this.ttlMs,
      ),
    };
    flow.timer.unref();
    this.flow = flow;
    flow.done = Promise.resolve()
      .then(() => {
        if (flow.controller.signal.aborted) throw new Error("Cancelled");
        return this.auth.login({
          signal: flow.controller.signal,
          onSelect: async (p) => {
            const method = p.options.find((o) => o.id === "device_code");
            if (!method) throw new Error("Device-code login unavailable");
            return method.id;
          },
          onDeviceCode: ({ verificationUri, userCode, expiresInSeconds }) => {
            if (flow.controller.signal.aborted) return;
            const parsed = new URL(verificationUri);
            if (
              parsed.origin !== "https://auth.openai.com" ||
              parsed.pathname !== "/codex/device" ||
              parsed.username ||
              parsed.password ||
              !userCode
            )
              throw new Error("Invalid device-code login response");
            flow.view = {
              ...flow.view,
              status: "waiting",
              url: parsed.href,
              userCode,
            };
            if (
              expiresInSeconds &&
              Number.isFinite(expiresInSeconds) &&
              expiresInSeconds > 0
            ) {
              clearTimeout(flow.timer);
              flow.timer = setTimeout(
                () =>
                  this.abort(flow, "Sign-in expired. Try connecting again."),
                Math.min(this.ttlMs, expiresInSeconds * 1000),
              );
              flow.timer.unref();
            }
          },
          onAuth: () => {
            throw new Error("Browser login is unsupported");
          },
          onPrompt: async () => {
            throw new Error("Unexpected sign-in prompt");
          },
        });
      })
      .then(() => {
        if (this.closed || flow.controller.signal.aborted) return;

        flow.view = {
          ...flow.view,
          status: "connected",
          url: null,
          userCode: null,
        };
        this.connected("chatgpt");
      })
      .catch(() => {
        if (!flow.controller.signal.aborted)
          flow.view = {
            ...flow.view,
            status: "error",
            url: null,
            userCode: null,
            error:
              "ChatGPT sign-in did not complete. Enable device-code login in your ChatGPT security settings (or ask your workspace admin), then try again.",
          };
      })
      .finally(() => {
        clearTimeout(flow.timer);
        flow.finished = true;
      });
    return flow.view;
  }
  private owned(owner: string, id: unknown) {
    const flow = this.flow;
    if (!flow || flow.owner !== owner || flow.view.id !== id)
      throw new HttpError(404, "Sign-in request not found.");
    return flow;
  }
  private abort(flow: Flow, error?: string) {
    if (flow.finished) return;
    flow.controller.abort();
    flow.view = {
      ...flow.view,
      status: error ? "error" : "cancelled",
      url: null,
      userCode: null,
      error: error ?? null,
    };
  }
  cancel(owner: string, id: unknown) {
    this.abort(this.owned(owner, id));
    return { ok: true };
  }
  close() {
    this.closed = true;
    if (this.flow) this.abort(this.flow);
  }
}
