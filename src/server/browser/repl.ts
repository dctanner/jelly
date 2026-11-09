/**
 * Host side of the persistent `browser_js` REPL (plans/codex-style-browser.md §4).
 *
 * Each BrowserRepl owns at most one Bun Worker (`repl-worker.ts`) holding a persistent vm context.
 * Cells run one at a time (later calls queue). The worker calls back into `host(op, args, signal)`
 * for browser ops. On timeout, abort or reset the worker is terminated (this also kills hung
 * synchronous loops), in-flight host ops are aborted, and the next run starts a fresh worker.
 */
import type { BrowserHost } from "./types";
import type { HostToWorker, OutputItem, WorkerToHost } from "./repl-worker";

export type ReplItem = OutputItem;
export interface ReplResult {
  /** Ordered output: console/display/nodeRepl.write text (adjacent text merged) and images. */
  items: ReplItem[];
  /** Cell error (message + user-code stack), timeout or reset notice. */
  error?: string;
  /** True when the worker was restarted and all REPL state was lost. */
  reset?: boolean;
}
export interface ReplRunOptions {
  /** Default 30 000 ms, clamped to [1, 600 000]. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 600_000;

const RESET_NOTE =
  "The REPL was restarted: all variables and Tab handles from earlier cells are gone (browser tabs stay open; get them again with browser.tabs.list()).";

interface ActiveRun {
  runId: number;
  items: ReplItem[];
  finish(result: ReplResult): void;
}

export class BrowserRepl {
  readonly #host: BrowserHost;
  #worker: Worker | undefined;
  #workerAbort: AbortController | undefined;
  #active: ActiveRun | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #runSeq = 0;
  #closed = false;

  constructor(host: BrowserHost) {
    this.#host = host;
  }

  /** Run one cell. Concurrent calls are queued and run in order. */
  run(code: string, opts: ReplRunOptions = {}): Promise<ReplResult> {
    const next = this.#queue.then(() => this.#execute(code, opts));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Discard all REPL state (terminates the worker; a running cell finishes with reset: true). */
  reset(): void {
    this.#kill(`REPL reset. ${RESET_NOTE}`);
  }

  /** Terminate the worker and refuse further runs. */
  close(): void {
    this.#closed = true;
    this.#kill(`REPL closed. ${RESET_NOTE}`);
  }

  #execute(code: string, opts: ReplRunOptions): Promise<ReplResult> {
    if (this.#closed)
      return Promise.resolve({
        items: [],
        error: "The browser REPL is closed.",
      });
    if (opts.signal?.aborted)
      return Promise.resolve({
        items: [],
        error: "Aborted before the cell started; REPL state is unchanged.",
      });
    const requested = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_TIMEOUT_MS),
    );
    const worker = this.#ensureWorker();
    const runId = ++this.#runSeq;

    return new Promise<ReplResult>((resolve) => {
      const items: ReplItem[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () =>
        this.#kill(`Execution was interrupted. ${RESET_NOTE}`);
      const finish = (result: ReplResult) => {
        if (this.#active?.runId !== runId) return;
        this.#active = undefined;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      this.#active = { runId, items, finish };
      timer = setTimeout(
        () =>
          this.#kill(
            `Execution timed out after ${timeoutMs} ms. ${RESET_NOTE}`,
          ),
        timeoutMs,
      );
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const message: HostToWorker = { type: "run", runId, code };
      worker.postMessage(message);
    });
  }

  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(
      new URL("./repl-worker.ts", import.meta.url).href,
    );
    const abort = new AbortController();
    this.#worker = worker;
    this.#workerAbort = abort;
    (worker as Worker & { unref?: () => void }).unref?.();
    worker.onmessage = (event: MessageEvent<WorkerToHost>) => {
      if (this.#worker === worker)
        this.#onMessage(worker, abort.signal, event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      if (this.#worker !== worker) return;
      event.preventDefault?.();
      this.#kill(
        `REPL worker crashed: ${event.message || "unknown error"}. ${RESET_NOTE}`,
      );
    };
    return worker;
  }

  #onMessage(worker: Worker, signal: AbortSignal, message: WorkerToHost): void {
    const active = this.#active;
    switch (message.type) {
      case "output": {
        if (!active || active.runId !== message.runId) return;
        const last = active.items.at(-1);
        if (message.item.type === "text" && last?.type === "text")
          last.text += `\n${message.item.text}`;
        else active.items.push({ ...message.item });
        return;
      }
      case "done":
        if (active && active.runId === message.runId)
          active.finish(
            message.error === undefined
              ? { items: active.items }
              : { items: active.items, error: message.error },
          );
        return;
      case "call": {
        const reply = (response: HostToWorker) => {
          if (this.#worker !== worker) return;
          try {
            worker.postMessage(response);
          } catch (error) {
            worker.postMessage({
              type: "result",
              id: message.id,
              error: `Host result for ${message.op} could not be sent: ${errorMessage(error)}`,
            });
          }
        };
        let pending: Promise<unknown>;
        try {
          pending = Promise.resolve(
            this.#host(message.op, message.args ?? {}, signal),
          );
        } catch (error) {
          pending = Promise.reject(error);
        }
        pending.then(
          (result) => reply({ type: "result", id: message.id, result }),
          (error) =>
            reply({
              type: "result",
              id: message.id,
              error: errorMessage(error),
            }),
        );
        return;
      }
    }
  }

  /** Terminate the worker (if any) and finish the active run with `reset: true`. */
  #kill(notice: string): void {
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker) {
      worker.terminate();
      this.#workerAbort?.abort(new Error(notice));
    }
    this.#workerAbort = undefined;
    const active = this.#active;
    if (active)
      active.finish({ items: active.items, error: notice, reset: true });
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}
