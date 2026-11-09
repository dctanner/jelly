import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BrowserPort } from "./browser-sessions";
import type { Interventions } from "./interventions";
import { BrowserRepl } from "./browser/repl";
import { BROWSER_JS_DESCRIPTION } from "./browser/repl-docs";
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: {},
});
const define = <T extends TSchema>(tool: ToolDefinition<T>): ToolDefinition =>
  tool as ToolDefinition;
/** One persistent REPL per agent. Host calls resolve the CURRENT run's browser
 * port each time, so REPL state survives runs without keeping old-run authority. */
const repls = new Map<string, BrowserRepl>();
const currentBrowser = new Map<string, () => BrowserPort>();
function browserRepl(agentId: string, browser: () => BrowserPort) {
  currentBrowser.set(agentId, browser);
  let repl = repls.get(agentId);
  if (!repl) {
    repl = new BrowserRepl((op, args, signal) => {
      const get = currentBrowser.get(agentId);
      if (!get) return Promise.reject(new Error("No active run owns this agent's browser."));
      return get().engine.execute(op, args, signal);
    });
    repls.set(agentId, repl);
  }
  return repl;
}
export function closeBrowserRepl(agentId: string) {
  repls.get(agentId)?.close();
  repls.delete(agentId);
  currentBrowser.delete(agentId);
}
export function interventionTools(
  sessions: { target?: "chrome"; get(id: string): BrowserPort },
  requests: Interventions,
  agentId: string,
  runId: string,
  cwd: string,
): ToolDefinition[] {
  const browser = () => sessions.get(agentId);
  return [
    define({
      name: "request_sudo",
      label: "Run sudo",
      description:
        "Run one command with root privileges immediately. Include a concise, human-readable summary of exactly what the command will do, including meaningful side effects; use reason to explain why it is needed. Request private password entry only if sudo requires authentication. Never request or supply a password in chat or tool arguments.",
      parameters: Type.Object({
        executable: Type.String({ description: "Absolute executable path" }),
        args: Type.Array(Type.String()),
        summary: Type.String({
          description:
            "Plain-language summary of the command's actions and side effects (for example, mounting a disk read-only and listing database sizes). Shown in Review command. Do not include secrets.",
          minLength: 1,
          maxLength: 500,
          pattern: "\\S",
        }),
        reason: Type.String({
          description: "Why this privileged command is needed.",
        }),
      }),
      execute: async (_id, args, signal) =>
        result(await requests.sudo(agentId, runId, { ...args, cwd }, signal)),
    }),
    define({
      name: "request_browser_login",
      label: "Request browser login",
      description:
        "Optional human handoff: open a Connected Chrome tab for the user to sign in themselves (e.g. you lack the credentials or it needs their 2FA device) and wait for their Done or cancellation. You may instead sign in yourself with browser_js when you have the credentials.",
      parameters: Type.Object({
        url: Type.String(),
        reason: Type.String({ maxLength: 2000 }),
      }),
      execute: async (_id, args, signal) => {
        signal?.throwIfAborted();
        const session = browser();
        const pending = requests.request(
          "browser_login",
          agentId,
          runId,
          args,
          signal,
        );
        void pending.promise.catch(() =>
          session.cancelLogin(pending.request.id),
        );
        try {
          await session.reserveLogin(pending.request.id, args.url, signal);
          return result(await pending.promise);
        } catch (e) {
          requests.cancel(pending.request.id);
          throw e;
        } finally {
          session.cancelLogin(pending.request.id);
        }
      },
    }),
    define({
      name: "request_browser_recovery",
      label: "Recover paused browser session",
      description: "Automatically retire this agent's security-paused (or lost) Connected Chrome session so work can continue; no human approval step. Sign-in/native privacy handoffs and revoked pairing still require their existing controls. Old tabs/references are not restored and nothing is replayed. After closure, open the page again (a fresh session is allocated on the next browser action), take a fresh snapshot and verify interrupted actions before repeating them.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_id, args, signal, onUpdate) => {
        if (Object.keys(args).length) return result({ status: "rejected", message: "Recovery accepts no approval, identity or credential arguments." });
        if (signal?.aborted) return result({ status: "cancelled", message: "Recovery request cancelled." });
        let session: BrowserPort;
        try { session = browser(); }
        catch { return result({ status: "rejected", message: "No current authorized browser session is available for recovery. Check the Connected Chrome profile selection." }); }
        return result(await requests.recoverBrowser(agentId, runId, session, signal, value => onUpdate?.(result(value))));
      },
    }),
    define({
      name: "browser_reconnect",
      label: "Reconnect browser session",
      description: "Recover this agent's expired Connected Chrome session on the same authorized profile. Creates an empty session; never replays actions or restores old tabs/references. Reopen the page and take a fresh snapshot; a previous action may already have completed. Cannot bypass revoked pairing, native privacy or security cleanup. A healthy session is left unchanged.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_id, _args, signal) => {
        signal?.throwIfAborted();
        const session = browser();
        if (!session.reconnect) throw new Error("Browser session reconnect is unavailable.");
        return result(await session.reconnect(signal));
      },
    }),
    define({
      name: "browser_js",
      label: "Browser",
      description: BROWSER_JS_DESCRIPTION,
      parameters: Type.Object({
        code: Type.String({ description: "JavaScript to run in this agent's persistent browser REPL. Top-level await is supported; top-level const/let/function persist across calls." }),
        timeout_ms: Type.Optional(Type.Number({ minimum: 1000, maximum: 600000, description: "Cell timeout (default 30000). A timeout resets REPL state." })),
      }),
      execute: async (_id, args, signal) => {
        const output = await browserRepl(agentId, browser).run(args.code, { timeoutMs: args.timeout_ms, signal });
        const content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [...output.items];
        if (output.error) content.push({ type: "text", text: `Error: ${output.error}` });
        if (output.reset) content.push({ type: "text", text: "The browser REPL was reset; earlier variables (browser tab handles included) are gone. Re-acquire tabs with browser.tabs.list()." });
        if (!content.length) content.push({ type: "text", text: "(no output)" });
        return { content, details: {} };
      },
    }),
  ];
}
