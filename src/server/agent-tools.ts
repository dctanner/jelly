import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ComputerSessions } from "./computer-sessions";
import type { Interventions } from "./interventions";
import { resolve } from "node:path";
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: {},
});
const define = <T extends TSchema>(tool: ToolDefinition<T>): ToolDefinition =>
  tool as ToolDefinition;
export function interventionTools(
  sessions: ComputerSessions,
  requests: Interventions,
  agentId: string,
  runId: string,
  cwd: string,
): ToolDefinition[] {
  const computer = () => sessions.get(agentId);
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
        "Open a website in this agent’s browser session and wait for the user to sign in privately and return control. Never ask for login credentials in chat.",
      parameters: Type.Object({
        url: Type.String(),
        reason: Type.String({ maxLength: 2000 }),
      }),
      execute: async (_id, args, signal) => {
        signal?.throwIfAborted();
        const browser = computer();
        const pending = requests.request(
          "browser_login",
          agentId,
          runId,
          args,
          signal,
        );
        void pending.promise.catch(() =>
          browser.cancelLogin(pending.request.id),
        );
        try {
          await browser.reserveLogin(pending.request.id, args.url, signal);
          return result(await pending.promise);
        } catch (e) {
          requests.cancel(pending.request.id);
          throw e;
        } finally {
          browser.cancelLogin(pending.request.id);
        }
      },
    }),
    define({
      name: "browser_open",
      label: "Open website",
      description:
        "Navigate this agent’s browser session. Blocked during human control.",
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_id, args, signal) =>
        result(await computer().action("open", args, signal)),
    }),
    define({
      name: "browser_screenshot",
      label: "Browser screenshot",
      description:
        "Inspect this agent’s browser session viewport. Blocked during human control.",
      parameters: Type.Object({}),
      execute: async (_id, _args, signal) => {
        const value = (await computer().action("screenshot", {}, signal)) as {
          image: string;
        };
        return {
          content: [
            { type: "image", mimeType: "image/png", data: value.image },
          ],
          details: {},
        };
      },
    }),
    define({
      name: "browser_click",
      label: "Click browser",
      description:
        "Click a browser_snapshot reference OR viewport coordinates in this agent’s browser session.",
      // Responses function tools require an object root, not a top-level union.
      // Computer.action enforces reference XOR a complete coordinate pair.
      parameters: Type.Object({
        x: Type.Optional(Type.Number()),
        y: Type.Optional(Type.Number()),
        ref: Type.Optional(Type.String()),
      }),
      execute: async (_id, args, signal) =>
        result(await computer().action("click", args, signal)),
    }),
    define({
      name: "browser_snapshot",
      label: "Browser snapshot",
      description:
        "Observe bounded visible text and up to 100 element references; no form values. References expire on navigation, tab changes and handoff.",
      parameters: Type.Object({}),
      execute: async (_id, args, signal) =>
        result(await computer().action("snapshot", {}, signal)),
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
        result(await computer().action("fill", args, signal)),
    }),
    define({
      name: "browser_upload",
      label: "Upload browser files",
      description:
        "Select local files in this agent's browser using a fresh browser_snapshot reference to a file input or the button that opens its file chooser. Call this instead of clicking the upload button first; it handles hidden inputs without an OS dialog. Paths resolve from the agent working directory. Only upload files authorized for this website, never credentials. Maximum 10 files and 50 MiB total per call. Blocked during human control. Selection does not prove the website finished uploading; inspect it before saving or publishing.",
      parameters: Type.Object({
        ref: Type.String({ minLength: 1 }),
        paths: Type.Array(
          Type.String({ minLength: 1, maxLength: 4096 }),
          { minItems: 1, maxItems: 10 },
        ),
      }),
      execute: async (_id, args, signal) =>
        result(await computer().action("upload", {
          ref: args.ref,
          paths: args.paths.map(path => resolve(cwd, path)),
        }, signal)),
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
        result(await computer().action("tabs", args, signal)),
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
        result(await computer().action("scroll", args, signal)),
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
        result(await computer().action("wait_for", args, signal)),
    }),
    define({
      name: "browser_diagnostics",
      label: "Browser diagnostics",
      description:
        "Return up to 50 redacted console/page errors and request failure events. No raw messages or URLs. Blocked during human control.",
      parameters: Type.Object({}),
      execute: async (_id, args, signal) =>
        result(await computer().action("diagnostics", {}, signal)),
    }),
    define({
      name: "browser_type",
      label: "Type in browser",
      description:
        "Insert non-secret text in this agent’s focused browser field. For credentials request_browser_login instead.",
      parameters: Type.Object({ text: Type.String({ maxLength: 24000 }) }),
      execute: async (_id, args, signal) =>
        result(await computer().action("type", args, signal)),
    }),
    define({
      name: "browser_key",
      label: "Press browser key",
      description:
        "Press a key or shortcut in this agent’s browser session, for example Enter, Tab, Control+l.",
      parameters: Type.Object({ key: Type.String({ maxLength: 100 }) }),
      execute: async (_id, args, signal) =>
        result(await computer().action("key", args, signal)),
    }),
  ];
}
