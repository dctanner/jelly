import { createHash } from "node:crypto";
import { join } from "node:path";
import { Computer } from "./computer";
import { HttpError } from "./errors";

/** Each entry owns its display, Chromium context, profile, clipboard and tickets. */
export class ComputerSessions {
  private sessions = new Map<string, Computer>();
  private origins: string[] = [];
  private closing = false;
  constructor(private dataDir: string, private validAgent: (id: string) => boolean,
    private changed: (id: string) => void = () => {}) {}
  get(agentId: string): Computer {
    if (!agentId || !this.validAgent(agentId)) throw new HttpError(404, "Agent not found.");
    if (this.closing) throw new HttpError(503, "Browser sessions are closing.");
    let computer = this.sessions.get(agentId);
    if (!computer) {
      // Bound resource use without evicting a private handoff or active operation.
      if (this.sessions.size >= 8) throw new HttpError(409, "Close another agent browser session first (limit 8).");
      const directory = createHash("sha256").update(agentId).digest("hex");
      computer = new Computer(join(this.dataDir, "browser-sessions", directory), () => this.changed(agentId), this.dataDir);
      computer.protectOrigins(this.origins);
      this.sessions.set(agentId, computer);
    }
    return computer;
  }
  state(agentId: string | null, owner?: string) {
    return (agentId ? this.sessions.get(agentId) : undefined)?.state(owner) ?? {
      status: "stopped" as const, control: "agent" as const, owned: false, handoffId: null, error: null,
    };
  }
  protectOrigins(origins: string[]) {
    this.origins.push(...origins);
    for (const computer of this.sessions.values()) computer.protectOrigins(origins);
  }
  async closeSession(agentId: string) {
    const computer = this.sessions.get(agentId);
    if (!computer) return;
    await computer.close();
    if (this.sessions.get(agentId) === computer) this.sessions.delete(agentId);
    this.changed(agentId);
  }
  async close() {
    this.closing = true;
    await Promise.all([...this.sessions.values()].map(computer => computer.close()));
    this.sessions.clear();
  }
}
