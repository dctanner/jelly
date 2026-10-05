import {
  createEventBus,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  SubagentProjection,
  record,
  childState,
  type SubagentSources,
} from "./subagent-projection";
import type { SubagentSnapshot } from "../shared/subagents";
import { subagentIsActive } from "../shared/subagents";
import { subagentLiveness } from "./subagent-liveness";

interface Root {
  dir?: string;
  terminalAt?: number;
  completed?: boolean;
  status?: Record<string, any>;
}
interface Options {
  sessionRoot?: string;
  pollMs?: number;
  heartbeatMs?: number;
  reconciliationMs?: number;
  now?: () => number;
  onSnapshot?: (snapshot: SubagentSnapshot, sources: SubagentSources) => void;
}
/** Bridges package-owned work into Jelly's interactive run, without another scheduler. */
export class SessionWork {
  readonly bus = createEventBus();
  private jobs = new Set<string>();
  private ownedChildren = new Map<string, string>();
  private stopping = new Map<string, Promise<void>>();
  private roots = new Map<string, Root>();
  private stopped = false;
  private settling = false;
  private session?: AgentSession;
  private off?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private publishTimer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<void>;
  private wakes = new Set<Promise<void>>();
  private heartbeatPending = false;
  private lastHeartbeat: number;
  private now: () => number;
  private lastPublished = "";
  private failures = 0;
  readonly projection: SubagentProjection;
  constructor(
    private report: (type: string, data: Record<string, unknown>) => void,
    private options: Options = {},
  ) {
    this.now = options.now ?? Date.now;
    this.lastHeartbeat = this.now();
    this.projection = new SubagentProjection(options.sessionRoot ?? "");
    this.bus.on("subagent:async-started", (value) => {
      const data = record(value),
        id = data.id ?? data.runId;
      const workflowOwned =
        typeof data.parentWorkflowRunId === "string" &&
        data.parentWorkflowRunId.length > 0;
      if (typeof id === "string" && workflowOwned)
        this.ownedChildren.set(id, data.parentWorkflowRunId);
      if (typeof id === "string" && !workflowOwned) {
        this.jobs.add(id);
        this.roots.set(id, {
          dir: typeof data.asyncDir === "string" ? data.asyncDir : undefined,
        });
      }
      this.report("subagent_started", this.summary(data));
      this.schedule(0);
      if (this.stopped) void this.stop().catch(() => {});
    });
    this.bus.on("subagent:async-complete", (value) => {
      const data = record(value);
      for (const id of [data.id, data.runId])
        if (typeof id === "string") {
          this.jobs.delete(id);
          this.ownedChildren.delete(id);
          const root = this.roots.get(id);
          if (root) root.completed = true;
        }
      this.toolResult({ details: { ...data, results: data.results ?? [] } });
      this.report("subagent_completed", this.summary(data));
      this.schedule(0);
      if (this.stopped) void this.stop().catch(() => {});
    });
    this.bus.on("subagent:child-status", (value) => {
      const data = record(value);
      if (
        typeof data.runId === "string" &&
        typeof (data.workflowKey ?? data.childId) === "string"
      )
        this.projection.upsert(
          data.runId,
          data.workflowKey ?? data.childId,
          { ...data, runId: data.childRunId },
          data.runId,
          false,
        );
      this.report("subagent_status", this.summary(data));
      this.publishSoon();
      this.schedule(0);
    });
  }
  private summary(data: Record<string, unknown>) {
    return Object.fromEntries(
      [
        "id",
        "runId",
        "parentWorkflowRunId",
        "workflowKey",
        "childId",
        "childRunId",
        "agent",
        "status",
        "state",
        "index",
        "success",
        "exitCode",
      ]
        .filter((k) => ["string", "number", "boolean"].includes(typeof data[k]))
        .map((k) => [k, data[k]]),
    );
  }
  async rpc(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const off = this.bus.on(
        `subagents:rpc:v1:reply:${requestId}`,
        (value) => {
          clearTimeout(timer);
          off();
          const reply = record(value);
          reply.success
            ? resolve(record(reply.data))
            : reject(
                Object.assign(
                  new Error(reply.error?.message ?? "Subagent control failed"),
                  { code: reply.error?.code },
                ),
              );
        },
      );
      const timer = setTimeout(() => {
        off();
        reject(new Error("Subagent control timed out"));
      }, 10000);
      this.bus.emit("subagents:rpc:v1:request", {
        version: 1,
        requestId,
        method,
        params,
      });
    });
  }
  async attach(session: AgentSession) {
    this.session = session;
    const ping = await this.rpc("ping");
    if (!Array.isArray(ping.methods) || !ping.methods.includes("status"))
      throw new Error(
        "Installed subagent extension lacks the status protocol.",
      );
    this.off = session.subscribe((event) => {
      if (
        (event.type === "tool_execution_update" ||
          event.type === "tool_execution_end") &&
        event.toolName === "subagent"
      )
        this.toolResult(
          event.type === "tool_execution_update"
            ? event.partialResult
            : event.result,
        );
      if (
        event.type === "message_start" &&
        event.message.role === "custom" &&
        event.message.customType === "jelly-subagent-status"
      ) {
        this.heartbeatPending = false;
        this.lastHeartbeat = this.now();
      }
    });
    this.schedule(0);
  }
  /** Also called by Harness's launch wrapper so direct SDK tool execution is visible. */
  toolResult(value: unknown) {
    const details = record(record(value).details);
    if (typeof details.asyncId === "string") {
      const root = this.roots.get(details.asyncId) ?? {};
      if (typeof details.asyncDir === "string") root.dir = details.asyncDir;
      this.roots.set(details.asyncId, root);
      if (!root.completed) this.jobs.add(details.asyncId);
    }
    this.projection.tool(value);
    this.publishSoon();
    this.schedule(0);
  }
  widget(key: string, lines: string[] | undefined) {
    if (key === "subagent-async") {
      // Widgets are hints only; canonical status/ownership remain authoritative.
      this.schedule(0);
      return;
    }
    if (key === "subagent-inspect") return; // Never render private inspection transport.
    this.report("extension_widget", {
      key: key.slice(0, 128),
      lines: lines?.slice(0, 20).map((line) => line.slice(0, 500)) ?? [],
    });
  }
  private publishSoon() {
    if (this.stopped || this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      this.publish();
    }, 250);
  }
  private publish() {
    const snapshot = this.projection.snapshot();
    const signature = JSON.stringify([
      snapshot.children,
      snapshot.omitted,
      snapshot.error,
      this.projection.sources,
    ]);
    if (signature === this.lastPublished) return;
    this.lastPublished = signature;
    this.options.onSnapshot?.(snapshot, this.projection.sources);
    this.report("subagents_updated", { snapshot });
  }
  private schedule(delay = this.options.pollMs ?? 3000) {
    if (!this.session || this.stopped || this.timer || this.refreshing) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().finally(() => {
        if (
          this.jobs.size ||
          this.live() ||
          this.projection
            .snapshot()
            .children.some((child) => subagentIsActive(child.state))
        )
          this.schedule(
            Math.min(
              30000,
              (this.options.pollMs ?? 3000) * Math.max(1, this.failures),
            ),
          );
      });
    }, delay);
  }
  private live() {
    return this.session
      ? subagentLiveness(this.session.sessionManager.getSessionId()) === true
      : false;
  }
  private async statusFile(id: string, root: Root) {
    if (!root.dir || !this.session) return undefined;
    const path = join(root.dir, "status.json");
    const canonical = await realpath(path);
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat(),
        size = stat.size;
      if (!stat.isFile() || size > 1024 * 1024)
        throw new Error("Subagent status is not a bounded regular file.");
      const buffer = Buffer.alloc(Math.min(size + 1, 1024 * 1024 + 1));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1024 * 1024)
        throw new Error("Subagent status exceeds the observation limit.");
      const current = await lstat(path);
      if (
        (await realpath(path)) !== canonical ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        !current.isFile()
      )
        throw new Error("Subagent status changed while reading.");
      const raw = record(
        JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
      );
      const manager = this.session.sessionManager;
      if (
        raw.runId !== id ||
        ![manager.getSessionId(), manager.getSessionFile()]
          .filter(Boolean)
          .includes(raw.sessionId)
      )
        throw new Error("Subagent status ownership mismatch.");
      return raw;
    } finally {
      await file.close();
    }
  }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (this.stopped || !this.session) return Promise.resolve();
    this.refreshing = this.refreshNow().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  private async refreshNow() {
    try {
      const snapshotGeneration = this.projection.attemptGeneration;
      const fleet = await this.rpc("status");
      const snapshot = record(fleet.asyncSnapshot);
      if (snapshot.version === 1 && Array.isArray(snapshot.runs)) {
        this.projection.omitted = Math.max(
          this.projection.omitted,
          Number(snapshot.omitted?.runs ?? 0) +
            Number(snapshot.omitted?.children ?? 0),
        );
        for (const raw of snapshot.runs.slice(0, 128)) {
          const node = record(raw);
          if (typeof node.id !== "string") continue;
          const target = this.projection.runTargets.get(node.id);
          if (target) {
            const child = record(node.children?.[0]);
            this.projection.upsert(
              target.rootId,
              target.childId,
              {
                ...node,
                ...child,
                state: child.state ?? node.state,
                runId: node.id,
              },
              target.rootId,
            );
            continue;
          }
          let root = this.roots.get(node.id);
          if (!root && ["queued", "running", "paused"].includes(node.state)) {
            // A snapshot also contains workflow-owned children. They are display
            // records, not independently notified jobs. The package liveness
            // provider retains restored work without inventing completion owners.
            root = {};
            this.roots.set(node.id, root);
          }
          if (root && !root.dir && !root.completed) {
            root.status = {
              state: node.state,
              mode: node.kind,
              steps: (node.children ?? []).map((child: any, index: number) => ({
                ...child,
                workflowKey: node.kind === "workflow" ? child.id : undefined,
                status: child.state,
                agent: child.label,
                index,
              })),
            };
            this.projection.status(node.id, root.status);
          }
        }
      }
      // Targeted status invokes package reconciliation; a missing row in a
      // truncated fleet snapshot is never interpreted as completion.
      let rootFailure = false;
      for (const [id, root] of this.roots) {
        try {
          if (root.completed && !root.dir) continue;
          if (!root.completed) await this.rpc("status", { id });
          if (this.stopped) return;
          const status = (await this.statusFile(id, root)) ?? root.status;
          if (!status) continue;
          this.projection.status(id, status);
          const state = childState(status.state);
          const childrenLive = (status.steps ?? []).some((step: unknown) =>
            subagentIsActive(childState(record(step).status)),
          );
          if (
            ["completed", "failed", "stopped"].includes(state) &&
            !childrenLive
          ) {
            root.terminalAt ??= this.now();
            // Native watcher usually delivers first (its event follows notifier
            // acceptance). Recover a missing event with an explicit model wake,
            // never by silently declaring success from a stale job counter.
            if (
              this.jobs.has(id) &&
              !this.live() &&
              this.now() - root.terminalAt >=
                (this.options.reconciliationMs ?? 15000)
            ) {
              await this.wake(
                `Subagent completion reconciliation for ${id}: canonical state ${state}. Inspect this run's status/results before concluding; the normal completion event was not observed.`,
              );
              this.jobs.delete(id);
              root.completed = true;
            }
          } else root.terminalAt = undefined;
          if (root.completed) root.dir = undefined; // terminal projection retained; no repeated file scans
        } catch {
          rootFailure = true;
        }
      }
      // The package overlays independently materialized/resumed children onto
      // workflow lanes. Their live activity is newer than the workflow file.
      for (const raw of (Array.isArray(snapshot.runs)
        ? snapshot.runs
        : []
      ).slice(0, 128)) {
        const node = record(raw);
        if (typeof node.id !== "string") continue;
        const target = this.projection.runTargets.get(node.id);
        if (target) {
          this.projection.upsert(
            target.rootId,
            target.childId,
            {
              ...node,
              ...record(node.children?.[0]),
              state: node.state,
              runId: node.id,
            },
            target.rootId,
          );
          continue;
        }
        // Workflow snapshot lanes carry keys, not attempt IDs. A snapshot
        // captured before a file/event revealed a new attempt cannot update it.
        if (this.projection.attemptGeneration !== snapshotGeneration) continue;
        for (const [index, rawChild] of (Array.isArray(node.children)
          ? node.children
          : []
        )
          .slice(0, 128)
          .entries()) {
          const child = record(rawChild);
          if (child.kind === "host-step" || typeof child.id !== "string")
            continue;
          const childTarget = this.projection.runTargets.get(child.id);
          const childId =
            childTarget?.childId ??
            (node.kind === "workflow" ? child.id : `step:${index}`);
          const existing = [...this.projection.cards.values()].find(
            (card) => card.rootId === node.id && card.childId === childId,
          );
          // Identity-less overlays enrich activity, not contradictory lifecycle
          // facts already read from a concrete attempt's canonical record.
          if (existing && existing.state !== childState(child.state)) continue;
          this.projection.upsert(
            node.id,
            childId,
            {
              state: child.state,
              activity: child.activity,
              startedAt: child.startedAt,
              endedAt: child.endedAt,
            },
            node.kind === "workflow" ? node.id : undefined,
          );
        }
      }
      this.failures = rootFailure ? this.failures + 1 : 0;
      this.projection.error = rootFailure
        ? "Some subagent statuses could not be refreshed. Work is still being tracked; retrying."
        : undefined;
      this.publish();
    } catch {
      this.failures++;
      this.projection.error =
        "Subagent status could not be refreshed. Work is still being tracked; retrying.";
      this.publish();
    }
    // An observation failure is itself useful status, not a reason to silence
    // the parent indefinitely. Keep the cadence while known work is retained.
    if (
      !this.stopped &&
      (this.jobs.size || this.live()) &&
      this.now() - this.lastHeartbeat >= (this.options.heartbeatMs ?? 300000) &&
      !this.heartbeatPending &&
      !this.wakes.size
    ) {
      this.heartbeatPending = true;
      void this.wake(this.digest()).catch(() => {
        this.heartbeatPending = false;
      });
    }
  }
  private digest() {
    const snapshot = this.projection.snapshot(),
      now = this.now();
    const rows = snapshot.children.slice(0, 32).map((child) => {
      const age =
        child.lastActivityAt === undefined
          ? "activity unknown"
          : `last activity ${Math.max(0, Math.round((now - child.lastActivityAt) / 1000))}s ago`;
      const elapsed =
        child.startedAt === undefined
          ? ""
          : `; elapsed ${Math.max(0, Math.round((now - child.startedAt) / 60000))}m`;
      const tool = child.currentTool
        ? `; tool ${child.currentTool}${child.currentToolStartedAt === undefined ? "" : ` (${Math.max(0, Math.round((now - child.currentToolStartedAt) / 1000))}s)`}`
        : "";
      return `${child.label} [run ${child.rootId}, child ${child.childId}]: ${child.state}${elapsed}${tool}; ${age}${child.attention ? `; ${child.attention}` : ""}`;
    });
    return [
      `Subagent status checkpoint (${Math.round((this.options.heartbeatMs ?? 300000) / 60000)}-minute cadence):`,
      ...rows,
      ...(snapshot.error ? [snapshot.error] : []),
      `${this.jobs.size} owned root runs awaiting delivery; ${Math.max(0, snapshot.children.length - rows.length) + snapshot.omitted} children omitted.`,
      "Use subagent status for result details and subagent_supervisor pending for decisions. Inspect apparent stalls before acting. Existing work remains owned: do not relaunch it. Summarize meaningful progress for the user, then yield while children continue.",
    ].join("\n");
  }
  wakeSteering() {
    if (
      this.session?.isIdle &&
      this.settling &&
      !this.stopped &&
      (this.jobs.size || this.live())
    )
      void this.wake(
        "New user steering is queued. Read it before continuing delegated work.",
        "jelly-steering-wake",
      ).catch(() => {});
  }
  private wake(content: string, customType = "jelly-subagent-status") {
    if (!this.session || this.stopped) return Promise.resolve();
    const promise = this.session.sendCustomMessage(
      { customType, content, display: false },
      { triggerTurn: true, deliverAs: "steer" },
    );
    this.wakes.add(promise);
    void promise.then(
      () => this.wakes.delete(promise),
      () => {
        this.wakes.delete(promise);
        this.report("extension_notice", {
          level: "error",
          text: "The subagent status update could not reach the parent model.",
        });
      },
    );
    return promise;
  }
  async settle(session: AgentSession) {
    this.settling = true;
    try {
      do {
        while (
          (this.jobs.size || this.live() || this.wakes.size) &&
          !this.stopped
        ) {
          this.schedule();
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await this.refresh(); // capture terminal records even when completion beat the scheduled poll
        await session.waitForIdle();
        await this.refreshing;
      } while (
        (this.jobs.size || this.live() || this.wakes.size) &&
        !this.stopped
      );
      this.publish();
    } finally {
      this.settling = false;
    }
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.publishTimer);
    this.timer = undefined;
    this.publishTimer = undefined;
    const targets = new Set([
      ...this.jobs,
      ...[...this.ownedChildren]
        .filter(([, owner]) => !this.jobs.has(owner))
        .map(([id]) => id),
    ]);
    for (const id of targets) {
      if (this.stopping.has(id)) continue;
      const request = this.rpc("stop", { id })
        .then(
          () => {},
          (error) => {
            if ((error as { code?: string }).code !== "invalid_state")
              throw error;
            this.jobs.delete(id);
            this.ownedChildren.delete(id);
          },
        )
        .finally(() => {
          this.stopping.delete(id);
        });
      this.stopping.set(id, request);
    }
    const outcomes = await Promise.allSettled([...this.stopping.values()]);
    if (outcomes.some((outcome) => outcome.status === "rejected"))
      throw new Error(
        "Subagent cancellation could not be confirmed. Inspect remaining work before continuing.",
      );
  }
  async dispose(session: AgentSession) {
    try {
      await this.stop();
    } finally {
      this.off?.();
      try {
        await session.abort();
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      } finally {
        await this.refreshing;
        await Promise.allSettled([...this.wakes]);
        session.dispose();
        this.bus.clear();
      }
    }
  }
}
