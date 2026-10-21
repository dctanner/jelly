import type { ChromeSessions } from "./chrome-sessions";
import type { ChromeSelection } from "../shared/chrome-protocol";

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
  keepTab?: (mark?: "deliverable" | "handoff") => Promise<unknown>;
  action(
    method: ConnectedBrowserMethod,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  reserveLogin(id: string, url: string, signal?: AbortSignal): Promise<unknown>;
  cancelLogin(id: string): void;
}
/** Successfully allocated Chrome profile/site scope choices stay pinned until released. */
export class BrowserSessions {
  private pins = new Map<string, ChromeSelection>();
  constructor(readonly chrome: ChromeSessions) {}
  forRun(
    agent: string,
    run: string,
    selection: ChromeSelection,
    name: string,
  ): { target: "chrome"; get(id: string): BrowserPort } {
    const selected = this.pins.get(agent) ?? structuredClone(selection);
    let port: BrowserPort | undefined;
    return {
      target: "chrome",
      get: (id) => {
        if (id !== agent)
          throw new Error("Child/foreign Chrome browser access is unavailable.");
        if (!port) {
          port = this.chrome.allocate(agent, run, selected, name);
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
