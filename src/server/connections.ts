import { JellyAuth, type ChatGPTLogin } from "./auth";
export type { ChatGPTLogin } from "./auth";
import type { LoginFlow } from "../shared/types";
import { HttpError } from "./errors";
type Flow = {
  view: LoginFlow;
  owner: string;
  controller: AbortController;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  done?: Promise<void>;
  finished: boolean;
  submitted: boolean;
};
export class Connections {
  private flow?: Flow;
  private closed = false;
  constructor(
    private auth: JellyAuth,
    private connected: (mode: "chatgpt" | "api" | "auto") => void,
    login: ChatGPTLogin | undefined,
    private ttlMs = 10 * 60 * 1000,
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
    if (
      process.env.PI_OAUTH_CALLBACK_HOST &&
      process.env.PI_OAUTH_CALLBACK_HOST !== "127.0.0.1"
    )
      throw new HttpError(
        400,
        "ChatGPT sign-in requires a loopback OAuth callback host.",
      );
    let resolve!: (value: string) => void, reject!: (error: Error) => void;
    const manual = new Promise<string>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void manual.catch(() => {});
    const flow: Flow = {
      owner,
      view: {
        id: crypto.randomUUID(),
        status: "starting",
        url: null,
        error: null,
      },
      controller: new AbortController(),
      resolve,
      reject,
      finished: false,
      submitted: false,
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
          onDeviceCode: () => {},
          onSelect: async (p) =>
            p.options.find((o) => o.id === "browser")?.id ?? p.options[0]!.id,
          onAuth: ({ url }) => {
            if (flow.controller.signal.aborted) return;
            const parsed = new URL(url);
            if (
              parsed.origin !== "https://auth.openai.com" ||
              !parsed.searchParams.get("state")
            ) {
              this.abort(flow, "Could not start ChatGPT sign-in.");
              return;
            }
            flow.view = { ...flow.view, status: "waiting", url };
          },
          onPrompt: () => manual,
          onManualCodeInput: () => manual,
        });
      })
      .then((credentials) => {
        if (this.closed || flow.controller.signal.aborted) return;

        flow.view = { ...flow.view, status: "connected", url: null };
        this.connected("chatgpt");
      })
      .catch(() => {
        if (!flow.controller.signal.aborted)
          flow.view = {
            ...flow.view,
            status: "error",
            url: null,
            error:
              "ChatGPT sign-in did not complete. Try again, or use an OpenAI API key.",
          };
      })
      .finally(() => {
        clearTimeout(flow.timer);
        flow.finished = true;
        flow.reject(new Error("Login finished"));
      });
    return flow.view;
  }
  private owned(owner: string, id: unknown) {
    const flow = this.flow;
    if (!flow || flow.owner !== owner || flow.view.id !== id)
      throw new HttpError(404, "Sign-in request not found.");
    return flow;
  }
  submit(owner: string, id: unknown, input: unknown) {
    const flow = this.owned(owner, id);
    if (
      flow.finished ||
      flow.controller.signal.aborted ||
      flow.submitted ||
      !flow.view.url
    )
      throw new HttpError(
        409,
        "This sign-in is no longer accepting a callback.",
      );
    if (typeof input !== "string" || input.length > 16000)
      throw new HttpError(400, "Paste the full callback URL.");
    let url: URL;
    try {
      url = new URL(input.trim());
    } catch {
      throw new HttpError(
        400,
        "Paste the full callback URL from the sign-in tab.",
      );
    }
    const expected = new URL(flow.view.url);
    if (
      url.origin !== "http://localhost:1455" ||
      url.pathname !== "/auth/callback" ||
      !url.searchParams.get("code") ||
      url.searchParams.get("state") !== expected.searchParams.get("state")
    )
      throw new HttpError(
        400,
        "This callback URL does not match the current sign-in.",
      );
    flow.submitted = true;
    flow.resolve(url.href);
    return { ok: true };
  }
  private abort(flow: Flow, error?: string) {
    if (flow.finished) return;
    flow.controller.abort();
    flow.view = {
      ...flow.view,
      status: error ? "error" : "cancelled",
      url: null,
      error: error ?? null,
    };
    flow.reject(new Error("Cancelled"));
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
