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
  profile: string | null;
  agentId: string | null;
  generation: number;
  error: string | null;
  ownedDesktopAvailable?: boolean;
}
