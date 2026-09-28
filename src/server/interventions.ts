import { HttpError } from "./errors";
import { Store } from "./store";
import {
  createSudoExecutor,
  validateCommand,
  type SudoCommand,
  type SudoExecutor,
} from "./sudo";
import type { Intervention } from "../shared/types";
interface Waiter {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  controller: AbortController;
}
export class Interventions {
  private waiting = new Map<string, Waiter>();
  private executions = new Set<Promise<unknown>>();
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
        "The user returned browser control. Continue without requesting their credentials in chat.",
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
