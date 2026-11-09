import { ChromeBridge } from "./chrome-bridge";
import {
  chromeParams,
  type ChromeMethod,
  type ChromeSelection,
} from "../shared/chrome-protocol";
import { chromePauseError, type ChromePauseReason } from "../shared/chrome-errors";
import { BrowserEngine } from "./browser/engine";
import type { ChromePort, ChromePortEvent, TabInfo } from "./browser/types";
import { HttpError } from "./errors";
import type { BrowserPort, BrowserRecovery } from "./browser-sessions";
import type { BrowserRecoveryBinding } from "../shared/browser-recovery";
interface Task {
  agent: string;
  id: string;
  profile: string;
  generation: string;
  run: string | null;
  authorityRun: string;
  begun: boolean;
  settling: boolean;
  paused: boolean; // Authority revoked, not necessarily safe for credential entry.
  pauseState: "active" | "pausing" | "paused" | "resuming" | "failed";
  pauseReason?: ChromePauseReason;
  pausePending: Promise<void> | null;
  resumePending: boolean;
  transition: number;
  humanUsing: boolean;
  lost: boolean;
  active: number | null;
  tabs: Set<number>;
  handoff: string | null;
  chain: Promise<unknown>;
  inflight: Set<Promise<unknown>>;
  beginning: Promise<void> | null;
  listeners: Set<(event: ChromePortEvent) => void>;
  engine: BrowserEngine;
  admit?: <T>(fn: () => Promise<T>) => Promise<T>;
  recoveryRequest?: boolean;
  recoveryClosing?: boolean;
}
export class ChromeSessions {
  readonly bridge: ChromeBridge;
  private tasks = new Map<string, Task>();
  private nativePauses = new Map<Task, number>();
  private nativeHandoff = false;
  private nativeRevision = 0;
  private retiredPorts = new WeakSet<BrowserPort>();
  recoveryRetired(port: BrowserPort) { return this.retiredPorts.has(port); }
  private protected: string[] = [];
  private humanDesktop = false;
  /** Advisory only: never used by automation admission. */
  setHumanDesktop(value: boolean) { this.humanDesktop = value; }
  humanState() {
    return this.humanDesktop || [...this.tasks.values()].some(t => t.humanUsing);
  }
  pendingHandoffs(onComputer: (profile: string, generation: string) => boolean = () => true) {
    return [...this.tasks.values()].flatMap(t =>
      t.handoff && onComputer(t.profile, t.generation) ? [{ agent: t.agent, id: t.handoff }] : []);
  }
  done(agent: string, handoff: string | null) {
    const t = this.tasks.get(agent);
    if (!t) {
      if (handoff) throw new HttpError(409, "This browser request is no longer current.");
      return null;
    }
    if (t.handoff !== handoff) throw new HttpError(409, "This browser request is no longer current.");
    t.humanUsing = false;
    t.handoff = null;
    if (handoff) ++t.transition;
    this.changed(agent);
    return handoff;
  }
  constructor(
    dataDir: string,
    instance: string,
    private changed: (agent: string) => void = () => {},
  ) {
    this.bridge = new ChromeBridge(dataDir, instance);
    this.bridge.onLoss = (profile) => {
      for (const t of this.tasks.values())
        if (t.profile === profile) {
          t.lost = true;
          t.paused = true;
          t.tabs.clear();
          t.active = null;
          this.changed(t.agent);
        }
    };
    // Extension notifications are scoped to the session, not to one run: a
    // retained handoff tab keeps reporting between runs.
    const forSession = (profile: string, generation: string, session: string, fn: (t: Task) => void) => {
      for (const t of this.tasks.values())
        if (t.profile === profile && t.generation === generation && t.id === session && !t.lost) fn(t);
    };
    const emit = (t: Task, event: ChromePortEvent) => {
      for (const listener of t.listeners) {
        try { listener(event); } catch {}
      }
    };
    this.bridge.onTabRemoved = (profile, generation, session, _run, tabId) =>
      forSession(profile, generation, session, (t) => {
        t.tabs.delete(tabId);
        if (t.active === tabId) t.active = t.tabs.values().next().value ?? null;
        emit(t, { type: "tabRemoved", tabId });
        this.changed(t.agent);
      });
    this.bridge.onTabAdded = (profile, generation, session, _run, tab) =>
      forSession(profile, generation, session, (t) => {
        t.tabs.add(tab.id);
        t.active ??= tab.id;
        emit(t, { type: "tabAdded", tab });
        this.changed(t.agent);
      });
    this.bridge.onCdpEvent = (profile, generation, session, _run, event) =>
      forSession(profile, generation, session, (t) => emit(t, { type: "cdpEvent", ...event }));
    this.bridge.onCdpDetach = (profile, generation, session, _run, tabId, reason) =>
      forSession(profile, generation, session, (t) => emit(t, { type: "cdpDetach", tabId, reason }));
    this.bridge.onPauseState = (profile, generation, session, run, state, reason) => {
      for (const t of this.tasks.values())
        if (
          t.profile === profile &&
          t.generation === generation &&
          t.id === session &&
          (t.run === run || (!t.begun && t.authorityRun === run)) &&
          !t.lost
        ) {
          // end() emits a routine settlement pause while releasing debugger
          // leases. It is not a security pause. In particular, an ACK arriving
          // after settle() must not poison the next run (or make a routine
          // transport loss require security-pause session retirement).
          // Independent failures, including failed settlement cleanup, still
          // reach the security latch below.
          if (reason === "settlement" && state !== "failed" &&
              (t.settling || t.recoveryClosing || !t.run)) return;
          t.paused = true;
          // Legacy peers omit the reason on generic pause acknowledgements.
          // Retain a known current native cause, never an independent failure.
          const nativeAcknowledgement =
            (reason === undefined || reason === "requested") &&
            state !== "failed" && t.pauseReason === "native_handoff" &&
            (t.pausePending || t.pauseState === "pausing" || this.nativePauses.has(t));
          if (!nativeAcknowledgement &&
              !(t.settling && (reason === "settlement" || reason === "requested")))
            t.pauseReason = reason;
          ++t.transition;
          // A local acknowledgement must not revive a safe indicator while
          // Resume is in flight or finish a still-pending server pause RPC.
          if (state === "paused" && t.resumePending) t.pauseState = "failed";
          else if (state !== "paused" || !t.pausePending) t.pauseState = state;
          this.changed(t.agent);
        }
    };
  }
  protectOrigins(origins: string[]) {
    this.protected.push(...origins);
  }
  validate(selection: ChromeSelection) {
    if (
      typeof selection.chromeProfile !== "string" ||
      (selection.chromeProfile !== "" &&
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(selection.chromeProfile))
    )
      throw new HttpError(400, "Invalid Connected Chrome profile.");
  }
  allocate(
    agent: string,
    run: string,
    selection: ChromeSelection,
    name: string,
    assertReconnectAllowed: () => void = () => {},
  ) {
    let task = this.tasks.get(agent);
    if (!task) {
      this.validate(selection);
      if (!selection.chromeProfile)
        throw new HttpError(
          400,
          "Choose a connected Chrome profile in Settings → Connected Chrome. No managed-browser fallback.",
        );
      const profile = this.bridge
        .profiles()
        .find((p) => p.id === selection.chromeProfile);
      if (!profile)
        throw new Error(
          "Selected Chrome profile is disconnected. No managed-browser fallback.",
        );
      if (this.tasks.size >= 8)
        throw new Error("Close another Chrome session first (limit 8).");
      task = {
        agent,
        id: crypto.randomUUID(),
        profile: profile.id,
        generation: profile.generation,
        run: null,
        authorityRun: run,
        begun: false,
        settling: false,
        paused: false,
        pauseState: "active",
        pausePending: null,
        resumePending: false,
        transition: 0,
        humanUsing: false,
        lost: false,
        active: null,
        tabs: new Set(),
        handoff: null,
        chain: Promise.resolve(),
        inflight: new Set(),
        beginning: null,
        listeners: new Set(),
        engine: undefined as unknown as BrowserEngine,
      };
      const created = task;
      const chromePort: ChromePort = {
        call: (method, params = {}, signal, timeoutMs) => this.portCall(created, method, params, signal, timeoutMs),
        onEvent: (listener) => {
          created.listeners.add(listener);
          return () => created.listeners.delete(listener);
        },
      };
      task.engine = new BrowserEngine(chromePort);
      this.tasks.set(agent, task);
    }
    const t = task;
    if (t.run && t.run !== run)
      throw new Error("Chrome task is still owned by another run.");
    t.run = run;
    const assertRun = () => {
      if (this.tasks.get(agent) !== t || t.run !== run || t.settling || t.recoveryClosing)
        throw new Error("Chrome run authority expired. Only the current active run can use or reconnect its session.");
    };
    const serialize = <T>(fn: () => Promise<T> | T) => {
      try { assertRun(); } catch (error) { return Promise.reject<T>(error); }
      const session = t.id;
      const next = t.chain.catch(() => {}).then(() => {
        assertRun();
        if (t.id !== session)
          throw new Error("Chrome session changed while this operation was queued. Nothing was replayed. Open the page again and call tab.ax.write().");
        return fn();
      });
      t.chain = next;
      return next;
    };
    const begin = (): Promise<void> => {
      if (t.lost || t.run !== run)
        return Promise.reject(new Error(
          "Chrome authority expired. Call browser_reconnect to create a fresh session, then reopen the page. Do not replay an unconfirmed action.",
        ));
      if (t.paused) return Promise.reject(new Error(chromePauseError(t.pauseReason)));
      if (t.begun && !t.beginning) return Promise.resolve();
      t.beginning ??= (async () => {
        // Record cleanup authority before dispatch; a connection failure can
        // revoke the result after the extension has already created the task.
        t.begun = true;
        t.authorityRun = run;
        const resumed = (await this.call(t, "begin", { name: name.slice(0, 75), agent })) as { paused?: boolean; tabs?: number[] };
        t.tabs = new Set((resumed.tabs ?? []).filter((id) => Number.isSafeInteger(id)));
        if (!t.active || !t.tabs.has(t.active)) t.active = t.tabs.values().next().value ?? null;
        // End detaches retained tabs. A new run reclaims retained handoff tabs.
        if (resumed.paused && !t.paused) await this.call(t, "resume", {});
        t.authorityRun = run;
      })().catch((error) => {
        t.begun = false;
        throw error;
      }).finally(() => { t.beginning = null; });
      return t.beginning.then(() => {
        if (t.paused) throw new Error(chromePauseError(t.pauseReason));
      });
    };
    t.admit = async <T,>(fn: () => Promise<T>): Promise<T> => {
      assertRun();
      await begin();
      assertRun();
      return fn();
    };
    const port = {
      target: "chrome" as const,
      prepareRecovery: (): BrowserRecovery => {
        assertRun();
        assertReconnectAllowed();
        if (t.recoveryRequest) throw new Error("A recovery is already in progress.");
        if (this.nativeHandoff || this.nativePauses.has(t) || t.pauseReason === "native_handoff" || t.handoff || t.pausePending || t.resumePending)
          throw new Error("Finish the existing sign-in or native private handoff using its own control. Recovery cannot clear it.");
        if (!t.lost && !t.paused) throw new Error("This browser session does not need operator recovery.");
        const paired = this.bridge.profiles().find(p => p.id === t.profile);
        if (!paired || !this.bridge.canReconnect(t.profile, paired.generation) ||
            (t.lost ? paired.generation === t.generation : paired.generation !== t.generation))
          throw new Error("The pinned profile needs operator Reconnect and confirmed debugger cleanup in the Chrome extension first.");
        const binding: BrowserRecoveryBinding = {
          agent, run, authorityRun: t.authorityRun, session: t.id, profile: t.profile, generation: t.generation,
          pairedGeneration: paired.generation, revision: t.transition,
          pauseState: t.pauseState, lost: t.lost,
        };
        const nativeRevision = this.nativeRevision;
        let consumed = false, released = false;
        const check = () => {
          assertReconnectAllowed();
          if (released || this.tasks.get(agent) !== t || t.run !== run || t.settling ||
              t.id !== binding.session || t.profile !== binding.profile || t.generation !== binding.generation || t.authorityRun !== binding.authorityRun ||
              t.transition !== binding.revision || t.lost !== binding.lost ||
              (!consumed && t.pauseState !== binding.pauseState) ||
              this.nativeRevision !== nativeRevision || this.nativeHandoff || this.nativePauses.has(t) ||
              t.pauseReason === "native_handoff" || t.handoff || t.pausePending || t.resumePending ||
              !this.bridge.canReconnect(binding.profile, binding.pairedGeneration))
            throw new Error("The recovery request is stale. Nothing was restored or replayed.");
        };
        t.recoveryRequest = true;
        return {
          binding,
          check,
          release: () => {
            if (released) return;
            released = true;
            t.recoveryRequest = false;
          },
          close: (signal) => {
            if (consumed) return Promise.reject(new Error("Recovery confirmation was already consumed."));
            check();
            signal.throwIfAborted();
            consumed = true;
            t.recoveryClosing = true; // Revoke admission before draining, including queued work.
            const prior = t.chain;
            const closing = (async () => {
              await prior.catch(() => {});
              await Promise.allSettled([...t.inflight]);
              signal.throwIfAborted();
              check();
              if (!binding.lost) {
                // end's authenticated response follows extension queue drain and
                // debugger cleanup. Never interpret mere dispatch as closure.
                const ack = await this.call(t, "end", { discard: true }, signal, binding.authorityRun) as { ok?: boolean; retained?: unknown[] };
                if (ack?.ok !== true || !Array.isArray(ack.retained) || ack.retained.length)
                  throw new Error("Chrome did not acknowledge session retirement.");
              }
              signal.throwIfAborted();
              check();
              this.tasks.delete(agent);
              this.retiredPorts.add(port);
              this.changed(agent);
              return {
                status: "approved_closed" as const,
                disposition: binding.lost ? "retired_lost_session" as const : "closed_connected_session" as const,
                message: binding.lost
                  ? "The lost backend session was retired. Old tabs may remain and cannot be reused. No action was replayed. Reopen the desired page and take a fresh snapshot; verify any interrupted action before acting."
                  : "Chrome acknowledged retirement of this session. Old tabs/references cannot be reused. No action was replayed. Reopen the desired page and take a fresh snapshot; verify any interrupted action before acting.",
              };
            })();
            // Settlement must drain retirement too. On failure the task stays
            // paused/lost (no browser work is admitted), but the agent may retry
            // recovery automatically; no operator repair is needed.
            const settled = closing.catch((error) => {
              if (this.tasks.get(agent) === t) t.recoveryClosing = false;
              throw error;
            });
            t.chain = settled;
            return settled;
          },
        };
      },
      reconnect: (signal?: AbortSignal) => serialize(() => {
        signal?.throwIfAborted();
        // Revalidate at the head of the queue, not merely at tool admission.
        assertReconnectAllowed();
        if (this.nativeHandoff || t.handoff || t.pausePending || t.resumePending ||
            t.pauseState !== "active" || this.nativePauses.has(t))
          throw new Error("Browser reconnect cannot clear a sign-in handoff, native privacy pause or security fault. Finish handoffs through their existing human controls. For a security pause, call request_browser_recovery to retire this session automatically and continue.");
        const profile = this.bridge.profiles().find(p => p.id === t.profile);
        if (!profile || !this.bridge.canReconnect(t.profile, profile.generation) ||
            (t.lost && profile.generation === t.generation))
          throw new Error("The pinned Chrome profile has not reconnected. Wait for its transport to reconnect, or ask the operator to use Reconnect in the Jelly Chrome extension; then call browser_reconnect. This tool cannot clear revoked pairing or native cleanup.");
        if (!t.lost && profile.generation !== t.generation)
          throw new Error("Chrome session binding changed unexpectedly. Operator repair is required; no session was reset.");
        if (!t.lost)
          return {
            status: "already_connected" as const,
            message: "This agent's browser session is already connected; nothing was reset. Use browser_js: list tabs with browser.tabs.list() or open one with browser.tabs.new(url).",
          };
        // A new empty session, never revival of old tabs/references or replay of
        // an old RPC. Keep the exact pinned profile.
        t.id = crypto.randomUUID();
        t.generation = profile.generation;
        t.authorityRun = run;
        t.begun = false;
        t.lost = false;
        t.paused = false;
        t.active = null;
        t.tabs.clear();
        t.engine.reset();
        ++t.transition;
        this.changed(agent);
        return {
          status: "reconnected" as const,
          message: "A fresh empty session is ready on the same Chrome profile. No browser action was performed or replayed. A previous action may already have completed: verify its outcome rather than repeat it. Reopen the desired page with browser.tabs.new(url) and call tab.ax.write() before acting. Old tab handles and element indices are not reusable.",
        };
      }),
      // Per-run facade: the engine (tab state, REPL handles) persists across runs,
      // but every call is admitted only for the run that allocated this port.
      engine: {
        execute: (op: string, args: Record<string, unknown>, signal?: AbortSignal) => {
          try { assertRun(); } catch (error) { return Promise.reject(error); }
          return t.engine.execute(op, args, signal);
        },
      },
      reserveLogin: (id: string, url: string, signal?: AbortSignal) => {
        assertRun();
        // Bind before queuing, so cancel/Done during a delayed open cannot be
        // overwritten by that operation's late response.
        if (t.handoff) throw new HttpError(409, "A browser sign-in request is already pending.");
        t.handoff = id;
        ++t.transition;
        t.humanUsing = true;
        this.changed(agent);
        return serialize(async () => {
          if (t.handoff !== id) return;
          try {
            await begin();
            const { tab } = (await this.call(t, "createTab", { url }, signal)) as { tab: TabInfo };
            t.tabs.add(tab.id);
            t.active = tab.id;
            await this.call(t, "markTab", { tabId: tab.id, mark: "handoff" }, signal);
            await this.call(t, "showTab", { tabId: tab.id }, signal).catch(() => {});
            this.changed(agent);
          } catch (error) {
            if (t.handoff === id) this.done(agent, id);
            throw error;
          }
        });
      },
      cancelLogin: (id: string) => {
        if (t.handoff === id) this.done(agent, id);
      },
    } satisfies BrowserPort;
    return port;
  }
  private pause(t: Task, signal?: AbortSignal, reason: ChromePauseReason = "requested"): Promise<void> {
    if (t.pausePending) return t.pausePending;
    ++t.transition;
    t.paused = true;
    t.pauseState = "pausing";
    t.pauseReason = reason;
    this.changed(t.agent);
    const pending = this.call(t, "pause", {}, signal)
      .then(() => {
        if (t.lost)
          throw new Error("Chrome disconnected before pause acknowledgement.");
        t.pauseState = "paused";
      })
      .catch((error) => {
        t.pauseState = "failed";
        t.pauseReason = "cleanup_failed";
        throw error;
      })
      .finally(() => {
        t.pausePending = null;
        this.changed(t.agent);
      });
    t.pausePending = pending;
    return pending;
  }
  private async call(
    t: Task,
    method: ChromeMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    authorityRun = t.run ?? t.authorityRun,
    timeoutMs?: number,
  ): Promise<any> {
    if (t.lost) throw new Error("Chrome session authority expired. Call browser_reconnect; never replay an unconfirmed action.");
    if (!chromeParams(method, params))
      throw new Error(`Invalid Chrome ${method} parameters.`);
    return this.bridge.call(t.profile, t.generation, t.id, authorityRun, method, params, signal, timeoutMs);
  }
  /** Engine → extension relay call, admitted under the current run's authority. */
  private portCall(t: Task, method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number) {
    const admit = t.admit;
    if (!admit) return Promise.reject(new Error("No active run owns this Chrome session."));
    const session = t.id;
    const pending = admit(async () => {
      const result = await this.call(t, method as ChromeMethod, params, signal, undefined, timeoutMs);
      if (t.id !== session) throw new Error("Chrome session changed during the operation. Nothing was replayed.");
      const tab = (result as { tab?: TabInfo } | null)?.tab;
      if ((method === "createTab" || method === "claimTab") && tab && Number.isSafeInteger(tab.id)) {
        t.tabs.add(tab.id);
        t.active = tab.id;
        this.changed(t.agent);
      } else if (method === "closeTab") {
        t.tabs.delete(Number(params.tabId));
        if (t.active === params.tabId) t.active = t.tabs.values().next().value ?? null;
        this.changed(t.agent);
      }
      return result;
    });
    t.inflight.add(pending);
    void pending.catch(() => {}).finally(() => t.inflight.delete(pending));
    return pending;
  }
  state(agent?: string) {
    const t = agent ? this.tasks.get(agent) : undefined;
    return {
      profiles: this.bridge.profiles(),
      humanUsing: this.humanState(),
      task: t
        ? {
            profile: t.profile,
            humanUsing: t.humanUsing,
            paused:
              !t.lost &&
              !t.resumePending &&
              t.pauseState === "paused",
            pauseState: t.lost
              ? "disconnected"
              : t.pauseState,
            pauseReason: t.paused ? t.pauseReason : undefined,
            connected: !t.lost,
            active: t.active === null ? null : String(t.active),
            tabs: [...t.tabs].map(String),
            handoff: t.handoff,
          }
        : null,
    };
  }
  async pauseForNativeHandoff() {
    this.nativeHandoff = true;
    ++this.nativeRevision;
    await Promise.all([...this.tasks.values()].map(async t => {
      if (t.lost || t.paused) return;
      await this.pause(t, undefined, "native_handoff");
      this.nativePauses.set(t, t.transition);
    }));
  }
  async finishNativeHandoff() {
    for (const [t, transition] of this.nativePauses) {
      // Never clear an independent debugger/security fault or a newer pause.
      if (this.tasks.get(t.agent) !== t || t.lost || t.transition !== transition || t.pauseState !== "paused") continue;
      if (t.run && t.begun) await this.control(t.agent, "resume");
      else { t.paused = false; t.pauseState = "active"; this.changed(t.agent); }
    }
    this.nativePauses.clear();
    this.nativeHandoff = false;
    ++this.nativeRevision;
  }
  async control(agent: string, operation: string, pageId?: string) {
    const t = this.tasks.get(agent);
    if (!t && operation === "close") return null;
    if (!t) throw new HttpError(404, "No Connected Chrome session.");
    if (operation === "close") {
      if (t.run)
        throw new HttpError(
          409,
          "Stop or finish the run before closing its pinned Chrome session.",
        );
      if (t.tabs.size && !t.lost) await this.call(t, "end", { discard: true });
      this.tasks.delete(agent);
      this.changed(agent);
      return null;
    }
    if (operation === "disconnect") {
      t.paused = true;
      t.lost = true;
      this.bridge.disconnect(t.profile);
      this.changed(agent);
      return null;
    }
    if (
      !["pause", "resume", "focus", "deliverable", "handoff"].includes(
        operation,
      )
    )
      throw new HttpError(400, "Unsupported Chrome operation.");
    const tab = pageId === undefined ? t.active : Number(pageId);
    if (
      ["focus", "deliverable", "handoff"].includes(operation) &&
      (!tab || !t.tabs.has(tab))
    )
      throw new HttpError(400, "Stale or foreign tab.");
    if (operation === "resume" && (!t.run || !t.begun))
      throw new HttpError(
        409,
        "Only an active native/security-paused task can be resumed.",
      );
    if (operation === "pause") {
      await this.pause(t);
      return null;
    }
    if (
      ["focus", "resume"].includes(operation) &&
      (t.lost || t.pauseState !== "paused")
    )
      throw new HttpError(
        409,
        "Chrome security pause is not acknowledged.",
      );
    if (operation === "resume") {
      const transition = ++t.transition;
      // Revoke the human-safe signal before Chrome can resume, not after its
      // response arrives. Server tool authority stays blocked until the ACK.
      t.resumePending = true;
      t.pauseState = "resuming";
      this.changed(agent);
      try {
        await this.call(t, "resume", {});
        if (t.lost || t.transition !== transition)
          throw new Error(
            "Chrome authority changed during native handback. Reconnect the affected session.",
          );
        t.paused = false;
        t.pauseState = "active";
        return null;
      } catch (error) {
        if (t.transition === transition) {
          t.paused = true;
          t.pauseState = "failed";
        }
        throw error;
      } finally {
        t.resumePending = false;
        this.changed(agent);
      }
    }
    if (operation === "focus") await this.call(t, "showTab", { tabId: tab });
    else await this.call(t, "markTab", { tabId: tab, mark: operation });
    this.changed(agent);
    return null;
  }
  async settle(agent: string, run: string) {
    const t = this.tasks.get(agent);
    if (!t || t.run !== run) return;
    t.settling = true; // Close admission before waiting for accepted work.
    const nativePaused = this.nativePauses.get(t) === t.transition;
    ++t.transition;
    await t.chain.catch(() => {});
    await Promise.allSettled([...t.inflight]);
    const securityPaused = t.paused;
    let retained: number[] = !t.begun && !t.lost ? [...t.tabs] : [];
    try {
      if (t.begun && !t.lost) {
        if (this.humanState() && !securityPaused) {
          // Settlement ends this run; preserve temporary tabs without
          // overwriting explicit deliverable/handoff marks.
          await this.call(t, "pause", {});
        }
        const result = (await this.call(t, "end", {})) as { retained?: number[] };
        retained = result?.retained?.filter((id) => Number.isSafeInteger(id)) ?? [];
      }
    } catch {
      this.bridge.disconnect(t.profile);
      t.lost = true;
    } finally {
      t.run = null;
      t.settling = false;
      t.begun = false;
      t.tabs = new Set(retained);
      t.active = retained[0] ?? null;
      if (!t.lost) {
        t.paused = securityPaused;
        t.pauseState = t.paused ? "paused" : "active";
        if (nativePaused && t.paused) this.nativePauses.set(t, t.transition);
      }
      this.changed(agent);
    }
  }
  async close() {
    await Promise.all(
      [...this.tasks.values()].map((t) =>
        t.run ? this.settle(t.agent, t.run) : Promise.resolve(),
      ),
    );
    // Bun can deliver socket-close callbacks after server.close resolves. All
    // task authority is already settled; late loss cannot emit into a closed DB.
    this.tasks.clear();
    await this.bridge.close();
  }
}
