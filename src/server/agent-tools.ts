import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BrowserPort } from "./browser-sessions";
import type { Interventions } from "./interventions";
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: {},
});
const define = <T extends TSchema>(tool: ToolDefinition<T>): ToolDefinition =>
  tool as ToolDefinition;
export function interventionTools(
  sessions: { target?: "chrome"; get(id: string): BrowserPort },
  requests: Interventions,
  agentId: string,
  runId: string,
  cwd: string,
  beforePrivateBrowser?: () => Promise<void>,
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
        "Open a Connected Chrome sign-in tab and wait for this request’s Done or cancellation. The user can use Computer control from Settings or any agent menu. Human-use status is advisory: browser tools remain usable. Never ask for credentials in chat or tools.",
      parameters: Type.Object({
        url: Type.String(),
        reason: Type.String({ maxLength: 2000 }),
      }),
      execute: async (_id, args, signal) => {
        signal?.throwIfAborted();
        const session = browser();
        // No private-entry card is published until desktop admission is closed
        // and all previously accepted desktop work is known to have drained.
        await beforePrivateBrowser?.();
        signal?.throwIfAborted();
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
      name: "browser_reconnect",
      label: "Reconnect browser session",
      description: "Recover this agent's expired Connected Chrome session on the same authorized profile and site scope. Creates an empty session; never replays actions or restores old tabs/references. Reopen the page and take a fresh snapshot; a previous action may already have completed. Cannot bypass revoked pairing, native privacy or security cleanup. A healthy session is left unchanged.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_id, _args, signal) => {
        signal?.throwIfAborted();
        const session = browser();
        if (!session.reconnect) throw new Error("Browser session reconnect is unavailable.");
        return result(await session.reconnect(signal));
      },
    }),
    define({
      name: "browser_keep_tab",
      label: "Keep Chrome deliverable",
      description: "Keep the current Connected Chrome task tab after settlement: deliverable releases control; handoff retains the tab for a follow-up run without requiring Resume.",
      parameters: Type.Object({ mark: Type.Optional(Type.Union([Type.Literal("deliverable"), Type.Literal("handoff")])) }),
      execute: async (_id, args) => {
        const session = browser();
        if (!session.keepTab) throw new Error("Deliverable marking is unavailable.");
        return result(await session.keepTab(args.mark));
      },
    }),
    define({
      name: "browser_name_task",
      label: "Name Chrome task",
      description: "Set a short non-sensitive task label on this agent's Connected Chrome groups. Never include credentials or personal details. Connected Chrome only.",
      parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 55 }) }),
      execute: async (_id, args, signal) => {
        return result(await browser().action("name", args, signal));
      },
    }),
    define({
      name: "browser_select",
      label: "Select Chrome option",
      description: "Select an option value on an exact snapshot select-element reference. Connected Chrome only.",
      parameters: Type.Object({ ref: Type.String(), value: Type.String({ maxLength: 1000 }) }),
      execute: async (_id, args, signal) => {
        return result(await browser().action("select", args, signal));
      },
    }),
    define({
      name: "browser_open",
      label: "Open website",
      description:
        "Navigate this agent’s browser session. Human-use status is advisory; re-observe if the page changes.",
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_id, args, signal) =>
        result(await browser().action("open", args, signal)),
    }),
    define({
      name: "browser_screenshot",
      label: "Browser screenshot",
      description:
        "Inspect this agent’s browser session viewport. Human-use status is advisory; re-observe if the page changes.",
      parameters: Type.Object({}),
      execute: async (_id, _args, signal) => {
        const value = (await browser().action("screenshot", {}, signal)) as {
          image: string;
          humanUsing?: boolean;
        };
        return {
          content: [
            { type: "image", mimeType: "image/png", data: value.image },
            { type: "text", text: JSON.stringify({ humanUsing: value.humanUsing === true }) },
          ],
          details: {},
        };
      },
    }),
    define({
      name: "browser_click",
      label: "Click browser",
      description:
        "Click an exact browser_snapshot reference in Connected Chrome. Coordinate clicks are unavailable.",
      parameters: Type.Object({ ref: Type.String() }),
      execute: async (_id, args, signal) =>
        result(await browser().action("click", args, signal)),
    }),
    define({
      name: "browser_snapshot",
      label: "Browser snapshot",
      description:
        "Observe bounded visible text and up to 100 element references; no form values. References expire on navigation, tab changes and handoff.",
      parameters: Type.Object({}),
      execute: async (_id, args, signal) =>
        result(await browser().action("snapshot", {}, signal)),
    }),
    define({
      name: "browser_fill",
      label: "Browser fill",
      description:
        "Fill a referenced non-secret text field. Use request_browser_login for credentials.",
      parameters: Type.Object({
        ref: Type.String(),
        text: Type.String({ maxLength: 24000 }),
      }),
      execute: async (_id, args, signal) =>
        result(await browser().action("fill", args, signal)),
    }),
    define({
      name: "browser_tabs",
      label: "Browser tabs",
      description:
        "List (IDs only), create, select or close tabs exclusively in this agent session.",
      parameters: Type.Object({
        operation: Type.Union([
          Type.Literal("list"),
          Type.Literal("new"),
          Type.Literal("select"),
          Type.Literal("close"),
        ]),
        pageId: Type.Optional(Type.String()),
        url: Type.Optional(Type.String()),
      }),
      execute: async (_id, args, signal) =>
        result(await browser().action("tabs", args, signal)),
    }),
    define({
      name: "browser_scroll",
      label: "Browser scroll",
      description: "Scroll the active page by bounded pixel deltas.",
      parameters: Type.Object({
        x: Type.Optional(Type.Number({ minimum: -10000, maximum: 10000 })),
        y: Type.Number({ minimum: -10000, maximum: 10000 }),
      }),
      execute: async (_id, args, signal) =>
        result(await browser().action("scroll", args, signal)),
    }),
    define({
      name: "browser_wait_for",
      label: "Browser wait_for",
      description:
        "Wait at most 10 seconds for visible text, absence of text, or DOM readiness. Does not return page text.",
      parameters: Type.Object({
        condition: Type.Union([
          Type.Literal("text"),
          Type.Literal("text_absent"),
          Type.Literal("ready"),
        ]),
        text: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        timeoutMs: Type.Optional(Type.Number({ minimum: 0, maximum: 10000 })),
      }),
      execute: async (_id, args, signal) =>
        result(await browser().action("wait_for", args, signal)),
    }),
    define({
      name: "browser_key",
      label: "Press browser key",
      description:
        "Connected Chrome: requires an exact button/select reference and only Enter, Space, arrows or Escape; no global shortcuts or credential typing.",
      parameters: Type.Object({ key: Type.String({ maxLength: 100 }), ref: Type.String() }),
      execute: async (_id, args, signal) =>
        result(await browser().action("key", args, signal)),
    }),
  ];
}
