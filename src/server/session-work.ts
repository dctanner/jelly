import {
  createEventBus,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
/** Bridges package-owned background jobs into Jelly's run lifecycle. */
export class SessionWork {
  readonly bus = createEventBus();
  private jobs = new Set<string>();
  private stopped = false;
  constructor(
    private report: (type: string, data: Record<string, unknown>) => void,
  ) {
    this.bus.on("subagent:async-started", (value) => {
      const data = value as Record<string, unknown>;
      if (typeof data.id === "string") this.jobs.add(data.id);
      this.report("subagent_started", this.summary(data));
      if (this.stopped) void this.stop().catch(() => {});
    });
    this.bus.on("subagent:async-complete", (value) => {
      const data = value as Record<string, unknown>;
      for (const id of [data.id, data.runId])
        if (typeof id === "string") this.jobs.delete(id);
      this.report("subagent_completed", this.summary(data));
    });
    this.bus.on("subagent:child-status", (value) =>
      this.report(
        "subagent_status",
        this.summary(value as Record<string, unknown>),
      ),
    );
  }
  private summary(data: Record<string, unknown>) {
    return Object.fromEntries(
      [
        "id",
        "runId",
        "agent",
        "status",
        "state",
        "type",
        "index",
        "success",
        "exitCode",
      ]
        .filter(
          (k) =>
            typeof data[k] === "string" ||
            typeof data[k] === "number" ||
            typeof data[k] === "boolean",
        )
        .map((k) => [k, data[k]]),
    );
  }
  private rpc(method: string, params: Record<string, unknown>) {
    return new Promise<void>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const off = this.bus.on(
        `subagents:rpc:v1:reply:${requestId}`,
        (value) => {
          clearTimeout(timer);
          off();
          const reply = value as {
            success: boolean;
            error?: { code: string; message: string };
          };
          reply.success
            ? resolve()
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
  async settle(session: AgentSession) {
    do {
      while (this.jobs.size && !this.stopped)
        await new Promise((r) => setTimeout(r, 50));
      await session.waitForIdle();
    } while (this.jobs.size && !this.stopped);
  }
  async stop() {
    this.stopped = true;
    await Promise.all(
      [...this.jobs].map(async (id) => {
        try {
          await this.rpc("stop", { id });
        } catch (error) {
          // Completion can win the race against Stop. The package checks the
          // owned root status before returning invalid_state (not running).
          if ((error as { code?: string }).code !== "invalid_state")
            throw error;
          this.jobs.delete(id);
        }
      }),
    );
  }
  async dispose(session: AgentSession) {
    try {
      await this.stop();
    } finally {
      try {
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      } finally {
        session.dispose();
        this.bus.clear();
      }
    }
  }
}
