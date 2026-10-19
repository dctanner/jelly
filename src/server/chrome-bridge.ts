import { createServer, type Socket, type Server } from "node:net";
import {
  mkdirSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  CHROME_PROTOCOL,
  CHROME_METHODS,
  ChromeFrames,
  chromeFrame,
  type ChromeMethod,
  type ChromeProfile,
} from "../shared/chrome-protocol";
import { ChromeWriter } from "./chrome-writer";
import { validChromeDesktop, type ChromeDesktop } from "./chrome-desktop";
interface Peer {
  socket: Socket;
  writer: ChromeWriter;
  profile: string;
  generation: string;
  desktop: ChromeDesktop;
  ready?: boolean;
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
  private peers = new Map<string, Peer>();
  private deferred = new Map<string, Peer>();
  private admissionRevision = 0;
  private failureRevision = 0;
  get desktopEpoch() { return `${this.admissionRevision}:${this.failureRevision}`; }
  deferDesktop: (desktop: ChromeDesktop, parent: unknown, ownedDesktop: ChromeDesktop) => ChromeDesktop | null = () => null;
  async waitDeferredReady() {
    const snapshot = [...this.deferred.values()];
    const deadline = Date.now() + 5000;
    while (snapshot.some(p => !p.ready)) {
      if (snapshot.some(p => this.deferred.get(p.profile) !== p) || Date.now() > deadline)
        throw new Error("Pending Chrome did not acknowledge private cleanup.");
      await Bun.sleep(20);
    }
    if (snapshot.length !== this.deferred.size || snapshot.some(p => this.deferred.get(p.profile) !== p))
      throw new Error("Pending Chrome changed during handback.");
  }
  deferredProfiles() { return [...this.deferred.values()].map(p => ({ id: p.profile, generation: p.generation })); }
  publishDeferred(expectedEpoch = this.desktopEpoch) {
    if (expectedEpoch !== this.desktopEpoch || [...this.deferred.values()].some(p => !p.ready || p.socket.destroyed)) throw new Error("Pending Chrome is not ready.");
    for (const p of this.deferred.values()) {
      this.peers.set(p.profile, p);
      p.writer.write(chromeFrame({ type: "paired", version: CHROME_PROTOCOL, capabilities: CHROME_METHODS,
        instance: this.instance, generation: p.generation }));
    }
    this.deferred.clear();
  }
  private sockets = new Set<Socket>();
  private grant: string;
  private extensionId: string | null = null;
  private privateDesktop = false;
  private closing = false;
  onDesktopLoss: () => void = () => {};
  setDesktopPrivate(value: boolean) { this.privateDesktop = value; }
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
  ) => void = () => {};
  onTabAdded: (
    profile: string,
    generation: string,
    session: string,
    run: string,
    tab: string,
  ) => void = () => {};
  onTabRemoved: (
    profile: string,
    generation: string,
    session: string,
    run: string,
    tab: string,
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
  private accept(socket: Socket) {
    if (this.sockets.size >= 8) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    let peer: Peer | undefined;
    let eventWindow = Date.now(),
      events = 0;
    const frames = new ChromeFrames();
    const writer = new ChromeWriter(socket, () => socket.destroy());
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      this.sockets.delete(socket);
      if (peer && this.deferred.get(peer.profile) === peer) {
        this.deferred.delete(peer.profile);
        ++this.admissionRevision;
        if (this.privateDesktop && !this.closing) { ++this.failureRevision; this.onDesktopLoss(); }
      }
      if (peer && this.peers.get(peer.profile) === peer) {
        this.peers.delete(peer.profile);
        ++this.admissionRevision;
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
          if (this.privateDesktop) { ++this.failureRevision; this.onDesktopLoss(); }
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
          if (Date.now() - eventWindow > 1000) {
            eventWindow = Date.now();
            events = 0;
          }
          if (++events > 256) throw new Error("Chrome event flood");
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
              this.peers.has(v.profile) || this.deferred.has(v.profile)
            )
              throw new Error();
            peer = {
              socket,
              writer,
              profile: v.profile,
              generation: v.generation,
              desktop: validChromeDesktop(v.desktop),
              pending: new Map(),
            };
            const deferred = this.deferDesktop(peer.desktop, v.ownedParent, validChromeDesktop(v.ownedDesktop));
            if (deferred) peer.desktop = deferred;
            if (this.privateDesktop && !deferred) throw new Error();
            (deferred ? this.deferred : this.peers).set(peer.profile, peer);
            ++this.admissionRevision;
            clearTimeout(timer);
            if (deferred) {
              const readyDeadline = setTimeout(() => { if (!peer?.ready) socket.destroy(); }, 5000);
              socket.once("close", () => clearTimeout(readyDeadline));
            }
            writer.write(
              chromeFrame({
                type: deferred ? "pending" : "paired",
                version: CHROME_PROTOCOL,
                capabilities: CHROME_METHODS,
                instance: this.instance,
                generation: peer.generation,
              }),
            );
          } else if (this.deferred.get(peer.profile) === peer) {
            if (v.type !== "pendingReady" || v.generation !== peer.generation || peer.ready) throw new Error();
            peer.ready = true;
          } else if (v.type === "pauseState") {
            if (
              v.generation !== peer.generation ||
              ![v.session, v.run].every(
                (s) => typeof s === "string" && s.length > 0 && s.length <= 128,
              ) ||
              !["pausing", "paused", "failed"].includes(String(v.state))
            )
              throw new Error();
            this.onPauseState(
              peer.profile,
              peer.generation,
              v.session as string,
              v.run as string,
              v.state as "pausing" | "paused" | "failed",
            );
          } else if (v.type === "tabRemoved" || v.type === "tabAdded") {
            if (
              v.generation !== peer.generation ||
              ![v.session, v.run, v.tab].every(
                (s) => typeof s === "string" && s.length > 0 && s.length <= 128,
              )
            )
              throw new Error();
            (v.type === "tabAdded" ? this.onTabAdded : this.onTabRemoved)(
              peer.profile,
              peer.generation,
              v.session as string,
              v.run as string,
              v.tab as string,
            );
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
            if (v.error)
              p.reject(
                new Error(
                  "Chrome operation unavailable or revoked. Secret-field pages, unapproved frames and stale references are unsupported. Re-observe before retrying; mutations are never replayed.",
                ),
              );
            else p.resolve(v.result);
          }
        }
      } catch {
        socket.destroy();
      }
    });
  }
  async call(
    profile: string,
    generation: string,
    session: string,
    run: string,
    method: ChromeMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.ready;
    signal?.throwIfAborted();
    const peer = this.peers.get(profile);
    if (!peer || peer.generation !== generation)
      throw new Error(
        "Selected Chrome profile disconnected. Reconnect and allocate a new session; no fallback.",
      );
    if (peer.pending.size >= 32) throw new Error("Chrome is busy.");
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        peer.socket.destroy();
      };
      const finish = (value: unknown, error = false) => {
        signal?.removeEventListener("abort", abort);
        error ? reject(value) : resolve(value);
      };
      const timer = setTimeout(() => {
        peer.socket.destroy();
      }, 20000);
      peer.pending.set(id, {
        resolve: (v) => finish(v),
        reject: (e) => finish(e, true),
        timer,
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        peer.writer.write(
          chromeFrame({
            jsonrpc: "2.0",
            id,
            method,
            instance: this.instance,
            generation,
            session,
            run,
            params,
          }),
        );
      } catch {
        peer.socket.destroy();
      }
    });
  }
  disconnect(profile: string) {
    this.peers.get(profile)?.socket.destroy();
  }
  async close() {
    this.closing = true;
    for (const s of this.sockets) s.destroy();
    await this.ready.catch(() => {});
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
