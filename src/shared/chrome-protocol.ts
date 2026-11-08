/** Private native bridge protocol v9: a thin CDP relay plus tab/lease/group
 * management. All observation and action logic lives on the Jelly server. */
export const CHROME_PROTOCOL = 9;
/** Extension→host native messages (CDP results such as DOMSnapshot) may be large. */
export const CHROME_MAX_FRAME = 32 * 1024 * 1024;
/** Chrome limits host→extension native messages to 1 MiB. */
export const CHROME_MAX_REQUEST = 1024 * 1024;
export const CHROME_CDP_TIMEOUT = 10_000;
export const CHROME_CDP_BATCH_TIMEOUT = 30_000;
export const CHROME_CDP_BATCH_MAX = 2000;
export const CHROME_METHODS = [
  "freeze",
  "unfreeze",
  "begin",
  "end",
  "pause",
  "resume",
  "name",
  "createTab",
  "closeTab",
  "listTabs",
  "userTabs",
  "claimTab",
  "markTab",
  "showTab",
  "attach",
  "detach",
  "cdp",
  "cdpBatch",
  "chrome",
] as const;
export type ChromeMethod = (typeof CHROME_METHODS)[number];
/** Namespaces reachable through the `chrome` passthrough method. */
export const CHROME_PASSTHROUGH_NAMESPACES = [
  "tabs",
  "windows",
  "tabGroups",
  "bookmarks",
  "history",
  "downloads",
  "sessions",
  "topSites",
  "cookies",
] as const;
export type ChromeTabMark = "deliverable" | "handoff" | null;
export interface ChromeTabInfo {
  id: number;
  title: string;
  /** Committed URL (falls back to the pending URL before the first commit). */
  url: string;
  /** Present while a different navigation is pending. */
  pendingUrl?: string;
  windowId: number;
  active: boolean;
  origin: "agent" | "user";
  mark: ChromeTabMark;
}
export interface ChromeUserTabInfo {
  id: number;
  title: string;
  url: string;
  windowId: number;
  active: boolean;
  lastAccessed: number | null;
  groupId: number;
  pinned: boolean;
}
export interface ChromeCdpEvent {
  tabId: number;
  sessionId?: string;
  method: string;
  params: unknown;
}
export interface ChromeCdpDetach {
  tabId: number;
  reason: string;
}
export interface ChromeRequest {
  jsonrpc: "2.0";
  id: string;
  method: ChromeMethod;
  instance: string;
  generation: string;
  session: string;
  run: string;
  params: Record<string, unknown>;
}
export interface ChromeProfile {
  id: string;
  generation: string;
  connected: boolean;
  desktopAvailable?: boolean;
}
export interface ChromeSelection {
  chromeProfile: string;
}
export const defaultChromeSelection = (): ChromeSelection => ({
  chromeProfile: "",
});
const ENVELOPE_KEYS = ["jsonrpc", "id", "method", "instance", "generation", "session", "run", "params"];
const plainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
/** Envelope only (ids and routing); params are checked by chromeParamsError. */
export function chromeEnvelope(value: unknown): value is Omit<ChromeRequest, "method"> & { method: string } {
  if (!plainObject(value)) return false;
  return (
    value.jsonrpc === "2.0" &&
    typeof value.method === "string" &&
    ["id", "instance", "generation", "session", "run"].every(
      (k) => typeof value[k] === "string" && (value[k] as string).length > 0 && (value[k] as string).length <= 128,
    ) &&
    plainObject(value.params) &&
    Object.keys(value).every((k) => ENVELOPE_KEYS.includes(k))
  );
}
export function chromeRequest(value: unknown): value is ChromeRequest {
  return (
    chromeEnvelope(value) &&
    CHROME_METHODS.includes(value.method as ChromeMethod) &&
    chromeParamsError(value.method as ChromeMethod, value.params) === undefined
  );
}
export function chromeParams(method: ChromeMethod, p: Record<string, unknown>): boolean {
  return chromeParamsError(method, p) === undefined;
}
const tabId = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
const timeout = (v: unknown) =>
  v === undefined || (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 600_000);
