import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Computer } from "./computer";
import type { Interventions } from "./interventions";
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: {},
});
const define = <T extends TSchema>(tool: ToolDefinition<T>): ToolDefinition =>
  tool as ToolDefinition;
export function interventionTools(
  computer: Computer,
  requests: Interventions,
  agentId: string,
  runId: string,
  cwd: string,
): ToolDefinition[] {
  return [
    define({
      name: "request_sudo",
      label: "Run sudo",
      description:
        "Run one command with root privileges immediately. Request private password entry only if sudo requires authentication. Never request or supply a password in chat or tool arguments.",
      parameters: Type.Object({
        executable: Type.String({ description: "Absolute executable path" }),
        args: Type.Array(Type.String()),
        reason: Type.String(),
      }),
      execute: async (_id, args, signal) =>
        result(await requests.sudo(agentId, runId, { ...args, cwd }, signal)),
    }),
    define({
      name: "request_browser_login",
      label: "Request browser login",
      description:
        "Open a website in the shared browser and wait for the user to sign in privately and return control. Never ask for login credentials in chat.",
      parameters: Type.Object({
        url: Type.String(),
        reason: Type.String({ maxLength: 2000 }),
      }),
      execute: async (_id, args, signal) => {
        const pending = requests.request(
          "browser_login",
          agentId,
          runId,
          args,
          signal,
        );
        void pending.promise.catch(() => {});
        try {
          await computer.reserveLogin(pending.request.id, args.url);
          return result(await pending.promise);
        } catch (e) {
          requests.cancel(pending.request.id);
          throw e;
        } finally {
          computer.cancelLogin(pending.request.id);
        }
      },
    }),
    define({
      name: "browser_open",
      label: "Open website",
      description: "Navigate the shared browser. Blocked during human control.",
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_id, args) => result(await computer.action("open", args)),
    }),
    define({
      name: "browser_screenshot",
      label: "Browser screenshot",
      description:
        "Inspect the shared browser viewport. Blocked during human control.",
      parameters: Type.Object({}),
      execute: async () => {
        const value = (await computer.action("screenshot")) as {
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
      description: "Click viewport coordinates in the shared browser.",
      parameters: Type.Object({ x: Type.Number(), y: Type.Number() }),
      execute: async (_id, args) =>
        result(await computer.action("click", args)),
    }),
    define({
      name: "browser_type",
      label: "Type in browser",
      description:
        "Insert non-secret text in the focused browser field. For credentials request_browser_login instead.",
      parameters: Type.Object({ text: Type.String({ maxLength: 24000 }) }),
      execute: async (_id, args) => result(await computer.action("type", args)),
    }),
    define({
      name: "browser_key",
      label: "Press browser key",
      description:
        "Press a key or shortcut, for example Enter, Tab, Control+l.",
      parameters: Type.Object({ key: Type.String({ maxLength: 100 }) }),
      execute: async (_id, args) => result(await computer.action("key", args)),
    }),
  ];
}
