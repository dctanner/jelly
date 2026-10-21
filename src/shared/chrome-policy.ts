import { chromeWebEndpoint } from "./chrome-protocol";

/** RE2-compatible complement of finite approved URL prefixes, split into small
 * block-only rules, avoiding priority interactions with allow exemptions.
 * Splitting avoids Chrome's 2 KiB compiled-regex limit. Callers must explicitly
 * include main_frame: Chrome's default resourceTypes excludes it.
 */
export function chromeDenyRegexes(origins: string[]): string[] {
  interface Trie {
    terminal: boolean;
    dottedHost: boolean;
    dotTarget?: Trie;
    children: Map<string, Trie>;
  }
  const node = (): Trie => ({ terminal: false, dottedHost: false, children: new Map() });
  const root = node();
  for (const origin of origins) {
    let current = root;
    let hostEnd = -1;
    try {
      const u = new URL(origin);
      if (!u.hostname.startsWith("["))
        hostEnd = `${u.protocol}//${u.hostname}`.length;
    } catch { /* Scheme-only prefixes have no hostname boundary. */ }
    let offset = 0;
    for (const char of `${origin}/`) {
      if (offset++ === hostEnd) current.dottedHost = true;
      if (!current.children.has(char)) current.children.set(char, node());
      current = current.children.get(char)!;
    }
    current.terminal = true;
  }
  function suffixes(current: Trie) {
    for (const child of current.children.values()) suffixes(child);
    if (!current.dottedHost) return;
    const suffix = node();
    suffix.dottedHost = true;
    suffix.dotTarget = suffix;
    // Once a trailing dot is consumed only the port/path can follow, never
    // another hostname label (example.com..child is not example.com.child).
    for (const char of [":", "/"]) {
      const child = current.children.get(char);
      if (child) suffix.children.set(char, child);
    }
    current.dotTarget = suffix;
  }
  suffixes(root);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const result: string[] = [];
  // Determinize the dotted-host loops together with the prefix trie. A dot can
  // both extend an approved hostname and start another approved subdomain, so
  // simply inserting \.* in individual prefix rules would overblock that union.
  function visit(states: Set<Trie>, prefix: string) {
    if ([...states].some(s => s.terminal)) return;
    const edges = new Map<string, Set<Trie>>();
    for (const state of states) {
      for (const [char, next] of state.children) {
        if (!edges.has(char)) edges.set(char, new Set());
        edges.get(char)!.add(next);
      }
      if (state.dottedHost) {
        if (!edges.has(".")) edges.set(".", new Set());
        edges.get(".")!.add(state.dotTarget!);
      }
    }
    const dots = edges.get(".");
    const loops = dots && dots.size === states.size && [...dots].every(s => states.has(s));
    if (loops) prefix += "\\.*";
    result.push(`^${prefix}(?:$|[^${[...edges.keys()].map(escape).join("")}])`);
    for (const [char, next] of edges) {
      if (char === "." && loops) continue;
      visit(next, prefix + escape(char));
    }
  }
  if (!origins.length) return [".*"];
  visit(new Set([root]), "");
  return result;
}

/** Web access without an address allowlist. Only exact control endpoints are
 * protected: other ports on the same machine may host unrelated applications.
 * Chrome canonicalizes numeric IPs/IPv6 before DNR matching.
 */
export function chromeInternetDenyRegexes(protectedOrigins: string[]): string[] {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return [
    ...chromeDenyRegexes(["http:/", "https:/", "ws:/", "wss:/"]),
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
