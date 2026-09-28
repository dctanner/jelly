/** Short, fixed labels only: never put commands, arguments, results or thoughts
 * into another agent's inbox preview. */
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
