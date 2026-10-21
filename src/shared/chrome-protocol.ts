/** Private native bridge protocol. No raw CDP or model-supplied identities. */
export const CHROME_PROTOCOL = 7;
export const CHROME_MAX_FRAME = 768 * 1024;
export const CHROME_METHODS = [
  "freeze",
  "unfreeze",
  "begin",
  "name",
  "end",
  "open",
  "snapshot",
  "screenshot",
  "click",
  "fill",
  "select",
  "key",
  "wait_for",
  "scroll",
  "tabs",
  "pause",
  "resume",
  "focus",
  "mark",
] as const;
export type ChromeMethod = (typeof CHROME_METHODS)[number];
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
  browserTarget: "managed" | "chrome";
  chromeProfile: string;
  chromeOrigins: string[];
  chromeSiteScope?: "approved" | "internet";
}
export const defaultChromeSelection = (): ChromeSelection => ({
  browserTarget: "managed",
  chromeProfile: "",
  chromeOrigins: [],
});
/** Canonical HTTP endpoint; WebSocket resources share their HTTP(S) endpoint. */
export function chromeWebEndpoint(value: string): string {
  const u = new URL(value);
  if (u.protocol === "ws:") u.protocol = "http:";
  if (u.protocol === "wss:") u.protocol = "https:";
  if (!["http:", "https:"].includes(u.protocol))
    throw new Error("Chrome requires web origins.");
  u.hostname = u.hostname.replace(/\.+$/, "");
  return u.origin;
}
export function chromeOrigin(
  value: unknown,
  protectedOrigins: string[] = [],
): string {
  if (typeof value !== "string" || value.length > 2048)
    throw new Error("Invalid Chrome site scope.");
  const u = new URL(value);
  if (u.username || u.password || !["https:", "http:"].includes(u.protocol))
    throw new Error("Chrome requires approved web origins without credentials.");
  const origin = chromeWebEndpoint(value);
  if (protectedOrigins.some((protectedOrigin) => {
    try { return chromeWebEndpoint(protectedOrigin) === origin; }
    catch { return true; }
  }))
    throw new Error("Jelly/control sites are unavailable in Connected Chrome.");
  return origin;
}
export function chromeRequest(value: unknown): value is ChromeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    r.jsonrpc === "2.0" &&
    CHROME_METHODS.includes(r.method as ChromeMethod) &&
    ["id", "instance", "generation", "session", "run"].every(
      (k) =>
        typeof r[k] === "string" &&
        (r[k] as string).length > 0 &&
        (r[k] as string).length <= 128,
    ) &&
    !!r.params &&
    typeof r.params === "object" &&
    !Array.isArray(r.params) &&
    chromeParams(
      r.method as ChromeMethod,
      r.params as Record<string, unknown>,
    ) &&
    Object.keys(r).every((k) =>
      [
        "jsonrpc",
        "id",
        "method",
        "instance",
        "generation",
        "session",
        "run",
        "params",
      ].includes(k),
    )
  );
}
export function chromeParams(
  method: ChromeMethod,
  p: Record<string, unknown>,
): boolean {
  const keys: Record<ChromeMethod, string[]> = {
    freeze: [],
    unfreeze: [],
    begin: ["name", "agent", "origins", "protected", "siteScope"],
    name: ["name", "tab"],
    end: ["discard"],
    open: ["url", "tab"],
    snapshot: ["tab"],
    screenshot: ["tab"],
    click: ["tab", "ref"],
    fill: ["tab", "ref", "text"],
    select: ["tab", "ref", "value"],
    key: ["tab", "ref", "key"],
    wait_for: ["tab", "condition", "text", "timeoutMs"],
    scroll: ["tab", "x", "y"],
    tabs: ["operation", "pageId", "url", "tab"],
    pause: [],
    resume: [],
    focus: ["tab"],
    mark: ["tab", "mark"],
  };
  if (!keys[method] || Object.keys(p).some((k) => !keys[method].includes(k)))
    return false;
  const string = (v: unknown, max: number) =>
    typeof v === "string" && v.length > 0 && v.length <= max;
  if (p.tab !== undefined && p.tab !== null && !string(p.tab, 128))
    return false;
  if (method === "begin")
    return (
      string(p.name, 100) &&
      (p.siteScope === undefined ||
        ["approved", "internet"].includes(String(p.siteScope))) &&
      (p.agent === undefined || string(p.agent, 128)) &&
      [p.origins, p.protected].every(
        (v) =>
          Array.isArray(v) &&
          v.length <= 100 &&
          v.every((s) => string(s, 2048)),
      )
    );
  if (method === "name") return string(p.name, 55);
  if (method === "end")
    return p.discard === undefined || typeof p.discard === "boolean";
  if (method === "open") return string(p.url, 4096);
  if (method === "click" || method === "fill")
    return (
      string(p.ref, 128) &&
      (method !== "fill" ||
        (typeof p.text === "string" && p.text.length <= 24000))
    );
  if (method === "select")
    return (
      string(p.ref, 128) &&
      typeof p.value === "string" &&
      p.value.length <= 1000
    );
  if (method === "key")
    return (
      string(p.ref, 128) &&
      [
        "Enter",
        "Space",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Escape",
      ].includes(String(p.key))
    );
  if (method === "wait_for")
    return (
      ["text", "text_absent", "ready"].includes(String(p.condition)) &&
      (p.condition === "ready" || string(p.text, 200)) &&
      (p.timeoutMs === undefined ||
        (typeof p.timeoutMs === "number" &&
          p.timeoutMs >= 0 &&
          p.timeoutMs <= 10000))
    );
  if (method === "scroll")
    return [p.x ?? 0, p.y].every(
      (v) =>
        typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 10000,
    );
  if (method === "tabs")
    return (
      ["list", "new", "select", "close"].includes(String(p.operation)) &&
      (p.pageId === undefined || string(p.pageId, 128)) &&
      (p.url === undefined || string(p.url, 4096))
    );
  if (method === "mark")
    return ["temporary", "deliverable", "handoff"].includes(String(p.mark));
  return true;
}
/** Incremental bounded native-endian framing (supported Linux machines are LE). */
export class ChromeFrames {
  private buffer = Buffer.alloc(0);
  push(chunk: Uint8Array): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const values: unknown[] = [];
    while (this.buffer.length >= 4) {
      const n = this.buffer.readUInt32LE(0);
      if (!n || n > CHROME_MAX_FRAME)
        throw new Error("Invalid Chrome frame size.");
      if (this.buffer.length < n + 4) break;
      values.push(JSON.parse(this.buffer.subarray(4, n + 4).toString("utf8")));
      this.buffer = this.buffer.subarray(n + 4);
      if (values.length > 128) throw new Error("Chrome frame flood.");
    }
    if (this.buffer.length > CHROME_MAX_FRAME + 4)
      throw new Error("Chrome frame overflow.");
    return values;
  }
}
export function chromeFrame(value: unknown) {
  const data = Buffer.from(JSON.stringify(value));
  if (!data.length || data.length > CHROME_MAX_FRAME)
    throw new Error("Chrome message too large.");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(data.length);
  return Buffer.concat([prefix, data]);
}
