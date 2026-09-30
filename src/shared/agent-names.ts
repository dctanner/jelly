export const DEFAULT_AGENT_NAME = "New Agent";

/** Accept a short display name, not model prose, markup, URLs, or tool calls. */
export function generatedAgentName(value: string): string | null {
  const name = value
    .trim()
    .replace(/^(["'])((?:.|\n)*)\1$/, "$2")
    .trim();
  if (
    name === DEFAULT_AGENT_NAME ||
    name.split(/\s+/).length > 4 ||
    !/^[\p{L}\p{N}][\p{L}\p{N} '\u2019-]{0,59}$/u.test(name)
  )
    return null;
  return name;
}
