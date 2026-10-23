import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createClaudeCodeProvider } from "@earendil-works/pi-claude-code/src/index.ts";
import {
  getClaudeStatus,
  type ClaudeStatus,
} from "@earendil-works/pi-claude-code/src/claude-cli.ts";

type RequestStatusCheck = (
  env: Record<string, string | undefined>,
  signal: AbortSignal,
) => Promise<ClaudeStatus>;

/**
 * Use the same request-time subscription boundary in Jelly and detached Pi.
 * UI readiness is only a cached hint. Never reuse it to authorize a request:
 * the official CLI's login can change independently of Jelly.
 */
export function createJellyClaudeProvider(
  check: RequestStatusCheck = getClaudeStatus,
) {
  const provider = createClaudeCodeProvider();
  async function requireSubscription(
    env: Record<string, string | undefined>,
    parentSignal?: AbortSignal,
  ) {
    const timeout = AbortSignal.timeout(5000);
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, timeout])
      : timeout;
    let status: ClaudeStatus;
    try {
      signal.throwIfAborted();
      status = await check(env, signal);
      signal.throwIfAborted();
    } catch {
      throw new Error(
        "Claude subscription could not be verified. No model request was sent. Check claude auth status and refresh Claude in Settings.",
      );
    }
    if (!status.available || !status.loggedIn || !status.subscription)
      throw new Error(
        "Claude subscription login is required. No model request was sent. Run claude auth login with your subscription, then refresh Claude in Settings.",
      );
  }
  const apiKey = provider.auth!.apiKey!;
  const oauth = provider.auth!.oauth!;
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        ...apiKey,
        async check(input: Parameters<NonNullable<typeof apiKey.check>>[0]) {
          const status = await apiKey.check!(input);
          return status?.type === "oauth" ? status : undefined;
        },
        async resolve(input: Parameters<typeof apiKey.resolve>[0]) {
          const result = await apiKey.resolve(input);
          await requireSubscription(
            { ...process.env, ...result?.env },
            input.signal,
          );
          return result;
        },
      },
      // Keep upstream subscription metadata without allowing a stored marker
      // to bypass the request check via the alternate OAuth resolution path.
      oauth: {
        ...oauth,
        async toAuth(credential: Parameters<typeof oauth.toAuth>[0]) {
          await requireSubscription(process.env);
          return oauth.toAuth(credential);
        },
      },
    },
  };
}

export default function jellyClaudeCode(pi: ExtensionAPI) {
  pi.registerProvider(createJellyClaudeProvider());
}
