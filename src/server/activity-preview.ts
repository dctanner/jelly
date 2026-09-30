/** Plain text for the inbox only; keep the original thinking transcript intact. */
function plainThinkingLine(text: string): string {
  // Protect code contents so identifiers and operators aren't treated as markup.
  const code: string[] = [];
  return text.trim()
    .replace(/^(`{3,}|~{3,})[^\s]*\s*$/, "")
    .replace(/(`+)(.*?)\1/g, (_match, _ticks, value: string) => `\u0000${code.push(value) - 1}\u0000`)
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:>\s*)+/, "")
    .replace(/^(?:[-+*]|\d+[.)])\s+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|~~/g, "")
    .replace(/(^|\s)__([^_]+)__(?=$|[\s.,!?;:])/g, "$1$2")
    .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=$|[\s.,!?;:])/g, "$1$2")
    // Streaming text can end before the closing delimiter arrives.
    .replace(/(^|\s)(?:__|[*_])(?=\S)/g, "$1")
    .replace(/`/g, "")
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => code[Number(index)] ?? "")
    .replace(/\s+/g, " ").trim();
}

/** Latest nonempty displayable line, stripped before applying the inbox limit. */
export function thinkingPreview(text: string): string {
  const lines = text.split(/\r?\n|\r/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = plainThinkingLine(lines[index]!);
    if (line) return line.length > 220 ? line.slice(0, 219) + "…" : line;
  }
  return "";
}

/** Fixed fallback labels; never expose tool commands, arguments or results. */
export function activityPreview(
  name: string | null,
  command: string | null,
): string {
  if (!name) return "Thinking…";
  const tool = name.split(".").at(-1)!;
  if (tool === "bash" || tool === "powershell") {
    return command &&
      /^(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|check|lint|typecheck)(?:\s|:|$)|(?:pytest|tsc)(?:\s|$))/.test(
        command.trim(),
      )
      ? "Running checks…"
      : "Running a command…";
  }
  const labels: Record<string, string> = {
    read: "Reading files…",
    write: "Writing files…",
    edit: "Editing files…",
    grep: "Searching files…",
    find: "Finding files…",
    ls: "Listing files…",
    web_search: "Searching the web…",
    web_fetch: "Reading a webpage…",
    generate_image: "Creating an image…",
    render_file: "Preparing a preview…",
    subagent: "Working with subagents…",
    bg_wait: "Waiting for background work…",
    instance_info: "Checking the workspace…",
    request_sudo: "Waiting for administrator access…",
    request_browser_login: "Waiting for browser sign-in…",
  };
  return (
    labels[tool] ??
    (tool.startsWith("browser_") ? "Using the browser…" : "Using a tool…")
  );
}
