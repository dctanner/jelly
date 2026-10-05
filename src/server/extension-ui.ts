import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** Web-host binding for Pi's RPC UI semantics. Terminal factories remain degraded
 * as in Pi RPC. Unsupported dialogs cancel explicitly instead of approving/hanging.
 */
export function extensionUI(
  base: ExtensionUIContext,
  report: (type: string, data: Record<string, unknown>) => void,
  widget: (key: string, lines: string[] | undefined) => void,
): ExtensionUIContext {
  const statuses = new Map<string, string | undefined>();
  const notify = (message: string, level = "info") =>
    report("extension_notice", { text: message.slice(0, 4000), level });
  const cancelled = async (title: string) => {
    notify(
      `Extension dialog cancelled: ${title.slice(0, 200)}. This dialog is not supported in Jelly; use a native Jelly handoff.`,
      "warning",
    );
    return undefined;
  };
  return {
    ...base,
    notify,
    select: cancelled,
    input: cancelled,
    editor: cancelled,
    confirm: async (title) => {
      await cancelled(title);
      return false;
    },
    setWidget: (key, content) => {
      if (content === undefined || Array.isArray(content)) widget(key, content);
    },
    setStatus: (key, text) => {
      if (statuses.get(key) === text) return;
      if (statuses.size >= 64 && !statuses.has(key)) return;
      if (text === undefined) statuses.delete(key);
      else statuses.set(key, text);
      report("extension_status", {
        key: key.slice(0, 128),
        text: text?.slice(0, 1000) ?? "",
      });
    },
    setTitle: () => {}, // The Jelly agent, not an extension, owns the conversation title.
    setEditorText: () =>
      notify("Extension editor changes are not supported in Jelly.", "warning"),
    pasteToEditor: () =>
      notify("Extension editor changes are not supported in Jelly.", "warning"),
  };
}
