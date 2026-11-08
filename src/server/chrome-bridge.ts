import { createServer, type Socket, type Server } from "node:net";
import {
  mkdirSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  unlinkSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  opendirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  CHROME_PROTOCOL,
  CHROME_METHODS,
  CHROME_MAX_REQUEST,
  ChromeFrames,
  chromeFrame,
  type ChromeMethod,
  type ChromeProfile,
  type ChromeTabInfo,
  type ChromeCdpEvent,
} from "../shared/chrome-protocol";
import { ChromeWriter } from "./chrome-writer";
import { chromePauseReason, type ChromePauseReason } from "../shared/chrome-errors";
export const CHROME_REQUEST_TIMEOUT = 30_000;
export const CHROME_MAX_PENDING = 256;
const ERROR_MESSAGE_LIMIT = 2000;
const routing = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 128;
const tabId = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
import { validChromeDesktop, type ChromeDesktop } from "./chrome-desktop";
interface Peer {
  socket: Socket;
  writer: ChromeWriter;
  profile: string;
  generation: string;
  desktop: ChromeDesktop;
  pending: Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
}
export class ChromeBridge {
  readonly directory: string;
  readonly ready: Promise<void>;
  private server: Server;
  private blocked = new Set<string>();
  private admissionFailed = false;
  private saveBlocked() {
    const path = join(this.directory, "disconnected-profiles.json");
    const temporary = `${path}.${randomBytes(8).toString("hex")}`;
    try {
      writeFileSync(temporary, JSON.stringify([...this.blocked]), { mode: 0o600, flag: "wx" });
      const fd = openSync(temporary, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      // Commit the transaction's existence before replacement: a failed rename
      // must leave durable evidence rather than revive the older permissive file.
      const intentDirectory = openSync(this.directory, "r");
      try { fsyncSync(intentDirectory); } finally { closeSync(intentDirectory); }
      renameSync(temporary, path);
      const directory = openSync(this.directory, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (error) {
      this.admissionFailed = true;
      throw error;
    }
    // Failed transactions deliberately remain for fail-closed startup/repair.
  }
  private blockOverflow(profile: string): never {
    this.admissionFailed = true;
    // One reserved, bounded marker denies ALL admission, including later
    // disconnects that cannot fit in the profile set. Never overwrite it.
    const path = join(this.directory, "disconnected-profiles.json.overflow");
    writeFileSync(path, JSON.stringify({ blockedAll: true, profile }), { mode: 0o600, flag: "wx" });
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const directory = openSync(this.directory, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    throw new Error("Chrome disconnect state is full; repair required.");
  }
  private peers = new Map<string, Peer>();
  attestDesktop: (desktop: ChromeDesktop, parent: unknown, ownedDesktop: ChromeDesktop) => ChromeDesktop | null = () => null;
  private sockets = new Set<Socket>();
  private grant: string;
  private extensionId: string | null = null;
  private closing = false;
  onDesktopLoss: (profile: string) => void = () => {};
  desktop(profile: string, generation: string) {
    const p = this.peers.get(profile);
    if (!p || p.generation !== generation || !p.desktop.available)
      throw new Error("Web desktop unavailable. Requires the native host's local Linux X11 session and private XAUTHORITY.");
    return validChromeDesktop(p.desktop);
  }
  onLoss: (profile: string) => void = () => {};
  onPauseState: (
    profile: string,
    generation: string,
    session: string,
    run: string,
    state: "pausing" | "paused" | "failed",
    reason?: ChromePauseReason,
  ) => void = () => {};
  /** Every chrome.debugger.onEvent for a tab leased by (session, run). */
  onCdpEvent: (
    profile: string,
    generation: string,
    session: string,
    run: string,
    event: ChromeCdpEvent,
  ) => void = () => {};
  /** chrome.debugger.onDetach for a leased tab; the session is not paused. */
  onCdpDetach: (
    profile: string,
    generation: string,
    session: string,
    run: string,
    tabId: number,
    reason: string,
  ) => void = () => {};
  /** A popup/target=_blank opened from a leased tab was auto-leased. */
  onTabAdded: (
    profile: string,
    generation: string,
    session: string,
    run: string,
    tab: ChromeTabInfo,
  ) => void = () => {};
  onTabRemoved: (
    profile: string,
    generation: string,
    session: string,
    run: string,
    tabId: number,
  ) => void = () => {};
  constructor(
    dataDir: string,
    readonly instance: string,
  ) {
    this.directory = join(resolve(dataDir), "chrome-bridge");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const dir = lstatSync(this.directory);
    if (
      !dir.isDirectory() ||
      dir.isSymbolicLink() ||
      dir.uid !== process.getuid?.()
    )
      throw new Error("Unsafe Chrome bridge directory.");
    chmodSync(this.directory, 0o700);
    // A process interruption before rename may leave uncommitted disconnect
    // intent. Never interpret the older file as permission to reconnect.
    const entries = opendirSync(this.directory);
    try {
      let count = 0;
      for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
        if (++count > 128) throw new Error("Chrome bridge state needs repair.");
        if (/^disconnected-profiles\.json\.(?:[a-f0-9]{16}|overflow)$/.test(entry.name))
          throw new Error("Interrupted Chrome disconnect state needs repair.");
      }
    } finally { entries.closeSync(); }
    const blockedPath = join(this.directory, "disconnected-profiles.json");
    try {
      const stat = lstatSync(blockedPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
          stat.mode & 0o077 || stat.size > 65536) throw new Error("Unsafe Chrome disconnect state.");
      const blocked = JSON.parse(readFileSync(blockedPath, "utf8"));
      if (!Array.isArray(blocked) || blocked.length > 1024 ||
          !blocked.every(id => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id)))
        throw new Error("Invalid Chrome disconnect state.");
      this.blocked = new Set(blocked);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const configPath = join(this.directory, "pairing.json");
    if (existsSync(configPath)) {
      const stat = lstatSync(configPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077
      )
        throw new Error("Unsafe Chrome pairing file.");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (config.instance !== instance || !/^[a-f0-9]{64}$/.test(config.grant))
        throw new Error("Invalid Chrome pairing configuration.");
      this.grant = config.grant;
    } else {
      this.grant = randomBytes(32).toString("hex");
      writeFileSync(
        configPath,
        JSON.stringify({
          instance,
          grant: this.grant,
          socket: join(this.directory, "bridge.sock"),
        }),
        { mode: 0o600, flag: "wx" },
      );
    }
    const socketPath = join(this.directory, "bridge.sock");
    // The app's instance lock owns this data directory before bridge startup.
    if (existsSync(socketPath)) {
      const s = lstatSync(socketPath);
      if (!s.isSocket() || s.uid !== process.getuid?.())
        throw new Error("Unsafe Chrome socket.");
      unlinkSync(socketPath);
    }
    this.server = createServer((socket) => this.accept(socket));
    this.ready = new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(socketPath, () => {
        chmodSync(socketPath, 0o600);
        resolve();
      });
    });
    void this.ready.catch(() => {});
  }
  profiles(): ChromeProfile[] {
    return [...this.peers.values()].map((p) => ({
      id: p.profile,
      generation: p.generation,
      connected: true,
      desktopAvailable: p.desktop.available,
    }));
  }
  canReconnect(profile: string, generation: string) {
    const peer = this.peers.get(profile);
    // A revoked socket can remain in the map until its asynchronous close
    // callback. Presence in the UI's profile list is not renewal authority.
    return !this.closing && !this.admissionFailed && !this.blocked.has(profile) &&
      !!peer && peer.generation === generation && !peer.socket.destroyed && peer.socket.writable;
  }
  private accept(socket: Socket) {
    if (this.sockets.size >= 8) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    let peer: Peer | undefined;
    const frames = new ChromeFrames();
    const writer = new ChromeWriter(socket, () => socket.destroy());
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      this.sockets.delete(socket);
      if (peer && this.peers.get(peer.profile) === peer) {
        this.peers.delete(peer.profile);
        for (const p of peer.pending.values()) {
          clearTimeout(p.timer);
          p.reject(
            new Error(
              "Chrome disconnected; outcome may be indeterminate. No action was replayed.",
            ),
          );
        }
        peer.pending.clear();
        if (!this.closing) {
          this.onLoss(peer.profile);
          this.onDesktopLoss(peer.profile);
        }
      }
    });
    socket.on("data", (chunk) => {
      if (this.closing) { socket.destroy(); return; }
      try {
        for (const value of frames.push(
          typeof chunk === "string" ? Buffer.from(chunk) : chunk,
        )) {
          const v = value as Record<string, unknown>;
          if (!v || typeof v !== "object") throw new Error();
          if (!peer) {
            const configured = join(this.directory, "extension-id");
            this.extensionId = existsSync(configured)
              ? readFileSync(configured, "utf8").trim()
              : null;
            const token = Buffer.from(
              typeof v.grant === "string" ? v.grant : "",
            );
            const expected = Buffer.from(this.grant);
            if (
              this.admissionFailed ||
              (v.explicitReconnect !== undefined && typeof v.explicitReconnect !== "boolean") ||
              v.type !== "hello" ||
              v.version !== CHROME_PROTOCOL ||
              !Array.isArray(v.capabilities) ||
              CHROME_METHODS.some(
                (method) => !(v.capabilities as unknown[]).includes(method),
              ) ||
              v.instance !== this.instance ||
              !this.extensionId ||
              v.extensionId !== this.extensionId ||
              token.length !== expected.length ||
              !timingSafeEqual(token, expected) ||
              typeof v.profile !== "string" ||
              !/^[a-f0-9-]{36}$/.test(v.profile) ||
              typeof v.generation !== "string" ||
              !/^[a-f0-9-]{36}$/.test(v.generation) ||
              this.peers.has(v.profile)
            )
              throw new Error();
            if (this.blocked.has(v.profile)) {
              if (v.explicitReconnect !== true) {
                writer.write(chromeFrame({ type: "reconnectRequired", generation: v.generation }));
                socket.end();
                return;
              }
              this.blocked.delete(v.profile);
              this.saveBlocked();
            }
            peer = {
              socket,
              writer,
              profile: v.profile,
              generation: v.generation,
              desktop: validChromeDesktop(v.desktop),
              pending: new Map(),
            };
            const attested = this.attestDesktop(peer.desktop, v.ownedParent, validChromeDesktop(v.ownedDesktop));
            if (attested) peer.desktop = attested;
            this.peers.set(peer.profile, peer);
                clearTimeout(timer);
            writer.write(
              chromeFrame({
                type: "paired",
                version: CHROME_PROTOCOL,
                capabilities: CHROME_METHODS,
                instance: this.instance,
                generation: peer.generation,
              }),
            );
          } else if (typeof v.type === "string") {
            if (v.generation !== peer.generation || !routing(v.session) || !routing(v.run))
              throw new Error();
            const session = v.session as string, run = v.run as string;
            if (v.type === "cdpEvent") {
              if (!tabId(v.tabId) || typeof v.method !== "string" ||
                  (v.sessionId !== undefined && typeof v.sessionId !== "string"))
                throw new Error();
              this.onCdpEvent(peer.profile, peer.generation, session, run, {
                tabId: v.tabId as number,
                ...(v.sessionId !== undefined ? { sessionId: v.sessionId as string } : {}),
                method: v.method,
                params: v.params ?? {},
              });
            } else if (v.type === "cdpDetach") {
              if (!tabId(v.tabId) || typeof v.reason !== "string") throw new Error();
              this.onCdpDetach(peer.profile, peer.generation, session, run, v.tabId as number, v.reason);
            } else if (v.type === "tabAdded") {
              const tab = v.tab as Record<string, unknown> | null;
              if (!tab || typeof tab !== "object" || !tabId(tab.id)) throw new Error();
              this.onTabAdded(peer.profile, peer.generation, session, run, tab as unknown as ChromeTabInfo);
            } else if (v.type === "tabRemoved") {
              if (!tabId(v.tabId)) throw new Error();
              this.onTabRemoved(peer.profile, peer.generation, session, run, v.tabId as number);
            } else if (v.type === "pauseState") {
              if (!["pausing", "paused", "failed"].includes(String(v.state))) throw new Error();
              this.onPauseState(
                peer.profile,
                peer.generation,
                session,
                run,
                v.state as "pausing" | "paused" | "failed",
                chromePauseReason(v.reason),
              );
            }
            // Unknown notification types from newer extensions are ignored.
          } else {
            if (
              v.jsonrpc !== "2.0" ||
              typeof v.id !== "string" ||
              v.generation !== peer.generation
            )
              throw new Error();
            const p = peer.pending.get(v.id);
            if (!p) continue;
            peer.pending.delete(v.id);
            clearTimeout(p.timer);
            if (v.error !== undefined && v.error !== null) {
              const raw = typeof v.error === "object" ? (v.error as Record<string, unknown>).message : v.error;
              const message = typeof raw === "string" && raw ? raw : "Chrome extension request failed.";
              p.reject(new Error(message.length > ERROR_MESSAGE_LIMIT ? `${message.slice(0, ERROR_MESSAGE_LIMIT)}…` : message));
            } else p.resolve(v.result);
          }
        }
      } catch {
        socket.destroy();
      }
    });
  }
  /** Send one request. Each request has its own timeout (default 30 s; a
   * `cdp`/`cdpBatch` timeoutMs param extends it) and abort signal: either
   * rejects only that request and never tears down the connection. */
  async call(
    profile: string,
    generation: string,
    session: string,
    run: string,
    method: ChromeMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown> {
    await this.ready;
    signal?.throwIfAborted();
    const peer = this.peers.get(profile);
    if (!peer || peer.generation !== generation || peer.socket.destroyed || !peer.socket.writable)
      throw new Error(
        "Selected Chrome profile disconnected. Reconnect and allocate a new session; no fallback.",
      );
    if (peer.pending.size >= CHROME_MAX_PENDING)
      throw new Error(`Chrome is busy (${CHROME_MAX_PENDING} requests in flight).`);
    const id = crypto.randomUUID();
    const frame = chromeFrame(
      { jsonrpc: "2.0", id, method, instance: this.instance, generation, session, run, params },
      CHROME_MAX_REQUEST,
    );
    const inner = typeof params.timeoutMs === "number" && (method === "cdp" || method === "cdpBatch")
      ? params.timeoutMs + 5000 : 0;
    const limit = timeoutMs ?? Math.max(CHROME_REQUEST_TIMEOUT, inner);
    return new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        peer.pending.delete(id);
      };
      const abort = () => {
        settle();
        reject(signal?.reason instanceof Error ? signal.reason : new Error(`Chrome request "${method}" was aborted.`));
      };
      const timer = setTimeout(() => {
        settle();
        reject(new Error(`Chrome request "${method}" timed out after ${limit}ms`));
      }, limit);
      peer.pending.set(id, {
        resolve: (v) => { settle(); resolve(v); },
        reject: (e) => { settle(); reject(e); },
        timer,
      });
      signal?.addEventListener("abort", abort, { once: true });
      peer.writer.write(frame);
    });
  }
  disconnect(profile: string) {
    try {
      if (!this.blocked.has(profile) && this.blocked.size >= 1024)
        this.blockOverflow(profile);
      this.blocked.add(profile);
      this.saveBlocked();
    } finally {
      this.peers.get(profile)?.socket.destroy();
    }
  }
  async close() {
    this.closing = true;
    for (const s of this.sockets) s.destroy();
    await this.ready.catch(() => {});
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
