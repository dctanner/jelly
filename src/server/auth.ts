import {
  ModelRuntime,
  readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import type {
  OAuthLoginCallbacks,
  OAuthCredentials,
} from "@earendil-works/pi-ai";
export type ChatGPTLogin = (
  callbacks: OAuthLoginCallbacks,
) => Promise<OAuthCredentials>;
/** Jelly's synchronous status projection; Pi owns credential writes and refresh. */
export class JellyAuth {
  constructor(
    readonly runtime: ModelRuntime,
    readonly path: string,
  ) {}
  get(provider: string) {
    return readStoredCredential(provider, this.path);
  }
  has(provider: string) {
    return !!this.get(provider);
  }
  hasAuth(provider: string) {
    return (
      this.has(provider) ||
      (provider === "openai" && !!process.env.OPENAI_API_KEY) ||
      this.runtime.hasConfiguredAuth(provider)
    );
  }
  getAuthStatus(provider: string) {
    return this.runtime.getProviderAuthStatus(provider);
  }
  reload() {
    /* Reads always use the latest Pi credential file. */
  }
  getOAuthProviders() {
    return this.runtime.getProviders().filter((p) => p.auth?.oauth);
  }
  setRuntimeApiKey(provider: string, key: string) {
    return this.runtime.setRuntimeApiKey(provider, key);
  }
  async saveKey(key: string) {
    await this.runtime.login("openai", "api_key", {
      prompt: async () => key,
      notify: () => {},
    });
  }
  remove(provider: string) {
    return this.runtime.logout(provider);
  }
  installLoginDriver(driver: ChatGPTLogin) {
    const provider = this.runtime.getProvider("openai-codex")!;
    this.runtime.registerNativeProvider({
      ...provider,
      auth: {
        ...provider.auth,
        oauth: {
          ...provider.auth!.oauth!,
          login: async (interaction) => ({
            type: "oauth",
            ...(await driver({
              signal: interaction.signal,
              onDeviceCode: () => {},
              onSelect: (p) => interaction.prompt({ type: "select", ...p }),
              onAuth: (info) =>
                interaction.notify({ type: "auth_url", ...info }),
              onPrompt: (p) => interaction.prompt({ type: "text", ...p }),
              onManualCodeInput: () =>
                interaction.prompt({
                  type: "manual_code",
                  message: "Callback URL",
                }),
            })),
          }),
        },
      },
    });
  }
  login(callbacks: OAuthLoginCallbacks) {
    return this.runtime.login("openai-codex", "oauth", {
      signal: callbacks.signal,
      prompt: async (p) =>
        p.type === "select"
          ? ((await callbacks.onSelect({ ...p, options: [...p.options] })) ??
            "")
          : p.type === "manual_code" && callbacks.onManualCodeInput
            ? callbacks.onManualCodeInput()
            : callbacks.onPrompt({ message: p.message }),
      notify: (e) => {
        if (e.type === "auth_url") callbacks.onAuth(e);
        else if (e.type === "progress") callbacks.onProgress?.(e.message);
      },
    });
  }
}
