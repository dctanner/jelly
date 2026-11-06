import type { ChromeSessions } from "./chrome-sessions";
import type { ChromeSelection } from "../shared/chrome-protocol";
import type { BrowserRecoveryBinding, BrowserRecoveryResult } from "../shared/browser-recovery";

/** Server-only continuation, never serialized or exposed as an agent tool. */
export interface BrowserRecovery {
  binding: BrowserRecoveryBinding;
  check(): void;
  close(signal: AbortSignal): Promise<BrowserRecoveryResult>;
  release(): void;
}

export type ConnectedBrowserMethod =
  | "open"
  | "name"
  | "snapshot"
  | "screenshot"
  | "click"
  | "fill"
  | "select"
  | "key"
  | "wait_for"
  | "scroll"
  | "tabs";

export interface BrowserPort {
  target?: "chrome";
  reconnect?: (signal?: AbortSignal) => Promise<{
    status: "reconnected" | "already_connected";
    message: string;
  }>;
  prepareRecovery?: () => BrowserRecovery;
  keepTab?: (mark?: "deliverable" | "handoff") => Promise<unknown>;
  action(
    method: ConnectedBrowserMethod,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  reserveLogin(id: string, url: string, signal?: AbortSignal): Promise<unknown>;
  cancelLogin(id: string): void;
}
/** Successfully allocated Chrome profile choices stay pinned until released. */
export class BrowserSessions {
  private pins = new Map<string, ChromeSelection>();
  constructor(readonly chrome: ChromeSessions) {}
  forRun(
    agent: string,
    run: string,
    selection: ChromeSelection,
    name: string,
    assertReconnectAllowed?: () => void,
  ): { target: "chrome"; get(id: string): BrowserPort } {
    const selected = this.pins.get(agent) ?? structuredClone(selection);
    let port: BrowserPort | undefined;
    return {
      target: "chrome",
      get: (id) => {
        if (id !== agent)
          throw new Error("Child/foreign Chrome browser access is unavailable.");
        // Only an acknowledged human recovery may retire a port during a run.
        if (port && this.chrome.recoveryRetired(port)) {
          port = undefined;
        }
        if (!port) {
          // Allocation can fail after retirement; every retry needs fresh authority.
          assertReconnectAllowed?.();
          port = this.chrome.allocate(agent, run, selected, name, assertReconnectAllowed);
          this.pins.set(agent, selected);
        }
        return port;
      },
    };
  }
  target(agent: string) {
    return this.pins.has(agent) ? "chrome" as const : undefined;
  }
  releasePin(agent: string) {
    this.pins.delete(agent);
  }
}
