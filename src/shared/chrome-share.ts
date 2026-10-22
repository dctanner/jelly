export interface ChromeShareState {
  status:
    | "idle"
    | "pausing"
    | "sharing"
    | "stopping"
    | "disconnected"
    | "failed"
    | "orphaned";
  owned: boolean;
  /** Stable for one Take; unlike transport generation, survives reconnects. */
  controlId?: string | null;
  profile: string | null;
  agentId: string | null;
  generation: number;
  error: string | null;
  ownedDesktopAvailable?: boolean;
}