const cdpMethod = (v: unknown) => typeof v === "string" && /^[A-Za-z][\w]*\.[A-Za-z][\w]*$/.test(v) && v.length <= 256;
/** Returns a specific validation error, or undefined when params are valid. */
export function chromeParamsError(method: ChromeMethod, p: Record<string, unknown>): string | undefined {
  const keys: Record<ChromeMethod, string[]> = {
    freeze: [],
    unfreeze: [],
    begin: ["name", "agent"],
    end: ["discard"],
    pause: [],
    resume: [],
    name: ["name"],
    createTab: ["url"],
    closeTab: ["tabId"],
    listTabs: [],
    userTabs: [],
    claimTab: ["tabId"],
    markTab: ["tabId", "mark"],
    showTab: ["tabId"],
    attach: ["tabId"],
    detach: ["tabId"],
    cdp: ["tabId", "sessionId", "method", "params", "timeoutMs"],
    cdpBatch: ["tabId", "sessionId", "commands", "timeoutMs"],
    chrome: ["namespace", "method", "args"],
  };
  const allowed = keys[method];
  if (!allowed) return `Unknown Chrome method "${String(method)}".`;
  if (!plainObject(p)) return `${method}: params must be an object.`;
  const extra = Object.keys(p).filter((k) => !allowed.includes(k));
  if (extra.length) return `${method}: unexpected parameter(s) ${extra.join(", ")}.`;
  if (allowed.includes("tabId") && !tabId(p.tabId)) return `${method}: tabId must be a non-negative integer.`;
  if ((method === "cdp" || method === "cdpBatch") && p.sessionId !== undefined && !text(p.sessionId, 128))
    return `${method}: sessionId must be a non-empty string.`;
  if ((method === "cdp" || method === "cdpBatch") && !timeout(p.timeoutMs))
    return `${method}: timeoutMs must be a positive number of milliseconds (max 600000).`;
  switch (method) {
    case "begin":
      if (!text(p.name, 200)) return "begin: name must be a non-empty string (max 200 chars).";
      if (p.agent !== undefined && !text(p.agent, 128)) return "begin: agent must be a non-empty string.";
      return;
    case "end":
      if (p.discard !== undefined && typeof p.discard !== "boolean") return "end: discard must be a boolean.";
      return;
    case "name":
      if (!text(p.name, 200)) return "name: name must be a non-empty string (max 200 chars).";
      return;
    case "createTab":
      if (p.url !== undefined && !text(p.url, CHROME_MAX_REQUEST)) return "createTab: url must be a non-empty string.";
      return;
    case "markTab":
      if (!["deliverable", "handoff", null].includes(p.mark as string | null))
        return 'markTab: mark must be "deliverable", "handoff" or null.';
      return;
    case "cdp":
      if (!cdpMethod(p.method)) return 'cdp: method must be a CDP method name such as "Runtime.evaluate".';
      if (p.params !== undefined && !plainObject(p.params)) return "cdp: params must be an object.";
      return;
    case "cdpBatch": {
      if (!Array.isArray(p.commands) || p.commands.length === 0 || p.commands.length > CHROME_CDP_BATCH_MAX)
        return `cdpBatch: commands must be an array of 1-${CHROME_CDP_BATCH_MAX} commands.`;
      for (const [i, c] of p.commands.entries()) {
        if (!plainObject(c) || Object.keys(c).some((k) => k !== "method" && k !== "params"))
          return `cdpBatch: command ${i} must be {method, params?}.`;
        if (!cdpMethod(c.method)) return `cdpBatch: command ${i} has an invalid CDP method name.`;
        if (c.params !== undefined && !plainObject(c.params)) return `cdpBatch: command ${i} params must be an object.`;
      }
      return;
    }
    case "chrome":
      if (!CHROME_PASSTHROUGH_NAMESPACES.includes(p.namespace as (typeof CHROME_PASSTHROUGH_NAMESPACES)[number]))
        return `chrome: namespace must be one of ${CHROME_PASSTHROUGH_NAMESPACES.join(", ")}.`;
      if (typeof p.method !== "string" || !/^[a-z][A-Za-z0-9]{0,63}$/.test(p.method))
        return "chrome: method must be a chrome API function name.";
      if (!Array.isArray(p.args)) return "chrome: args must be an array.";
      return;
  }
}
/** Incremental bounded native-endian framing (supported machines are LE).
 * Chunks are only concatenated once a complete frame is available, so large
 * (multi-MiB) frames arriving in many small chunks stay linear. */
export class ChromeFrames {
  private chunks: Buffer[] = [];
  private size = 0;
  push(chunk: Uint8Array): unknown[] {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (data.length) {
      this.chunks.push(data);
      this.size += data.length;
    }
    const values: unknown[] = [];
    while (this.size >= 4) {
      if (this.chunks[0]!.length < 4) this.chunks = [Buffer.concat(this.chunks)];
      const n = this.chunks[0]!.readUInt32LE(0);
      if (!n || n > CHROME_MAX_FRAME) throw new Error("Invalid Chrome frame size.");
      if (this.size < n + 4) break;
      if (this.chunks[0]!.length < n + 4) this.chunks = [Buffer.concat(this.chunks)];
      const head = this.chunks[0]!;
      values.push(JSON.parse(head.subarray(4, n + 4).toString("utf8")));
      const rest = head.subarray(n + 4);
      if (rest.length) this.chunks[0] = rest;
      else this.chunks.shift();
      this.size -= n + 4;
    }
    return values;
  }
}
export function chromeFrame(value: unknown, max = CHROME_MAX_FRAME) {
  const data = Buffer.from(JSON.stringify(value) ?? "null");
  if (!data.length || data.length > max) throw new Error(`Chrome message too large (${data.length} bytes; limit ${max}).`);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(data.length);
  return Buffer.concat([prefix, data]);
}
