/** Versioned host liveness protocol supported by pi-subagents (also used by pi-web).
 * Keep notification batching and nested routes alive, not just visible root jobs.
 * No imports from package internals and no process-global parent identity.
 */
interface Provider {
  name: string;
  sessionId: string;
  isActive: () => boolean;
}
const providers = new Map<string, Set<Provider>>();
const key = Symbol.for("@agegr/pi-web/session-liveness/v1");
export function installSubagentLiveness() {
  const host = globalThis as unknown as Record<symbol, unknown>;
  if (host[key])
    throw new Error("Another host owns the session liveness registry.");
  host[key] = {
    version: 1,
    register(provider: Provider) {
      if (
        !provider ||
        typeof provider.sessionId !== "string" ||
        typeof provider.isActive !== "function"
      )
        throw new Error("Invalid session liveness provider");
      const set = providers.get(provider.sessionId) ?? new Set<Provider>();
      providers.set(provider.sessionId, set);
      set.add(provider);
      return () => {
        set.delete(provider);
        if (!set.size) providers.delete(provider.sessionId);
      };
    },
  };
}
let installed = false;
export function prepareSubagentLiveness() {
  if (!installed) {
    installSubagentLiveness();
    installed = true;
  }
}
export function subagentLiveness(sessionId: string): boolean | undefined {
  const set = providers.get(sessionId);
  if (!set?.size) return undefined;
  // A provider failure must not silently make a session disposable.
  return [...set].some((provider) => provider.isActive());
}
