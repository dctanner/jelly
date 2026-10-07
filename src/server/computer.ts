import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { chromium, type BrowserContext, type Page, type Response } from "playwright-core";
import { HttpError } from "./errors";
import { desktopClipboard, MAX_CLIPBOARD_CHARS } from "./desktop-clipboard";
import type { ComputerState } from "../shared/types";
import { BrowserEgress, reserveControllerPort } from "./browser-egress";
import { AgentBrowser } from "./agent-browser";
import type { BrowserBackend } from "../shared/types";
import { BrowserTools, type StructuredAction } from "./browser-tools";
// Control endpoints are private to Jelly, not merely to the owning browser.
// Share this registry across all sessions (including Playwright sessions).
const controllerPortOwners = new Map<number, number>();
const browserEgresses = new Set<BrowserEgress>();

export class Computer {
  private agentBrowser?: AgentBrowser;
  private egress?: BrowserEgress;
  private controllerPorts = new Set<number>();
  private browserTools = new BrowserTools(() => !this.human && !this.closing && this.status === "ready");
  private status: ComputerState["status"] = "stopped";
  private error: string | null = null;
  private owner: string | null = null;
  private human = false;
  private handoff: string | null = null;
  private context?: BrowserContext;
  private page?: Page;
  private openers = new WeakMap<Page, Page>();
  private processes: ChildProcess[] = [];
  private runtime?: string;
  private clipboardEnv?: NodeJS.ProcessEnv;
  private starting?: Promise<void>;
  private closing = false;
  private recovering = false;
  private recoveryRequired = false;
  private generation = 0;
  private tickets = new Map<
    string,
    {
      session: string;
      mode: "view" | "control";
      generation: number;
      expires: number;
    }
  >();
  private protectedOrigins = new Set<string>();
  protectOrigins(origins: string[]) {
    for (const origin of origins)
      this.protectedOrigins.add(new URL(origin).origin);
  }
  private protectControllerPort(port: number) {
    if (this.controllerPorts.has(port)) return;
    this.controllerPorts.add(port);
    controllerPortOwners.set(port, (controllerPortOwners.get(port) ?? 0) + 1);
    for (const egress of browserEgresses) egress.revoke(port);
  }
  private protectedUrl(value: string) {
    const url = new URL(value);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    return this.protectedOrigins.has(url.origin) || controllerPortOwners.has(Number(url.port));
  }
  private connections = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly dataDir: string,
    private changed: () => void = () => {},
    private runtimeDataDir = dataDir,
    readonly backend: BrowserBackend = "playwright",
  ) {}
  state(session?: string): ComputerState {
    return {
      status: this.status,
      control: this.human ? "human" : "agent",
      owned: !!session && this.owner === session,
      handoffId: this.handoff,
      error: this.error,
    };
  }
  private invalidate() {
    this.generation++;
    this.browserTools.invalidate();
    this.tickets.clear();
    for (const close of [...this.connections]) close();
    this.connections.clear();
    this.changed();
  }
  attach(close: () => void) {
    this.connections.add(close);
    return () => this.connections.delete(close);
  }
  private binary(name: string) {
    const local = join(this.runtimeDataDir, "runtime/usr/bin", name);
    if (existsSync(local)) return local;
    for (const p of ["/usr/bin", "/usr/local/bin"])
      if (existsSync(join(p, name))) return join(p, name);
    throw new Error(`Missing ${name}. Run bun run setup:desktop.`);
  }
  async ensure() {
    if (this.recovering) throw new HttpError(409, "Desktop recovery is in progress.");
    if (this.recoveryRequired) throw new HttpError(409, "Use Recover lost control to reset the private desktop.");
    if (this.closing) throw new HttpError(503, "Desktop is closing.");
    if (this.status === "ready") return;
    if (this.starting) return this.starting;
    this.status = "starting";
    this.error = null;
    this.changed();
    this.starting = this.cleanup()
      .then(() => this.launch())
      .then(() => {
        this.status = "ready";
        this.changed();
      })
      .catch(async (e) => {
        await this.cleanup();
        this.status = "error";
        this.error =
          e instanceof Error ? e.message : "Desktop could not start.";
        this.changed();
        throw new HttpError(503, this.error);
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }
  private async launch() {
    if (process.platform !== "linux")
      throw new Error("The managed desktop currently requires Linux.");
    this.runtime = mkdtempSync(join(tmpdir(), "jelly-screen-"));
    chmodSync(this.runtime, 0o700);
    const auth = join(this.runtime, "Xauthority");
    const field = (b: Buffer) => {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(b.length);
      return Buffer.concat([len, b]);
    };
    writeFileSync(
      auth,
      Buffer.concat([
        Buffer.from([255, 255]),
        field(Buffer.alloc(0)),
        field(Buffer.alloc(0)),
        field(Buffer.from("MIT-MAGIC-COOKIE-1")),
        field(randomBytes(16)),
      ]),
      { mode: 0o600 },
    );
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "C.UTF-8",
      XDG_SESSION_TYPE: "x11",
      LD_LIBRARY_PATH: join(this.runtimeDataDir, "runtime/usr/lib/x86_64-linux-gnu"),
      XAUTHORITY: auth,
    };
    const launch = (exe: string, args: string[], displayPipe = false) => {
      const p = spawn(
        "/usr/bin/python3",
        [
          resolve(import.meta.dir, "../../scripts/desktop-child.py"),
          exe,
          ...args,
        ],
        {
          env,
          stdio: displayPipe
            ? ["ignore", "ignore", "pipe", "pipe"]
            : ["ignore", "ignore", "pipe"],
        },
      );
      this.processes.push(p);
      let diagnostic = "";
      p.stderr?.on("data", (b: Buffer) => {
        diagnostic = (diagnostic + b.toString()).slice(-4000);
      });
      Object.assign(p, { diagnostic: () => diagnostic });
      p.on("error", () => {});
      p.once("exit", () => {
        if (this.status === "ready" && !this.closing) {
          this.status = "error";
          this.error =
            "The desktop process stopped. Close and restart Jelly to reconnect.";
          this.invalidate();
        }
      });
      return p;
    };
    const xvfb = launch(
      this.binary("Xvfb"),
      [
        "-displayfd",
        "3",
        "-screen",
        "0",
        "1280x800x24",
        "-nolisten",
        "tcp",
        "-auth",
        auth,
      ],
      true,
    );
    const display = await new Promise<string>((resolve, reject) => {
      let s = "";
      const timer = setTimeout(
        () => reject(new Error("Xvfb startup timed out.")),
        10000,
      );
      const finish = (err?: Error) => {
        clearTimeout(timer);
        if (err) reject(err);
      };
      xvfb.once("exit", () => finish(new Error("Xvfb could not start.")));
      (xvfb.stdio[3] as NodeJS.ReadableStream).on("data", (b: Buffer) => {
        s += b.toString();
        if (s.includes("\n")) {
          clearTimeout(timer);
          resolve(":" + s.trim());
        }
      });
    });
    this.clipboardEnv = { ...env, DISPLAY: display };
    for (const mode of ["view", "control"]) {
      const socket = join(this.runtime, mode + ".sock");
      const vnc = launch(this.binary("x11vnc"), [
        "-norc",
        "-display",
        display,
        "-auth",
        auth,
        "-rfbport",
        "0",
        // LibVNCServer has a separate IPv6 port; -no6 alone leaves it at 5900.
        "-rfbportv6",
        "0",
        "-no6",
        "-noipv6",
        "-unixsock",
        socket,
        "-forever",
        "-shared",
        "-nopw",
        "-nolookup",
        "-noxdamage",
        "-nosel",
        ...(mode === "view" ? ["-viewonly"] : []),
      ]);
      const deadline = Date.now() + 10000;
      while (!existsSync(socket)) {
        if (vnc.exitCode !== null || Date.now() > deadline)
          throw new Error(
            "VNC could not start: " +
              (vnc as ChildProcess & { diagnostic: () => string }).diagnostic(),
          );
        await new Promise((r) => setTimeout(r, 50));
      }
      chmodSync(socket, 0o600);
    }
    const browser =
      process.env.JELLY_BROWSER_PATH ??
      [
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ].find(existsSync);
    if (!browser)
      throw new Error(
        "Install Google Chrome or Chromium, or set JELLY_BROWSER_PATH.",
      );
    const profile = join(this.dataDir, "browser-profile"),
      home = join(this.dataDir, "browser-home");
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    mkdirSync(home, { recursive: true, mode: 0o700 });
    // Unlike context.route(), a browser proxy sees every redirect destination.
    // It also covers restored tabs, new tabs and workers before page observers.
    this.egress = new BrowserEgress((host, port) => {
      const authority = `${host.includes(":") ? `[${host}]` : host}:${port}`;
      return this.protectedUrl(`http://${authority}`) || this.protectedUrl(`https://${authority}`);
    });
    browserEgresses.add(this.egress);
    const proxy = await this.egress.listen(port => this.protectControllerPort(port), port => controllerPortOwners.has(port));
    const cdpPort = this.backend === "agent-browser"
      ? await reserveControllerPort(port => this.protectControllerPort(port), port => controllerPortOwners.has(port)) : undefined;
    this.context = await chromium.launchPersistentContext(profile, {
      executablePath: browser,
      headless: false,
      chromiumSandbox: true,
      serviceWorkers: "block",
      extraHTTPHeaders: { "X-Jelly-Managed-Browser": "1" },
      viewport: null,
      proxy: { server: proxy, bypass: "<-loopback>" },
      args: [
        ...(cdpPort ? [`--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1"] : []),
        "--disable-quic",
        "--window-size=1280,800",
        "--window-position=0,0",
        "--no-first-run",
        "--disable-session-crashed-bubble",
        // Treat reopening this agent's persistent profile as a continuation,
        // including cookies that websites deliberately mark session-only.
        "--restore-last-session",
      ],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        DISPLAY: display,
        XAUTHORITY: auth,
        LANG: "C.UTF-8",
      },
    });
    const endpoint = cdpPort ? `http://127.0.0.1:${cdpPort}` : undefined;
    // The managed browser cannot act as a human client to approve its own tools.
    await this.context.route("**/*", (route) =>
      this.protectedUrl(route.request().url())
        ? route.abort("accessdenied")
        : route.continue({
            headers: {
              ...route.request().headers(),
              "X-Jelly-Managed-Browser": "1",
            },
          }),
    );
    await this.context.routeWebSocket("**/*", (socket) => {
      if (this.protectedUrl(socket.url()))
        socket.close({
          code: 1008,
          reason: "Jelly control is unavailable inside the managed browser.",
        });
      else socket.connectToServer();
    });
    this.context.on("close", () => {
      if (this.status === "ready" && !this.closing) {
        this.status = "error";
        this.error = "The browser closed. Reconnect to start it again.";
        this.invalidate();
      }
    });
    for (const page of this.context.pages()) this.trackPage(page);
    this.context.on("page", (page) => this.trackPage(page));
    await this.activePage();
    if (endpoint) {
      const streamPort = await reserveControllerPort(port => this.protectControllerPort(port), port => controllerPortOwners.has(port));
      this.agentBrowser = new AgentBrowser(this.runtime);
      await this.agentBrowser.start(endpoint, port => this.protectControllerPort(port), streamPort);
    }
  }
  private trackPage(page: Page) {
    this.browserTools.invalidate();
    this.browserTools.track(page);
    this.page = page;
    page.on("popup", (popup) => this.openers.set(popup, page));
    page.on("close", () => {
      if (this.page !== page) return;
      // A login popup can close while the signed-in opener stays alive.
      this.page = this.livePage(this.openers.get(page));
    });
  }
  private livePage(preferred = this.page): Page | undefined {
    const pages =
      this.context?.pages().filter((page) => !page.isClosed()) ?? [];
    return preferred && pages.includes(preferred) ? preferred : pages.at(-1);
  }
  private async activePage(): Promise<Page> {
    // Also recover stale references before use, not only on close events.
    const page = this.livePage() ?? (await this.context!.newPage());
    if (this.page !== page) this.browserTools.invalidate();
    this.page = page;
    return page;
  }
  private async cleanup() {
    this.browserTools.dispose();
    await this.agentBrowser?.close();
    this.agentBrowser = undefined;
    await this.context?.close().catch(() => {});
    this.context = undefined;
    if (this.egress) {
      await this.egress.close();
      browserEgresses.delete(this.egress);
      this.egress = undefined;
    }
    for (const port of this.controllerPorts) {
      const remaining = (controllerPortOwners.get(port) ?? 1) - 1;
      if (remaining > 0) controllerPortOwners.set(port, remaining);
      else controllerPortOwners.delete(port);
    }
    this.controllerPorts.clear();
    this.page = undefined;
    for (const p of this.processes) p.kill("SIGTERM");
    await Promise.all(
      this.processes.map(
        (p) =>
          new Promise<void>((r) => {
            if (p.exitCode !== null || p.signalCode) return r();
            const t = setTimeout(() => {
              p.kill("SIGKILL");
              r();
            }, 2000);
            p.once("exit", () => {
              clearTimeout(t);
              r();
            });
          }),
      ),
    );
    this.processes = [];
    if (this.runtime) rmSync(this.runtime, { recursive: true, force: true });
    this.runtime = undefined;
    this.clipboardEnv = undefined;
  }
  private url(value: string) {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Use an http or https URL without embedded credentials.");
    if (this.protectedUrl(url.href))
      throw new Error(
        "Jelly’s control interface is unavailable inside the managed browser.",
      );
    return url.href;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new HttpError(503, "Desktop is closing."));
    const job = this.tail.then(() => {
      if (this.closing) throw new HttpError(503, "Desktop is closing.");
      return fn();
    });
    this.tail = job.catch(() => {});
    return job;
  }
  async action(
    action: "open" | "screenshot" | "click" | "type" | "key" | StructuredAction,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (this.human)
      throw new HttpError(
        409,
        "A person controls the browser. Wait for them to return control.",
      );
    const generation = this.generation;
    return this.serial(async () => {
      signal?.throwIfAborted();
      if (generation !== this.generation) throw new HttpError(409, "Browser control changed.");
      if (this.human)
        throw new HttpError(409, "A person controls the browser.");
      await this.ensure();
      signal?.throwIfAborted();
      if (this.closing) throw new HttpError(503, "Desktop is closing.");
      const page = await this.activePage();
      if (this.human || generation !== this.generation)
        throw new HttpError(409, "Control changed to a person.");
      signal?.throwIfAborted();
      if (this.closing) throw new HttpError(503, "Desktop is closing.");
      this.browserTools.track(page);
      const guard = () => {
        signal?.throwIfAborted();
        if (this.human || this.closing || generation !== this.generation)
          throw new HttpError(409, "Browser control changed. Result discarded.");
      };
      const abort = () => this.browserTools.invalidate();
      signal?.addEventListener("abort", abort, { once: true });
      try {
      let result: unknown;
      if (action === "snapshot") result = await this.browserTools.snapshot(page, guard);
      if (action === "diagnostics") result = this.browserTools.diagnostics();
      if (action === "upload")
        result = await this.browserTools.upload(page, args.ref, args.paths, guard);
      if (action === "fill") {
        if (typeof args.text !== "string" || args.text.length > 24000) throw new Error("Text must be at most 24000 characters.");
        result = await this.browserTools.target(args.ref, args.text, true, guard);
      }
      if (action === "tabs") {
        const operation = args.operation ?? "list";
        if (operation === "new") {
          if (this.context!.pages().length >= 20) throw new Error("Tab limit reached (20).");
          this.browserTools.invalidate();
          const created = await this.context!.newPage(); guard();
          this.page = created;
          if (args.url) { await created.goto(this.url(String(args.url)), { waitUntil: "domcontentloaded", timeout: 10000 }); guard(); }
        } else if (operation === "select" || operation === "close") {
          const target = this.browserTools.page(args.pageId);
          if (!target || target.isClosed()) throw new Error("Unknown session page ID.");
          this.browserTools.invalidate();
          if (operation === "select") { this.page = target; await target.bringToFront(); }
          else await target.close();
          guard();
        } else if (operation !== "list") throw new Error("Invalid tab operation.");
        result = { tabs: this.context!.pages().filter(p => this.browserTools.id(p)).slice(0, 20).map(p => ({ pageId: this.browserTools.id(p), active: p === this.page })), truncated: this.context!.pages().length > 20 };
      }
      if (action === "scroll") {
        const x = Number(args.x ?? 0), y = Number(args.y);
        if (![x, y].every(n => Number.isFinite(n) && Math.abs(n) <= 10000)) throw new Error("Scroll deltas must be within 10000 pixels.");
        if (this.agentBrowser) await this.agentBrowser.act(page, "scroll", { x, y }, guard);
        else await page.evaluate(({ x, y }) => window.scrollBy(x, y), { x, y });
        result = { ok: true };
      }
      if (action === "wait_for") {
        const timeout = Number(args.timeoutMs ?? 5000);
        if (!Number.isFinite(timeout) || timeout < 0 || timeout > 10000) throw new Error("Timeout must be 0–10000ms.");
        if (!["text", "text_absent", "ready"].includes(String(args.condition))) throw new Error("Invalid wait condition.");
        if (args.condition !== "ready" && (typeof args.text !== "string" || !args.text.length || args.text.length > 200)) throw new Error("Wait text must be 1–200 characters.");
        const deadline = Date.now() + timeout;
        while (true) {
          guard();
          const observed = await this.browserTools.snapshot(page, guard, false);
          guard();
          const met = args.condition === "ready" ? await page.evaluate(() => document.readyState !== "loading") : args.condition === "text" ? observed.text.includes(String(args.text)) : !observed.text.includes(String(args.text)) && !observed.truncated;
          guard();
          if (met) { result = { matched: true }; break; }
          if (Date.now() >= deadline) { result = { matched: false }; break; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      if (action === "open") {
        const url = this.url(String(args.url));
        if (this.agentBrowser) {
          // Native navigate returns no HTTP status. Observe the main-frame
          // response through the existing bridge without replacing navigation.
          let status: number | undefined;
          const response = (value: Response) => {
            if (value.request().isNavigationRequest() && value.frame() === page.mainFrame()) status = value.status();
          };
          page.on("response", response);
          try {
            await this.agentBrowser.act(page, "navigate", { url, waitUntil: "domcontentloaded" }, guard);
            result = { url: page.url(), status };
          } finally { page.off("response", response); }
        } else {
          const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          result = { url: page.url(), status: response?.status() };
        }
      }
      if (action === "screenshot") {
        // Chromium can reject capture before the first compositor frame of a
        // newly launched window. Retry only that transient failure, bounded.
        let image: Buffer | undefined;
        for (let attempt = 0; !image; attempt++) {
          signal?.throwIfAborted();
          if (this.closing || this.human || generation !== this.generation)
            throw new HttpError(409, "Browser control changed.");
          try { image = await page.screenshot({ type: "png" }); }
          catch (error) {
            if (attempt >= 4 || !(error instanceof Error) || !error.message.includes("Unable to capture screenshot")) throw error;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        result = { image: image.toString("base64") };
      }
      if (action === "click" && args.ref !== undefined) {
        if (args.x !== undefined || args.y !== undefined) throw new Error("Use a reference OR coordinates.");
        result = await this.browserTools.target(args.ref, undefined, false, guard);
      }
      if (action === "click" && args.ref === undefined) {
        const x = Number(args.x),
          y = Number(args.y);
        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          x < 0 ||
          y < 0 ||
          x > 1280 ||
          y > 800
        )
          throw new Error("Invalid coordinates.");
        if (this.agentBrowser) await this.agentBrowser.act(page, "coordinateClick", { x, y }, guard);
        else await page.mouse.click(x, y);
        result = { ok: true };
      }
      if (action === "type") {
        if (this.agentBrowser) await this.agentBrowser.act(page, "keyboard", { subaction: "insertText", text: String(args.text) }, guard);
        else await page.keyboard.insertText(String(args.text));
        result = { ok: true };
      }
      if (action === "key") {
        if (this.agentBrowser) await this.agentBrowser.act(page, "press", { key: String(args.key) }, guard);
        else await page.keyboard.press(String(args.key));
        result = { ok: true };
      }
      if (this.human || generation !== this.generation)
        throw new HttpError(
          409,
          "Control changed to a person. The result was discarded.",
        );
      signal?.throwIfAborted();
      if (this.closing) throw new HttpError(503, "Desktop is closing.");
      return result;
      } finally { signal?.removeEventListener("abort", abort); }
    });
  }
  async reserveLogin(id: string, url: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.human || this.handoff)
      throw new HttpError(409, "The browser is already reserved for a person.");
    const href = this.url(url);
    this.human = true;
    this.handoff = id;
    this.owner = null;
    this.invalidate();
    try {
      await this.serial(async () => {
        signal?.throwIfAborted();
        if (this.handoff !== id) throw new Error("Login cancelled.");
        await this.ensure();
        signal?.throwIfAborted();
        if (this.closing || this.handoff !== id) throw new Error("Login cancelled.");
        const page = await this.activePage();
        signal?.throwIfAborted();
        if (this.closing || this.handoff !== id) throw new Error("Login cancelled.");
        await page.goto(href, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
      });
    } catch (e) {
      if (this.handoff === id) {
        if (!this.owner) this.human = false;
        this.handoff = null;
        this.invalidate();
      }
      throw e;
    }
  }
  async take(session: string) {
    if (this.recoveryRequired)
      throw new HttpError(409, "Private desktop recovery must finish before taking control.");
    if (this.closing || this.recovering)
      throw new HttpError(409, "Desktop is closing or recovery is in progress.");
    if (this.owner && this.owner !== session)
      throw new HttpError(409, "Another Jelly window has control.");
    this.human = true;
    this.owner = session;
    this.invalidate();
    await this.tail;
    await this.ensure();
    return this.state(session);
  }
  /** Explicit destructive recovery: never hand an orphaned private screen to a new owner. */
  async recover(session: string) {
    if (this.closing || this.recovering)
      throw new HttpError(409, "Desktop is closing or recovery is in progress.");
    if (!this.human)
      throw new HttpError(409, "The desktop is not in private control.");
    this.recovering = true;
    this.recoveryRequired = true;
    this.human = true;
    this.owner = null;
    this.handoff = null;
    this.invalidate();
    return this.serial(async () => {
      try {
        await this.starting?.catch(() => {});
        // A fresh X display destroys both clipboard selections and old VNC sockets.
        await this.cleanup();
        if (this.closing) throw new Error("Desktop is closing.");
        this.status = "starting";
        this.error = null;
        this.changed();
        await this.launch();
        // Chrome may restore tabs. Do not expose them to the replacement owner.
        const blank = await this.context!.newPage();
        await blank.goto("about:blank");
        for (const page of this.context!.pages())
          if (page !== blank) await page.close();
        this.page = blank;
        if (this.closing) throw new Error("Desktop is closing.");
        this.status = "ready";
        this.recoveryRequired = false;
        this.owner = session;
        this.invalidate();
        return this.state(session);
      } catch {
        await this.cleanup();
        this.status = "error";
        this.error = "Could not reset the private desktop. Try recovery again.";
        // No owner and human=true deliberately keeps agent tools and viewers blocked.
        this.invalidate();
        throw new HttpError(503, this.error);
      } finally {
        this.recovering = false;
      }
    });
  }
  private requireClipboardOwner(session: string, generation = this.generation) {
    if (this.closing || !this.human || this.owner !== session || generation !== this.generation)
      throw new HttpError(403, "Only the controlling window can access the remote clipboard.");
  }
  async clipboard(session: string, operation: "read" | "write", text?: unknown) {
    this.requireClipboardOwner(session);
    if (operation === "write" && (typeof text !== "string" || text.length > MAX_CLIPBOARD_CHARS || text.includes("\0")))
      throw new HttpError(400, `Clipboard text must be at most ${MAX_CLIPBOARD_CHARS.toLocaleString()} characters and contain no null characters.`);
    const generation = this.generation;
    return this.serial(async () => {
      this.requireClipboardOwner(session, generation);
      if (this.status !== "ready" || !this.clipboardEnv)
        throw new HttpError(503, "The remote desktop is not ready.");
      const result = await desktopClipboard(this.binary("xclip"), this.clipboardEnv, operation === "write" ? text as string : undefined);
      this.requireClipboardOwner(session, generation);
      return operation === "read" ? { text: result } : { success: true };
    });
  }
  async release(session: string) {
    this.requireClipboardOwner(session);
    const generation = this.generation;
    return this.serial(async () => {
      this.requireClipboardOwner(session, generation);
      // Close input sockets before clearing the selection so late VNC input
      // cannot repopulate it as the agent resumes.
      this.invalidate();
      const current = this.generation;
      if (this.clipboardEnv)
        await desktopClipboard(this.binary("xclip"), this.clipboardEnv, "");
      this.requireClipboardOwner(session, current);
      const id = this.handoff;
      this.human = false;
      this.owner = null;
      this.handoff = null;
      this.invalidate();
      return id;
    });
  }
  cancelLogin(id: string) {
    if (this.handoff !== id) return;
    this.handoff = null;
    if (!this.owner) this.human = false;
    this.invalidate();
  }
  async ticket(session: string, mode: "view" | "control") {
    await this.tail;
    await this.ensure();
    if (this.human && this.owner !== session)
      throw new HttpError(
        403,
        "This desktop is private while a person has control.",
      );
    if (mode === "control" && (!this.human || this.owner !== session))
      throw new HttpError(403, "Take control first.");
    for (const [key, t] of this.tickets)
      if (t.expires < Date.now()) this.tickets.delete(key);
    const ticket = crypto.randomUUID();
    this.tickets.set(ticket, {
      session,
      mode,
      generation: this.generation,
      expires: Date.now() + 60000,
    });
    return { ticket };
  }
  consume(ticket: string, session: string) {
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (
      !t ||
      t.session !== session ||
      t.expires < Date.now() ||
      t.generation !== this.generation ||
      !this.runtime
    )
      throw new HttpError(403, "Expired desktop ticket. Reconnect.");
    if (this.human && this.owner !== session)
      throw new HttpError(403, "Desktop is private.");
    return {
      path: join(this.runtime, t.mode + ".sock"),
      generation: t.generation,
      session,
    };
  }
  validConnection(generation: number, session: string) {
    return (
      this.generation === generation &&
      (!this.human || this.owner === session) &&
      !this.closing
    );
  }
  async close() {
    this.closing = true;
    this.invalidate();
    await this.starting?.catch(() => {});
    await this.tail;
    await this.cleanup();
    this.status = "stopped";
  }
}
