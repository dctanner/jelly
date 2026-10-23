import {
  getClaudeStatus,
  type ClaudeStatus,
} from "@earendil-works/pi-claude-code/src/claude-cli.ts";
import { envFlagEnabled } from "@earendil-works/pi-claude-code/src/env.ts";

export type ClaudeStatusCheck = () => Promise<ClaudeStatus>;

export interface ClaudeReadiness {
  claudeReady: boolean;
  claudeNotice: string;
}
/** Status only: Claude Code owns authentication; never import its credentials. */
export class ClaudeCodeConnection {
  private value: ClaudeReadiness = {
    claudeReady: false,
    claudeNotice: "Check Claude Code in Settings, then refresh its status.",
  };
  private checkedAt = 0;
  private pending?: Promise<ClaudeReadiness>;
  constructor(
    private readonly check: ClaudeStatusCheck = () =>
      getClaudeStatus(process.env, AbortSignal.timeout(5000)),
    private readonly environment: () => NodeJS.ProcessEnv = () => process.env,
  ) {}
  status(): ClaudeReadiness {
    const env = this.environment();
    const conflicts = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_FOUNDRY_API_KEY",
    ].filter((key) => !!env[key]);
    for (const key of [
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ])
      if (envFlagEnabled(env[key])) conflicts.push(key);
    if (conflicts.length)
      return {
        claudeReady: false,
        claudeNotice: `Claude subscription refuses conflicting auth/backend overrides: ${conflicts.join(", ")}. Remove them from the Jelly service environment.`,
      };
    return this.value;
  }
  refresh(force = false): Promise<ClaudeReadiness> {
    if (this.pending) return this.pending;
    if (Date.now() - this.checkedAt < (force ? 1000 : 60000))
      return Promise.resolve(this.status());
    this.pending = (async () => {
      try {
        const status = await this.check();
        this.value = {
          claudeReady:
            status.available && status.loggedIn && status.subscription,
          claudeNotice: !status.available
            ? "Install Claude Code on this Jelly computer: npm install -g @anthropic-ai/claude-code. Ensure claude is on the service PATH, or set PI_CLAUDE_CODE_COMMAND."
            : !status.loggedIn || !status.subscription
              ? "Run claude auth login on this Jelly computer as the Jelly service user, using your Claude subscription, then refresh."
              : "Claude Code subscription · Experimental; plan limits and provider billing rules apply.",
        };
      } catch {
        this.value = {
          claudeReady: false,
          claudeNotice:
            "Claude Code status check failed or timed out. Run claude auth status on this Jelly computer, then refresh.",
        };
      } finally {
        this.checkedAt = Date.now();
        this.pending = undefined;
      }
      return this.status();
    })();
    return this.pending;
  }
}
