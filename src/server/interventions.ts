import { HttpError } from "./errors";
import { Store } from "./store";
import {
  createSudoExecutor,
  validateCommand,
  type SudoCommand,
  type SudoExecutor,
} from "./sudo";
import type { Intervention } from "../shared/types";
import type { BrowserPort, BrowserRecovery } from "./browser-sessions";
import type { BrowserRecoveryResult } from "../shared/browser-recovery";
interface Waiter {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  controller: AbortController;
}
export class Interventions {
  private waiting = new Map<string, Waiter>();
  private executions = new Set<Promise<unknown>>();
  private recoveries = new Map<string, BrowserRecovery>();
  constructor(
    private store: Store,
    private notify: (
      agentId: string,
      runId: string,
      type: string,
      data: Record<string, unknown>,
    ) => void,
    private executor: SudoExecutor = createSudoExecutor(),
    private ttlMs = 10 * 60 * 1000,
  ) {}
  list() {
    return this.store.interventions();
  }
  private update(
    id: string,
    status: Intervention["status"],
    result: Record<string, unknown> | null = null,
  ) {
    const item = this.store.intervention(id)!;
    this.store.updateIntervention(id, status, result);
    this.notify(item.agentId, item.runId, "intervention_updated", {
      id,
      status,
    });
    return this.store.intervention(id)!;
  }
  private settle(id: string, error: Error | null, result?: unknown) {
    const waiter = this.waiting.get(id);
    if (!waiter) return;
    this.waiting.delete(id);
    waiter.cleanup();
    if (error) waiter.reject(error);
    else waiter.resolve(result);
  }
  request(
    kind: Intervention["kind"],
    agentId: string,
    runId: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) throw new Error("Request cancelled.");
    const item = this.store.createIntervention(
      kind,
      agentId,
      runId,
      payload,
      new Date(Date.now() + this.ttlMs).toISOString(),
    );
    const promise = new Promise<unknown>((resolve, reject) => {
      const controller = new AbortController();
      const cancel = () => this.cancel(item.id, "cancelled");
      const timer = setTimeout(
        () => this.cancel(item.id, "expired"),
        this.ttlMs,
      );
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      };
      this.waiting.set(item.id, { resolve, reject, cleanup, controller });
      signal?.addEventListener("abort", cancel, { once: true });
    });
    this.notify(agentId, runId, "intervention_requested", { request: item });
    return { request: item, promise };
  }
  async recoverBrowser(
    agentId: string,
    runId: string,
    browser: BrowserPort,
    signal?: AbortSignal,
    progress: (value: BrowserRecoveryResult) => void = () => {},
  ): Promise<BrowserRecoveryResult> {
    if (signal?.aborted) return { status: "cancelled", message: "Recovery request cancelled." };
    let recovery: BrowserRecovery;
    try {
      if (!browser.prepareRecovery) throw new Error("Recovery requests are unavailable.");
      recovery = browser.prepareRecovery();
    } catch (error) {
      return { status: "rejected", message: (error as Error).message };
    }
    if (recovery.binding.agent !== agentId || recovery.binding.run !== runId) {
      recovery.release();
      return { status: "rejected", message: "Recovery must belong to this agent's current run." };
    }
    // Automatic recovery: no human confirmation step. Retirement still drains
    // admitted work, rechecks the exact binding before and after cleanup, and
    // requires Chrome's authenticated end(discard) acknowledgement for a
    // connected session. Nothing is replayed or restored.
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const job = (async (): Promise<BrowserRecoveryResult> => {
      progress({ status: "requested", message: "Retiring the paused browser session automatically." });
      try { return await recovery.close(controller.signal); }
      catch (error) {
        if (controller.signal.aborted)
          return { status: "cancelled", message: "Recovery cancelled. Closure may have been dispatched; browser actions remain blocked. Nothing was replayed. Call request_browser_recovery again to retry." };
        return { status: "failed", message: "Recovery could not confirm safe retirement; browser actions remain blocked. Nothing was replayed. Call request_browser_recovery again to retry." };
      } finally {
        signal?.removeEventListener("abort", abort);
        recovery.release();
      }
    })();
    this.executions.add(job);
    void job.finally(() => this.executions.delete(job)).catch(() => {});
    return job;
  }
  private finishRecovery(id: string, result: BrowserRecoveryResult) {
    const status = result.status === "approved_closed" ? "completed"
      : result.status === "cancelled" ? "cancelled"
      : result.status === "rejected" ? "denied" : "failed";
    const updated = this.update(id, status, { ...result });
    this.settle(id, null, result);
    return updated;
  }
  /** Only the private operator route calls this; no tool receives this continuation. */
  confirmBrowserRecovery(id: string, displayed: unknown) {
    const item = this.pending(id);
    const recovery = this.recoveries.get(id);
    if (item.kind !== "browser_recovery" || !recovery || item.agentId !== recovery.binding.agent || item.runId !== recovery.binding.run)
      throw new HttpError(409, "This recovery request is no longer current.");
    if (!displayed || typeof displayed !== "object" || Array.isArray(displayed) ||
        Object.keys(displayed).length !== Object.keys(recovery.binding).length ||
        Object.entries(recovery.binding).some(([key, value]) => (displayed as Record<string, unknown>)[key] !== value))
      throw new HttpError(409, "Confirm only the exact browser session displayed on this request.");
    try { recovery.check(); }
    catch { return Promise.resolve(this.finishRecovery(id, { status: "stale", message: "Browser authority changed; no recovery was performed." })); }
    this.update(id, "executing"); // Synchronous single-use consumption before any await.
    const waiter = this.waiting.get(id)!;
    const job = (async () => {
      let result: BrowserRecoveryResult;
      try { result = await recovery.close(waiter.controller.signal); }
      catch {
        result = waiter.controller.signal.aborted
          ? { status: "cancelled", message: "Recovery cancelled or expired. Closure may have been dispatched; authority remains blocked. Nothing was replayed." }
          : { status: "failed", message: "Recovery could not confirm safe retirement. Authority remains blocked; use existing operator repair. Nothing was replayed." };
      }
      return this.finishRecovery(id, result);
    })();
    this.executions.add(job);
    void job.finally(() => this.executions.delete(job)).catch(() => {});
    return job;
  }
  async sudo(
    agentId: string,
    runId: string,
    command: SudoCommand,
    signal?: AbortSignal,
  ) {
    const validated = validateCommand(command);
    // The operator authorizes execution by default. Ask only when the OS
    // requires a password; never retry an ordinary command failure.
    const immediate = await this.executor(
      validated,
      Buffer.alloc(0),
      signal ?? new AbortController().signal,
    );
    if (
      immediate.cancelled ||
      immediate.timedOut ||
      immediate.exitCode === 0 ||
      immediate.exitCode === null ||
      // sudo-rs (Ubuntu) uses different wording from traditional sudo.
      !/^sudo(?:-rs)?: (?:a password is required|no password was provided|interactive authentication is required)\r?$/m.test(
        immediate.stderr,
      )
    )
      return immediate;
    return this.request(
      "sudo",
      agentId,
      runId,
      validated as unknown as Record<string, unknown>,
      signal,
    ).promise;
  }
  private pending(id: string) {
    const item = this.store.intervention(id);
    if (!item) throw new HttpError(404, "Request not found.");
    if (item.status !== "pending" || !this.waiting.has(id))
      throw new HttpError(409, "This request is no longer awaiting approval.");
    if (Date.parse(item.expiresAt) <= Date.now())
      throw new HttpError(409, "This request expired.");
    return item;
  }
  approveSudo(id: string, password: Buffer) {
    const job = this.execute(id, password);
    this.executions.add(job);
    void job.finally(() => this.executions.delete(job)).catch(() => {});
    return job;
  }
  private async execute(id: string, password: Buffer) {
    try {
      const item = this.pending(id);
      if (item.kind !== "sudo")
        throw new HttpError(400, "This is not a sudo request.");
      if (
        password.length > 1024 ||
        password.includes(0) ||
        password.includes(10) ||
        password.includes(13)
      )
        throw new HttpError(400, "Invalid password input.");
      this.update(id, "executing");
      const waiter = this.waiting.get(id)!;
      let result;
      try {
        result = await this.executor(
          item.payload as unknown as SudoCommand,
          password,
          waiter.controller.signal,
        );
      } catch {
        result = {
          exitCode: null,
          stdout: "",
          stderr:
            "Sudo could not start. Check that sudo is installed and permitted for this user.",
          cancelled: false,
          timedOut: false,
        };
      }
      const current = this.store.intervention(id)!;
      if (current.status === "cancelled" || current.status === "expired") {
        this.settle(
          id,
          new Error(
            current.status === "expired"
              ? "Request expired."
              : "Request cancelled.",
          ),
        );
        return current;
      }
      const status = result.cancelled
        ? "cancelled"
        : result.exitCode === 0
          ? "completed"
          : "failed";
      const updated = this.update(id, status, { ...result });
      this.settle(id, null, result);
      return updated;
    } finally {
      password.fill(0);
    }
  }
  deny(id: string) {
    const item = this.pending(id);
    if (item.kind === "browser_recovery") {
      this.finishRecovery(id, { status: "rejected", message: "The human rejected browser recovery. No session was closed." });
      return item;
    }
    this.update(id, "denied");
    this.settle(id, null, {
      denied: true,
      message: "The user denied this request.",
    });
    return item;
  }
  completeLogin(id: string) {
    const item = this.pending(id);
    if (item.kind !== "browser_login")
      throw new HttpError(400, "This is not a browser-login request.");
    this.update(id, "completed", { completed: true });
    this.settle(id, null, {
      completed: true,
      message:
        "The user finished this browser sign-in request. Re-observe the page and continue without requesting credentials in chat.",
    });
  }
  cancel(id: string, status: "cancelled" | "expired" = "cancelled") {
    const waiter = this.waiting.get(id);
    if (!waiter) return;
    const current = this.store.intervention(id)?.status;
    if (current === "cancelled" || current === "expired") return;
    const executing = current === "executing";
    waiter.controller.abort();
    this.update(id, status);
    if (!executing && this.store.intervention(id)?.kind === "browser_recovery") {
      this.finishRecovery(id, { status: status === "expired" ? "stale" : "cancelled", message: status === "expired" ? "Recovery request expired without human confirmation." : "Recovery request cancelled. No session was closed." });
      return;
    }
    if (!executing)
      this.settle(
        id,
        new Error(
          status === "expired"
            ? "The approval request expired."
            : "Request cancelled.",
        ),
      );
  }
  async close() {
    for (const id of [...this.waiting.keys()]) this.cancel(id);
    await Promise.allSettled([...this.executions]);
  }
}
