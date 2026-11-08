/** Shared types for the Codex-style Connected Chrome engine (plans/codex-style-browser.md). */

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  windowId?: number;
  active?: boolean;
  origin?: "agent" | "user";
  mark?: "deliverable" | "handoff" | null;
}

export interface UserTabInfo {
  id: number;
  title: string;
  url: string;
  windowId?: number;
  active?: boolean;
  lastAccessed?: number;
  groupId?: number;
  pinned?: boolean;
}

export type ChromePortEvent =
  | { type: "cdpEvent"; tabId: number; sessionId?: string; method: string; params: any }
  | { type: "cdpDetach"; tabId: number; reason: string }
  | { type: "tabAdded"; tab: TabInfo }
  | { type: "tabRemoved"; tabId: number };

/** Extension RPC for one agent session (protocol v9, §1 of the spec). */
export interface ChromePort {
  call(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<any>;
  onEvent(listener: (event: ChromePortEvent) => void): () => void;
}

export type BrowserHost = (
  op: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

/** Model-facing browser failure (message is shown to the agent as-is). */
export class BrowserError extends Error {}
