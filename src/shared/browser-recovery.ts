/** Recovery results never carry operator credentials or browser capabilities. */
export interface BrowserRecoveryResult {
  status: "requested" | "awaiting_human" | "approved_closed" | "cancelled" | "rejected" | "stale" | "failed";
  message: string;
  disposition?: "closed_connected_session" | "retired_lost_session";
}

export interface BrowserRecoveryBinding {
  agent: string;
  run: string;
  authorityRun: string;
  session: string;
  profile: string;
  generation: string;
  pairedGeneration: string;
  revision: number;
  pauseState: string;
  lost: boolean;
}
