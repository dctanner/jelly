import { chromeWebEndpoint } from "./chrome-protocol";

/** RE2 has no negative lookahead. Build small block-only rules for everything
 * except web-scheme prefixes; there is no site/origin allowlist.
 * Callers must include main_frame: Chrome's default resourceTypes excludes it.
 */
function nonWebSchemeRegexes(): string[] {
  interface Trie {
    terminal: boolean;
    children: Map<string, Trie>;
  }
  const node = (): Trie => ({ terminal: false, children: new Map() });
  const root = node();
  for (const prefix of ["http://", "https://", "ws://", "wss://"]) {
    let current = root;
    for (const char of prefix) {
      if (!current.children.has(char)) current.children.set(char, node());
      current = current.children.get(char)!;
    }
    current.terminal = true;
  }
  const result: string[] = [];
  function visit(current: Trie, prefix: string) {
    if (current.terminal) return;
    result.push(`^${prefix}(?:$|[^${[...current.children.keys()].join("")}])`);
    for (const [char, next] of current.children) visit(next, prefix + char);
  }
  visit(root, "");
  return result;
}

/** All websites are accessible. Only exact control endpoints are protected:
 * other ports on the same machine may host unrelated applications.
 * Chrome canonicalizes numeric IPs/IPv6 before DNR matching.
 */
export function chromeInternetDenyRegexes(protectedOrigins: string[]): string[] {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return [
    ...nonWebSchemeRegexes(),
    // Reject userinfo independently of destination (including deceptive hosts).
    "^(?:https?|wss?)://[^/]*@",
    ...protectedOrigins.map((origin) => {
      const u = new URL(chromeWebEndpoint(origin));
      const scheme = u.protocol === "https:" ? "(?:https|wss)" : "(?:http|ws)";
      const port = u.port ? `:${u.port}` : `(?::${u.protocol === "https:" ? "443" : "80"})?`;
      return `^${scheme}://(?:[^/@]*@)?${escape(u.hostname)}\\.*${port}(?:/|$)`;
    }),
  ];
}
