import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ChromeSessions } from "./chrome-sessions";
import {
  bindChromeDesktop,
  ChromeDesktopError,
  validDesktopBinding,
  type ChromeDesktopBinding,
} from "./chrome-desktop";
import { HttpError } from "./errors";
import type { ChromeShareState } from "../shared/chrome-share";
import type { VncEndpoint } from "./vnc-endpoint";
import { OwnedChromeDesktop, privateJson } from "./owned-chrome-desktop";
import { ComputerClipboard } from "./computer-clipboard";
import { validClipboardText } from "../shared/computer-clipboard";

/** Authenticated computer viewer. Its lifecycle never grants browser authority. */
export class ChromeShare implements VncEndpoint {
  private status: ChromeShareState["status"] = "idle";
  private owner: string | null = null;
  private controlId: string | null = null;
  private profile: string | null = null;
  private agentId: string | null = null;
  private profileGeneration: string | null = null;
  private generation = 0;
  private failureEpoch = 0;
  private closing = false;
  private error: string | null = null;
  private runtime: string | null = null;
  private binding: ChromeDesktopBinding | null = null;
  private inputCleanupRequired = false;
  private unexpectedExit = false;
  readonly ownedDesktop: OwnedChromeDesktop;
  private ownedGeneration: string | null = null;
  private authProcess: ChildProcess | null = null;
  private authUncertain = false;
  private process: ChildProcess | null = null;
  private transition: Promise<void> | null = null;
  private captureCleanup: Promise<void> | null = null;
  private returning = false;
  private handoffs: { agent: string; id: string }[] = [];
  onDone: (handoffs: { agent: string; id: string }[]) => void | Promise<void> = () => {};
  private connections = new Set<() => void>();
  private clipboard = new ComputerClipboard();
  async transferClipboard(session: string, input: Record<string, unknown>, send: boolean) {
    const requireCurrent = () => {
      this.owned(session);
      if (this.closing || input.controlId !== this.controlId || typeof input.controlId !== "string" ||
          input.generation !== this.generation || !this.connections.size ||
          !this.validConnection(this.generation, session) || !this.binding || !validDesktopBinding(this.binding))
        throw new HttpError(409, "Computer connection changed. Reconnect before transferring text.");
    };
    requireCurrent();
    if (Object.keys(input).some(key => !["controlId", "generation", ...(send ? ["text"] : [])].includes(key)))
      throw new HttpError(400, "Unsupported text transfer options.");
    if (send && !validClipboardText(input.text))
      throw new HttpError(413, "Send valid Unicode text up to 256 KiB. Nothing was transferred.");
    const result = await this.clipboard.transfer(this.binding!, requireCurrent, send ? input.text as string : undefined);
    requireCurrent();
    return result;
  }
  private tickets = new Map<
    string,
    { owner: string; generation: number; expires: number }
  >();
  private readonly latch: string;
  private readonly expiry: ReturnType<typeof setInterval>;
  ownerValid: (session: string) => boolean = () => true;
  privacyValid: () => boolean = () => true;
  checkPrivacy() {
    if (this.status === "sharing" && (!this.privacyValid() || (this.ownedGeneration && !this.ownedAlive())))
      this.fail(
        "Desktop privacy exclusion was lost. Sharing stopped; the viewer needs cleanup.",
      );
  }
  private checkOwner() {
    if (this.owner && !this.ownerValid(this.owner)) {
      this.fail(
        "Owning control session expired. Input cleanup without viewing is required.",
      );
      this.owner = null;
      this.status = "orphaned";
      this.changed();
    }
  }
  constructor(
    private chrome: ChromeSessions,
    private dataDir: string,
    private drainDesktop: () => Promise<void>,
    private changed: () => void = () => {},
  ) {
    this.ownedDesktop = new OwnedChromeDesktop(dataDir, chrome.bridge.instance);
    chrome.bridge.attestDesktop = (_desktop, parent, desktop) => this.ownedDesktop.nativeClaim(parent, desktop);
    this.latch = join(chrome.bridge.directory, "desktop-share.json");
    if (existsSync(this.latch)) {
      const stat = lstatSync(this.latch);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077
      )
        throw new ChromeDesktopError("Unsafe desktop share latch.");
      const saved = JSON.parse(readFileSync(this.latch, "utf8"));
      if (
        saved.runtime !== null &&
        (typeof saved.runtime !== "string" ||
          !saved.runtime.startsWith(join(tmpdir(), "jelly-chrome-share-")) ||
          resolve(saved.runtime) !== saved.runtime)
      )
        throw new ChromeDesktopError("Invalid desktop share runtime.");
      this.runtime = saved.runtime;
      this.binding = saved.binding ?? null;
      this.ownedGeneration = saved.ownedGeneration ?? null;
      this.authUncertain = saved.authUncertain !== false || (!!this.runtime && existsSync(join(this.runtime, "auth.lock")));
      this.inputCleanupRequired =
        saved.inputCleanupRequired !== false || !!saved.runtime;
      this.unexpectedExit = this.inputCleanupRequired;
      this.status = "orphaned";
      this.controlId = crypto.randomUUID(); // Cleanup-only; no old owner is restored.
      this.error =
        "A previous desktop share was interrupted. End it without viewing before reconnecting the viewer. Browser agents can continue.";
      chrome.setHumanDesktop(true);
    }
    this.expiry = setInterval(() => {
      this.checkOwner();
      this.checkPrivacy();
    }, 1000);
    this.expiry.unref();
    chrome.bridge.onDesktopLoss = profile => {
      if (profile !== this.profile) return;
      this.fail(
        "Chrome disconnected. Sharing stopped; cleanup without viewing is required.",
      );
    };
  }
  state(session?: string): ChromeShareState {
    this.checkOwner();
    return {
      status: this.status,
      owned: !!session && session === this.owner,
      controlId: this.controlId,
      profile: this.profile,
      agentId: this.agentId,
      generation: this.generation,
      error: this.error,
      ownedDesktopAvailable: this.ownedDesktop.available(),
    };
  }
  private persist() {
    writeFileSync(
      this.latch,
      JSON.stringify({
        runtime: this.runtime,
        binding: this.binding,
        inputCleanupRequired: this.inputCleanupRequired,
        ownedGeneration: this.ownedGeneration,
        authUncertain: this.authUncertain,
      }),
      { mode: 0o600 },
    );
  }
  private revoke() {
    this.clipboard.stop();
    ++this.generation;
    this.tickets.clear();
    for (const close of [...this.connections]) close();
    this.connections.clear();
  }
  private failureMessage(error: unknown) {
    return error instanceof HttpError || error instanceof ChromeDesktopError
      ? error.message
      : "Desktop sharing or cleanup could not be verified. The viewer needs cleanup; check the local X11 backend or obtain operator repair.";
  }
  private fail(message: string) {
    if (this.status === "idle" || this.status === "orphaned") return;
    ++this.failureEpoch;
    this.status = "failed";
    this.error = message;
    this.unexpectedExit ||= this.inputCleanupRequired;
    this.revoke();
    this.process?.kill("SIGTERM");
    this.authProcess?.kill("SIGTERM");
    this.changed();
  }
  private binary() {
    const binary = [
      join(this.dataDir, "runtime/usr/bin/x11vnc"),
      "/usr/bin/x11vnc",
      "/usr/local/bin/x11vnc",
    ].find(existsSync);
    if (
      !binary ||
      !existsSync("/usr/bin/python3") ||
      !existsSync("/usr/bin/flock")
    )
      throw new HttpError(
        409,
        "Install x11vnc, python3 and flock on the local Linux X11 machine. No fallback is available.",
      );
    return binary;
  }
  private async inputHelper(mode: "--check" | "--release") {
    if (!this.binding || !validDesktopBinding(this.binding))
      throw new ChromeDesktopError(
        "The original X11 display/authorization binding changed. Operator repair is required; no other display will be touched.",
      );
    const child = Bun.spawn(
      [
        "/usr/bin/python3",
        resolve(
          import.meta.dir,
          "../../scripts/connected-chrome-input-cleanup.py",
        ),
        mode,
        JSON.stringify(this.binding),
      ],
      {
        env: {
          PATH: "/usr/bin:/bin",
          LANG: "C.UTF-8",
          LD_LIBRARY_PATH: join(
            this.dataDir,
            "runtime/usr/lib/x86_64-linux-gnu",
          ),
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    const code = await Promise.race([
      child.exited,
      Bun.sleep(3000).then(() => null),
    ]);
    if (code !== 0) {
      child.kill("SIGKILL");
      await child.exited;
      throw new ChromeDesktopError(
        "Could not verify X11 key/button cleanup. The viewer needs cleanup; operator repair may be required.",
      );
    }
  }
  private async startCapture() {
    const epoch = this.generation;
    const record = this.ownedGeneration ? this.ownedDesktop.record() : null;
    if (record && record.generation !== this.ownedGeneration)
      throw new ChromeDesktopError("Owned desktop generation changed; operator repair is required.");
    const binding = record?.binding ?? bindChromeDesktop(this.chrome.bridge.desktop(this.profile!, this.profileGeneration!));
    if (
      this.binding &&
      JSON.stringify(binding) !== JSON.stringify(this.binding)
    )
      throw new ChromeDesktopError(
        "The original X11 display changed. End this share without viewing; no fallback is available.",
      );
    this.binding = binding;
    await this.inputHelper("--check");
    if (epoch !== this.generation || this.status !== "pausing")
      throw new ChromeDesktopError("Desktop share revoked before capture.");
    this.runtime = mkdtempSync(join(tmpdir(), "jelly-chrome-share-"));
    chmodSync(this.runtime, 0o700);
    writeFileSync(join(this.runtime, "guard.lock"), "", {
      mode: 0o600,
      flag: "wx",
    });
    this.inputCleanupRequired = true;
    this.unexpectedExit = false;
    this.persist(); // Write native binding/cleanup obligation before any child can capture/input.
    const socket = join(this.runtime, "control.sock");
    const child = spawn(
      "/usr/bin/python3",
      [
        resolve(import.meta.dir, "../../scripts/desktop-child.py"),
        "--private-lock",
        join(this.runtime, "guard.lock"),
        String(process.pid),
        this.binary(),
        "-norc",
        "-display",
        binding.display,
        "-auth",
        binding.auth,
        "-rfbport",
        "0",
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
        "-clear_keys",
      ],
      {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: this.runtime,
          LANG: "C.UTF-8",
          LD_LIBRARY_PATH: join(
            this.dataDir,
            "runtime/usr/lib/x86_64-linux-gnu",
          ),
        },
        stdio: "ignore",
      },
    );
    this.process = child;
    child.on("error", () =>
      this.fail(
        "The X11 sharing process could not start. The viewer needs cleanup.",
      ),
    );
    child.once("exit", () => {
      if (["sharing", "pausing"].includes(this.status))
        this.fail(
          "X11 sharing stopped unexpectedly. Cleanup without viewing is required.",
        );
    });
    const deadline = Date.now() + 10000;
    while (!existsSync(socket)) {
      if (
        epoch !== this.generation ||
        child.exitCode !== null ||
        child.signalCode ||
        Date.now() > deadline
      )
        throw new ChromeDesktopError(
          "The attested X11 desktop could not be shared. Check authorization/x11vnc; no fallback was started.",
        );
      await Bun.sleep(25);
    }
    chmodSync(socket, 0o600);
    const held = Bun.spawn(
      [
        "/usr/bin/flock",
        "-n",
        join(this.runtime, "guard.lock"),
        "/usr/bin/true",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    if ((await held.exited) !== 1)
      throw new ChromeDesktopError(
        "Sharing process did not retain its cleanup guard. No sharing is allowed.",
      );
    if (
      epoch !== this.generation ||
      this.status !== "pausing" ||
      !this.privacyValid()
    )
      throw new ChromeDesktopError(
        "Desktop privacy exclusion changed while starting.",
      );
    if (record?.auth) {
      writeFileSync(join(this.runtime, "auth.lock"), "", { mode: 0o600, flag: "wx" });
      this.authProcess = spawn("/usr/bin/python3", [resolve(import.meta.dir, "../../scripts/desktop-child.py"),
        "--private-lock", join(this.runtime, "auth.lock"), String(process.pid), "/usr/bin/python3",
        resolve(import.meta.dir, "../../scripts/connected-chrome-os-auth.py"), "--gtk", JSON.stringify(record.auth)], {
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: this.runtime, DISPLAY: binding.display,
          XAUTHORITY: binding.auth, GDK_BACKEND: "x11", GTK_A11Y: "none", NO_AT_BRIDGE: "1" }, stdio: ["ignore", "pipe", "ignore"],
      });
      this.authProcess.on("error", () => this.fail("Private OS authentication helper failed. Keep the viewer closed."));
      const authChild = this.authProcess;
      authChild.once("exit", () => {
        if (authChild.exitCode !== 0 || authChild.signalCode) { this.authUncertain = true; this.persist(); }
        if (["sharing", "pausing"].includes(this.status)) this.fail("Private OS authentication ended unexpectedly. Cleanup without viewing is required.");
      });
      await new Promise<void>((done, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new ChromeDesktopError("Private OS authentication startup was not acknowledged.")), 5000);
        authChild.stdout!.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.trim() === '{"ready":true}') { clearTimeout(timer); done(); }
          else if (output.length > 64) { clearTimeout(timer); reject(new ChromeDesktopError("Invalid private authentication readiness.")); }
        });
        authChild.once("exit", () => { clearTimeout(timer); reject(new ChromeDesktopError("Private OS authentication could not start safely.")); });
      });
      if (epoch !== this.generation) throw new ChromeDesktopError("Private authentication authority changed.");
    }
    this.status = "sharing";
    this.changed();
  }
  async takeOwned(session: string, agent: string | null) {
    if (this.closing || this.status !== "idle") throw new HttpError(409, "A private desktop is already reserved or closing.");
    const record = this.ownedDesktop.record();
    this.binary();
    this.owner = session;
    this.controlId = crypto.randomUUID();
    this.agentId = agent;
    this.ownedGeneration = record.generation;
    this.binding = record.binding;
    this.status = "pausing";
    this.error = null;
    this.persist();
    this.chrome.setHumanDesktop(true);
    this.handoffs = this.chrome.pendingHandoffs((profile, generation) => {
      try { return this.ownedDesktop.matches(this.chrome.bridge.desktop(profile, generation)); }
      catch { return false; }
    });
    this.revoke();
    const epoch = this.generation;
    this.changed();
    this.transition = (async () => {
      try {
        await this.drainDesktop();
        if (this.status !== "pausing" || epoch !== this.generation) throw new ChromeDesktopError("Bootstrap authority changed while draining.");
        await this.startCapture();
      } catch (error) {
        this.fail(this.failureMessage(error));
        throw new HttpError(409, this.error ?? "Private bootstrap failed.");
      }
    })().finally(() => { this.transition = null; });
    await this.transition;
    return this.state(session);
  }
  async take(
    session: string,
    agent: string | null,
    profile: string,
    generation: string,
  ) {
    if (this.closing || this.status !== "idle")
      throw new HttpError(
        409,
        "A desktop share is already reserved. Only its owner can return control.",
      );
    const desktop = this.chrome.bridge.desktop(profile, generation);
    if (this.ownedDesktop.matches(desktop)) return this.takeOwned(session, agent);
    if (!desktop.available)
      throw new HttpError(409, "Local X11 desktop sharing is unavailable.");
    this.binary();
    // The authenticated Take control action is authorization. No extra consent gate.
    this.owner = session;
    this.controlId = crypto.randomUUID();
    this.profile = profile;
    this.agentId = agent;
    this.profileGeneration = generation;
    this.status = "pausing";
    this.error = null;
    this.persist();
    this.chrome.setHumanDesktop(true);
    this.handoffs = this.chrome.pendingHandoffs(id => id === profile);
    this.revoke();
    const epoch = this.generation;
    this.changed();
    this.transition = (async () => {
      try {
        await this.drainDesktop();
        if (this.status !== "pausing" || epoch !== this.generation)
          throw new ChromeDesktopError("Desktop share revoked while draining.");
        await this.startCapture();
      } catch (error) {
        this.fail(this.failureMessage(error));
        throw new HttpError(409, this.error ?? "Desktop sharing failed.");
      }
    })().finally(() => {
      this.transition = null;
    });
    await this.transition;
    return this.state(session);
  }
  private owned(session: string) {
    this.checkOwner();
    if (!this.owner || session !== this.owner)
      throw new HttpError(
        403,
        "This desktop is private to its owning control session.",
      );
  }
  private currentControl(generation: unknown, controlId: unknown) {
    return controlId === undefined
      ? generation === this.generation
      : typeof controlId === "string" && controlId === this.controlId;
  }
  async reconnect(session: string, generation: unknown, controlId?: unknown) {
    this.owned(session);
    if (
      this.closing || !this.currentControl(generation, controlId) ||
      this.transition ||
      !["sharing", "disconnected"].includes(this.status)
    )
      throw new HttpError(
        409,
        "Sharing changed or cleanup is required. Refresh and retry.",
      );
    this.status = "stopping";
    this.revoke();
    const stoppingEpoch = this.generation;
    this.changed();
    this.transition = (async () => {
      try {
        await this.stopCapture(false);
        if (this.closing || this.returning || this.status !== "stopping" || stoppingEpoch !== this.generation || !this.ownerValid(session))
          throw new ChromeDesktopError("Reconnect was revoked while stopping.");
        this.status = "pausing";
        await this.startCapture();
      } catch (error) {
        this.fail(this.failureMessage(error));
        throw new HttpError(409, this.error ?? "Reconnect failed.");
      }
    })().finally(() => {
      this.transition = null;
    });
    await this.transition;
    return this.state(session);
  }
  ticket(session: string, generation: unknown) {
    this.owned(session);
    if (
      generation !== this.generation ||
      this.connections.size ||
      !this.validConnection(this.generation, session)
    )
      throw new HttpError(
        409,
        "Sharing is not ready, already connected or its generation changed. Reconnect explicitly.",
      );
    this.revoke();
    const ticket = crypto.randomUUID();
    this.tickets.set(ticket, {
      owner: session,
      generation: this.generation,
      expires: Date.now() + 30000,
    });
    return { ticket, generation: this.generation };
  }
  consume(ticket: string, session: string) {
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (
      !t ||
      t.owner !== session ||
      t.expires <= Date.now() ||
      !this.validConnection(t.generation, session) ||
      !this.runtime
    )
      throw new HttpError(
        403,
        "Expired or foreign desktop ticket. Reconnect explicitly.",
      );
    return {
      path: join(this.runtime, "control.sock"),
      session,
      generation: t.generation,
    };
  }
  private ownedAlive() {
    try { return this.ownedDesktop.record().generation === this.ownedGeneration; }
    catch { return false; }
  }
  validConnection(generation: number, session: string) {
    return (
      this.ownerValid(session) &&
      this.privacyValid() &&
      generation === this.generation &&
      session === this.owner &&
      this.status === "sharing" &&
      (this.ownedGeneration
        ? this.ownedAlive()
        : this.chrome.bridge.profiles().some(p => p.id === this.profile && p.generation === this.profileGeneration))
    );
  }
  attach(close: () => void) {
    const epoch = this.generation;
    this.connections.add(close);
    return () => {
      if (
        !this.connections.delete(close) ||
        epoch !== this.generation ||
        this.status !== "sharing"
      )
        return;
      this.status = "stopping";
      this.revoke();
      const stoppingEpoch = this.generation;
      this.changed();
      this.transition = this.stopCapture(false)
        .then(() => {
          if (this.status === "stopping" && this.generation === stoppingEpoch && !this.returning && !this.closing) {
            this.status = "disconnected";
            this.changed();
          }
        })
        .catch((e) => this.fail(this.failureMessage(e)))
        .finally(() => {
          this.transition = null;
        });
    };
  }
  private stopCapture(allowRepair: boolean): Promise<void> {
    if (this.captureCleanup) {
      const pending = this.captureCleanup;
      // Explicit repair can retry after an uncertain ordinary shutdown. It
      // cannot overlap that shutdown or signal the same process a second time.
      return allowRepair
        ? pending.catch(() => {}).then(() => this.stopCapture(true))
        : pending;
    }
    const cleanup = this.stopCaptureOnce(allowRepair).finally(() => {
      if (this.captureCleanup === cleanup) this.captureCleanup = null;
    });
    this.captureCleanup = cleanup;
    return cleanup;
  }
  private async stopCaptureOnce(allowRepair: boolean) {
    // Clipboard cleanup never short-circuits the existing held-key cleanup path.
    await this.clipboard.drain().catch(() => {});
    // Admission is revoked by every caller before entering shared cleanup.
    const auth = this.authProcess;
    if (auth && auth.exitCode === null && !auth.signalCode) {
      auth.kill("SIGTERM");
      for (let i = 0; i < 240 && auth.exitCode === null && !auth.signalCode; i++) await Bun.sleep(25);
      if (auth.exitCode === null && !auth.signalCode) {
        this.authUncertain = true;
        this.persist();
        auth.kill("SIGKILL");
        throw new ChromeDesktopError("Cannot confirm private OS-authentication shutdown. The viewer needs cleanup.");
      }
    }
    this.authProcess = null;
    if (this.runtime && existsSync(join(this.runtime, "auth.lock"))) {
      const probe = Bun.spawn(["/usr/bin/flock", "-n", join(this.runtime, "auth.lock"), "/usr/bin/true"], { stdout: "ignore", stderr: "ignore" });
      if (await probe.exited !== 0) throw new ChromeDesktopError("Old private OS-authentication helper is still alive. Keep the viewer closed.");
    }
    const child = this.process;
    let stoppedByUs = false;
    if (child && child.exitCode === null && !child.signalCode) {
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      stoppedByUs = child.kill("SIGTERM");
      await Promise.race([exited, Bun.sleep(5000)]);
      if (child.exitCode === null && !child.signalCode) {
        this.unexpectedExit = true;
        child.kill("SIGKILL");
        await Promise.race([exited, Bun.sleep(5000)]);
        if (child.exitCode === null && !child.signalCode)
          throw new ChromeDesktopError(
            "Cannot confirm sharing process exit. The viewer needs cleanup; repair required.",
          );
      }
    }
    // x11vnc's own SIGTERM handler exits with 2 after graceful key cleanup.
    if (
      child &&
      ((child.signalCode && !(stoppedByUs && child.signalCode === "SIGTERM")) ||
        (child.exitCode !== null &&
          child.exitCode !== 0 &&
          !(stoppedByUs && child.exitCode === 2)))
    )
      this.unexpectedExit ||= this.inputCleanupRequired;
    if (this.runtime) {
      const dir = lstatSync(this.runtime),
        lock = lstatSync(join(this.runtime, "guard.lock"));
      if (
        !dir.isDirectory() ||
        dir.isSymbolicLink() ||
        dir.uid !== process.getuid?.() ||
        dir.mode & 0o077 ||
        !lock.isFile() ||
        lock.isSymbolicLink() ||
        lock.uid !== process.getuid?.() ||
        lock.mode & 0o077
      )
        throw new ChromeDesktopError(
          "Cannot verify private sharing runtime. Repair required.",
        );
      const probe = Bun.spawn(
        [
          "/usr/bin/flock",
          "-n",
          join(this.runtime, "guard.lock"),
          "/usr/bin/true",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      if ((await probe.exited) !== 0)
        throw new ChromeDesktopError(
          "Old X11 input process is still alive. Retry cleanup; the viewer needs cleanup.",
        );
    }
    this.process = null;
    if (this.inputCleanupRequired) {
      if (this.unexpectedExit && !allowRepair)
        throw new ChromeDesktopError(
          "Input state is uncertain. End the share without viewing before reconnecting.",
        );
      await this.inputHelper("--release");
      this.inputCleanupRequired = false;
      this.unexpectedExit = false;
      this.persist();
    }
    if (this.runtime) {
      rmSync(this.runtime, { recursive: true });
      this.runtime = null;
      this.persist();
    }
  }
  private async verifyOwnedAuth(requireCurrent: () => void) {
    if (!this.ownedGeneration) return;
    const record = this.ownedDesktop.record();
    if (record.generation !== this.ownedGeneration) throw new ChromeDesktopError("Owned desktop changed during handback.");
    if (!record.auth) return;
    const check = Bun.spawn(["/usr/bin/python3", resolve(import.meta.dir, "../../scripts/connected-chrome-os-auth.py"),
      "--verify", JSON.stringify(record.auth)], { stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
    const code = await Promise.race([check.exited, Bun.sleep(5000).then(() => -1)]);
    if (code !== 0) { check.kill(); await check.exited; requireCurrent(); throw new ChromeDesktopError("OS authentication daemon binding was lost. Keep the viewer closed."); }
    requireCurrent();
    const attested = JSON.parse(await new Response(check.stdout).text());
    requireCurrent();
    if (JSON.stringify(attested) !== JSON.stringify(record.auth)) throw new ChromeDesktopError("OS authentication daemon changed. Keep the viewer closed.");
  }
  async release(session: string, generation: unknown, cleanupOnly = false, controlId?: unknown) {
    const orphan = this.status === "orphaned";
    if (orphan) {
      if (!cleanupOnly)
        throw new HttpError(
          400,
          "Use cleanup without viewing for an orphaned share.",
        );
    } else this.owned(session);
    if (!this.currentControl(generation, controlId) || this.returning)
      throw new HttpError(
        409,
        "Stale or concurrent handback. Refresh and retry.",
      );
    // Socket shutdown can fail after Done. This changes cleanup mode, not
    // the user's intent to finish this exact Take.
    cleanupOnly ||= this.status === "failed";
    this.chrome.setHumanDesktop(false);
    const handoffs = this.handoffs;
    this.handoffs = [];
    const notified = Promise.resolve(this.onDone(handoffs));
    void notified.catch(() => {});
    // Snapshot only already-completed obligations. Never turn failed native
    // cleanup into permission to retire a dead display within this request.
    const cleanOwned = cleanupOnly && !!this.ownedGeneration && this.runtime === null &&
      !this.inputCleanupRequired && !this.authUncertain && !this.process && !this.authProcess &&
      !this.captureCleanup && !this.transition;
    const evidence = () => {
      const saved = privateJson<Record<string, unknown>>(this.latch);
      if (saved.runtime !== null || saved.inputCleanupRequired !== false || saved.authUncertain !== false ||
          saved.ownedGeneration !== this.ownedGeneration || JSON.stringify(saved.binding) !== JSON.stringify(this.binding))
        throw new ChromeDesktopError("Completed desktop cleanup evidence is missing or changed. Keep the viewer closed.");
      return JSON.stringify(this.ownedDesktop.cleanupRecord(this.ownedGeneration!, this.binding!));
    };
    let cleanEvidence: string | null = null;
    if (cleanOwned) cleanEvidence = evidence();
    const cleanCurrent = () => {
      try { return cleanEvidence !== null && this.runtime === null && !this.inputCleanupRequired &&
        !this.authUncertain && !this.process && !this.authProcess && !this.captureCleanup && !this.transition &&
        evidence() === cleanEvidence; } catch { return false; }
    };
    this.returning = true;
    this.status = "stopping";
    this.revoke();
    const expected = { generation: this.generation, failure: this.failureEpoch, owner: this.owner,
      owned: this.ownedGeneration, profile: this.profileGeneration };
    let privacyReady = false;
    const current = () => !this.closing && this.returning && this.status === "stopping" &&
      this.generation === expected.generation && this.failureEpoch === expected.failure &&
      this.owner === expected.owner && this.ownedGeneration === expected.owned && this.profileGeneration === expected.profile &&
      this.ownerValid(session) && (orphan || this.owner === session) && (!privacyReady || this.privacyValid()) &&
      (!expected.owned || (cleanOwned ? cleanCurrent() : this.ownedAlive()));
    const requireCurrent = () => { if (!current()) throw new ChromeDesktopError("Desktop handback was revoked. Keep the viewer closed."); };
    this.changed();
    try {
      await notified;
      await this.transition?.catch(() => {});
      requireCurrent();
      // A restored orphan has no live native-provider lease yet. Acquire/drain
      // exclusion without viewing before cleanup or reopening any admission.
      await this.drainDesktop();
      privacyReady = true;
      requireCurrent();
      await this.stopCapture(cleanupOnly);
      requireCurrent();
      if (this.authUncertain) throw new ChromeDesktopError("OS authentication outcome is uncertain. The viewer needs cleanup for operator repair; no authentication is replayed.");
      const verifyAuth = async () => { if (!cleanOwned) await this.verifyOwnedAuth(requireCurrent); requireCurrent(); };
      await verifyAuth();
      requireCurrent();
      rmSync(this.latch);
      this.owner = this.profile = this.agentId = this.profileGeneration = null;
      this.controlId = null;
      this.binding = null;
      this.ownedGeneration = null;
      this.status = "idle";
      this.error = null;
      this.changed();
      return this.state(session);
    } catch (e) {
      this.persist();
      this.status = orphan || !this.owner ? "orphaned" : "failed";
      this.error = this.failureMessage(e);
      this.changed();
      throw new HttpError(409, this.error);
    } finally {
      this.returning = false;
    }
  }
  async close() {
    this.closing = true;
    ++this.failureEpoch;
    clearInterval(this.expiry);
    if (this.status === "idle") return;
    this.status = "stopping";
    this.revoke();
    await this.transition?.catch(() => {});
    await this.stopCapture(false);
    // Preserve the latch across restart, including failed/uncertain input cleanup.
  }
}
