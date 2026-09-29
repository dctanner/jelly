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
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { HttpError } from "./errors";
import { desktopClipboard, MAX_CLIPBOARD_CHARS } from "./desktop-clipboard";
import type { ComputerState } from "../shared/types";
export class Computer {
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
  private protectedUrl(value: string) {
    const url = new URL(value);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    return this.protectedOrigins.has(url.origin);
  }
  private connections = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly dataDir: string,
    private changed: () => void = () => {},
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
    const local = join(this.dataDir, "runtime/usr/bin", name);
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
      LD_LIBRARY_PATH: join(this.dataDir, "runtime/usr/lib/x86_64-linux-gnu"),
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
        "-no6",
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
    this.context = await chromium.launchPersistentContext(profile, {
      executablePath: browser,
      headless: false,
      chromiumSandbox: true,
      serviceWorkers: "block",
      extraHTTPHeaders: { "X-Jelly-Managed-Browser": "1" },
      viewport: null,
      args: [
        "--window-size=1280,800",
        "--window-position=0,0",
        "--no-first-run",
        "--disable-session-crashed-bubble",
      ],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        DISPLAY: display,
        XAUTHORITY: auth,
        LANG: "C.UTF-8",
      },
    });
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
  }
  private trackPage(page: Page) {
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
    this.page = page;
    return page;
  }
  private async cleanup() {
    await this.context?.close().catch(() => {});
    this.context = undefined;
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
    const job = this.tail.then(fn);
    this.tail = job.catch(() => {});
    return job;
  }
  async action(
    action: "open" | "screenshot" | "click" | "type" | "key",
    args: Record<string, unknown> = {},
  ) {
    if (this.human)
      throw new HttpError(
        409,
        "A person controls the browser. Wait for them to return control.",
      );
    const generation = this.generation;
    return this.serial(async () => {
      if (this.human)
        throw new HttpError(409, "A person controls the browser.");
      await this.ensure();
      const page = await this.activePage();
      if (this.human || generation !== this.generation)
        throw new HttpError(409, "Control changed to a person.");
      let result: unknown;
      if (action === "open") {
        const response = await page.goto(this.url(String(args.url)), {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        result = { url: page.url(), status: response?.status() };
      }
      if (action === "screenshot")
        result = {
          image: (await page.screenshot({ type: "png" })).toString("base64"),
        };
      if (action === "click") {
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
        await page.mouse.click(x, y);
        result = { ok: true };
      }
      if (action === "type") {
        await page.keyboard.insertText(String(args.text));
        result = { ok: true };
      }
      if (action === "key") {
        await page.keyboard.press(String(args.key));
        result = { ok: true };
      }
      if (this.human || generation !== this.generation)
        throw new HttpError(
          409,
          "Control changed to a person. The result was discarded.",
        );
      return result;
    });
  }
  async reserveLogin(id: string, url: string) {
    if (this.human || this.handoff)
      throw new HttpError(409, "The browser is already reserved for a person.");
    const href = this.url(url);
    this.human = true;
    this.handoff = id;
    this.owner = null;
    this.invalidate();
    try {
      await this.serial(async () => {
        await this.ensure();
        const page = await this.activePage();
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
