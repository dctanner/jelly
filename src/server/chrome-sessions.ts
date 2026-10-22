import { ChromeBridge } from "./chrome-bridge";
import {
  chromeOrigin,
  chromeParams,
  type ChromeMethod,
  type ChromeSelection,
} from "../shared/chrome-protocol";
import { HttpError } from "./errors";
interface Task {
  agent: string;
  id: string;
  profile: string;
  generation: string;
  origins: string[];
  siteScope: "approved" | "internet";
  run: string | null;
  authorityRun: string;
  begun: boolean;
  settling: boolean;
  paused: boolean; // Authority revoked, not necessarily safe for credential entry.
  pauseState: "active" | "pausing" | "paused" | "resuming" | "failed";
  pausePending: Promise<void> | null;
  resumePending: boolean;
  transition: number;
  humanUsing: boolean;
  lost: boolean;
  active: string | null;
  tabs: Set<string>;
  pendingRemovals: Set<Set<string>>;
  handoff: string | null;
  chain: Promise<unknown>;
}
export class ChromeSessions {
  readonly bridge: ChromeBridge;
  private tasks = new Map<string, Task>();
  private nativePauses = new Map<Task, number>();
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
    this.bridge.onTabRemoved = (profile, generation, session, run, tab) => {
      for (const t of this.tasks.values())
        if (
          t.profile === profile &&
          t.generation === generation &&
          t.id === session &&
          (t.run === run || (!t.begun && t.authorityRun === run)) &&
          !t.lost
        ) {
          for (const removed of t.pendingRemovals) removed.add(tab);
          t.tabs.delete(tab);
          if (t.active === tab) t.active = t.tabs.values().next().value ?? null;
          this.changed(t.agent);
        }
    };
    this.bridge.onTabAdded = (profile, generation, session, run, tab) => {
      for (const t of this.tasks.values())
        if (
          t.profile === profile &&
          t.generation === generation &&
          t.id === session &&
          t.run === run &&
          !t.lost &&
          t.tabs.size < 12
        ) {
          t.tabs.add(tab);
          t.active ??= tab;
          this.changed(t.agent);
        }
    };
    this.bridge.onPauseState = (profile, generation, session, run, state) => {
      for (const t of this.tasks.values())
        if (
          t.profile === profile &&
          t.generation === generation &&
          t.id === session &&
          (t.run ?? t.authorityRun) === run &&
          !t.lost
        ) {
          t.paused = true;
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
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(selection.chromeProfile)) ||
      !Array.isArray(selection.chromeOrigins) ||
      selection.chromeOrigins.length > 20 ||
      (selection.chromeSiteScope !== undefined &&
        !["approved", "internet"].includes(selection.chromeSiteScope))
    )
      throw new HttpError(400, "Invalid Connected Chrome profile/site scope.");
    try {
      for (const o of selection.chromeOrigins)
        if (chromeOrigin(o, this.protected) !== o) throw new Error();
    } catch {
      throw new HttpError(
        400,
        "Approve exact HTTP/HTTPS origins only; Jelly control endpoints and non-web URLs are unavailable.",
      );
    }
    const unconfigured = !selection.chromeProfile &&
      !selection.chromeOrigins.length && selection.chromeSiteScope !== "internet";
    if (
      !unconfigured &&
      (!selection.chromeProfile ||
        (selection.chromeSiteScope !== "internet" &&
          !selection.chromeOrigins.length))
    )
      throw new HttpError(
        400,
        "Choose a connected Chrome profile and approve site origins or select unrestricted web.",
      );
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
          "Choose a connected Chrome profile and approve site origins or select unrestricted web in Settings → Connected Chrome. No managed-browser fallback.",
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
        origins: [...selection.chromeOrigins],
        siteScope: selection.chromeSiteScope ?? "approved",
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
        pendingRemovals: new Set(),
        handoff: null,
        chain: Promise.resolve(),
      };
      this.tasks.set(agent, task);
    }
    const t = task;
    if (t.run && t.run !== run)
      throw new Error("Chrome task is still owned by another run.");
    t.run = run;
    const assertRun = () => {
      if (this.tasks.get(agent) !== t || t.run !== run || t.settling)
        throw new Error("Chrome run authority expired. Only the current active run can use or reconnect its session.");
    };
    const serialize = <T>(fn: () => Promise<T> | T) => {
      const session = t.id;
      const next = t.chain.catch(() => {}).then(() => {
        assertRun();
        if (t.id !== session)
          throw new Error("Chrome session changed while this operation was queued. Nothing was replayed. Open the page and take a fresh browser_snapshot.");
        return fn();
      });
      t.chain = next;
      return next;
    };
    const begin = async () => {
      if (t.lost || t.run !== run)
        throw new Error(
          "Chrome authority expired. Call browser_reconnect to create a fresh session, then reopen the page and take a fresh browser_snapshot. Do not replay an unconfirmed action.",
        );
      if (!t.begun) {
        // Record cleanup authority before dispatch; a connection failure can
        // revoke the result after the extension has already created the task.
        t.begun = true;
        t.authorityRun = run;
        const resumed = (await this.call(t, "begin", {
          name: name.slice(0, 75),
          agent,
          origins: t.origins,
          siteScope: t.siteScope,
          protected: this.protected,
        })) as { paused?: boolean; tabs?: string[] };
        if (resumed.paused) {
          t.tabs = new Set(
            (resumed.tabs ?? []).filter((cap) => t.tabs.has(cap)),
          );
          if (!t.active || !t.tabs.has(t.active))
            t.active = t.tabs.values().next().value ?? null;
          // End detaches retained tabs. A new run reclaims only valid retained
          // authority; extension cleanup failures still reject resume.
          if (!t.paused) await this.call(t, "resume", {});
        }
        t.authorityRun = run;
        t.begun = true;
      }
      if (t.paused)
        throw new Error(
          "Chrome automation was paused by a native desktop handoff or a security fault. Finish the native desktop handoff or ask the operator to repair the affected session; browser_reconnect cannot bypass this boundary. Human computer-control status alone does not block browser tools.",
        );
    };
    return {
      target: "chrome" as const,
      reconnect: (signal?: AbortSignal) => serialize(() => {
        signal?.throwIfAborted();
        // Revalidate at the head of the queue, not merely at tool admission.
        assertReconnectAllowed();
        if (t.handoff || t.pausePending || t.resumePending ||
            t.pauseState !== "active" || this.nativePauses.has(t))
          throw new Error("Browser reconnect cannot clear a sign-in handoff, native privacy pause or security fault. Finish the handoff or ask the operator to repair the affected session.");
        const profile = this.bridge.profiles().find(p => p.id === t.profile);
        if (!profile || !this.bridge.canReconnect(t.profile, profile.generation) ||
            (t.lost && profile.generation === t.generation))
          throw new Error("The pinned Chrome profile has not reconnected. Wait for its transport to reconnect, or ask the operator to use Reconnect in the Jelly Chrome extension; then call browser_reconnect. This tool cannot clear revoked pairing or native cleanup.");
        if (!t.lost && profile.generation !== t.generation)
          throw new Error("Chrome session binding changed unexpectedly. Operator repair is required; no session was reset.");
        if (!t.lost)
          return {
            status: "already_connected" as const,
            message: "This agent's browser session is already connected; nothing was reset. Use browser_snapshot for current references, or browser_open if no page is open.",
          };
        // A new empty session, never revival of old tabs/references or replay of
        // an old RPC. Keep the exact pinned profile and original site scope.
        t.id = crypto.randomUUID();
        t.generation = profile.generation;
        t.authorityRun = run;
        t.begun = false;
        t.lost = false;
        t.paused = false;
        t.active = null;
        t.tabs.clear();
        ++t.transition;
        this.changed(agent);
        return {
          status: "reconnected" as const,
          message: "A fresh empty session is ready on the same Chrome profile and site scope. No browser action was performed or replayed. A previous action may already have completed: verify its outcome rather than repeat it. Reopen the desired page with browser_open and take a fresh browser_snapshot before acting. Old tabs and references are not reusable.",
        };
      }),
      keepTab: (mark: "deliverable" | "handoff" = "deliverable") =>
        serialize(async () => {
          await begin();
          if (!t.active || !t.tabs.has(t.active))
            throw new Error("No owned Chrome tab.");
          return this.call(t, "mark", { tab: t.active, mark });
        }),
      action: (
        method: string,
        params: Record<string, unknown> = {},
        signal?: AbortSignal,
      ) =>
        serialize(async () => {
          signal?.throwIfAborted();
          await begin();
          if (
            ![
              "open",
              "name",
              "snapshot",
              "screenshot",
              "click",
              "fill",
              "select",
              "key",
              "wait_for",
              "scroll",
              "tabs",
            ].includes(method)
          )
            throw new Error(
              "Unavailable in Connected Chrome: free typing, coordinates, diagnostics and file artifacts. Use exact snapshot references and scoped input.",
            );
          if (
            method === "click" &&
            (typeof params.ref !== "string" ||
              params.x !== undefined ||
              params.y !== undefined)
          )
            throw new Error(
              "Connected Chrome requires an exact snapshot reference; coordinates are unavailable.",
            );
          if (
            method === "open" ||
            (method === "tabs" && params.operation === "new")
          )
            this.url(t, params.url);
          if (
            method === "tabs" &&
            ["select", "close"].includes(String(params.operation)) &&
            !t.tabs.has(String(params.pageId))
          )
            throw new Error("Stale or foreign Chrome tab capability.");
          const result = (await this.call(
            t,
            method as ChromeMethod,
            { ...params, tab: t.active },
            signal,
          )) as Record<string, unknown>;
          if (!result || typeof result !== "object" || Array.isArray(result))
            throw new Error("Invalid Chrome result.");
          if (typeof result.pageId === "string") {
            t.tabs.add(result.pageId);
            t.active = result.pageId;
          }
          if (method === "tabs" && params.operation === "close") {
            t.tabs.delete(String(params.pageId));
            if (t.active === params.pageId)
              t.active = t.tabs.values().next().value ?? null;
          }
          this.changed(agent);
          return { ...result, humanUsing: this.humanState() } as Record<string, unknown> & { humanUsing: boolean };
        }),
      reserveLogin: (id: string, url: string, signal?: AbortSignal) => {
        assertRun();
        // Bind before queuing, so cancel/Done during a delayed open cannot be
        // overwritten by that operation's late response.
        if (t.handoff) throw new HttpError(409, "A browser sign-in request is already pending.");
        t.handoff = id;
        t.humanUsing = true;
        this.changed(agent);
        return serialize(async () => {
          if (t.handoff !== id) return;
          try {
            await begin();
            this.url(t, url);
            const result = (await this.call(t, "open", { url }, signal)) as { pageId: string };
            t.tabs.add(result.pageId);
            t.active = result.pageId;
            await this.call(t, "mark", { tab: t.active, mark: "handoff" }, signal);
          } catch (error) {
            if (t.handoff === id) this.done(agent, id);
            throw error;
          }
        });
      },
      cancelLogin: (id: string) => {
        if (t.handoff === id) this.done(agent, id);
      },
    };
  }
  private pause(t: Task, signal?: AbortSignal): Promise<void> {
    if (t.pausePending) return t.pausePending;
    ++t.transition;
    t.paused = true;
    t.pauseState = "pausing";
    this.changed(t.agent);
    const pending = this.call(t, "pause", {}, signal)
      .then(() => {
        if (t.lost)
          throw new Error("Chrome disconnected before pause acknowledgement.");
        t.pauseState = "paused";
      })
      .catch((error) => {
        t.pauseState = "failed";
        throw error;
      })
      .finally(() => {
        t.pausePending = null;
        this.changed(t.agent);
      });
    t.pausePending = pending;
    return pending;
  }
  private url(t: Task, value: unknown) {
    const origin = chromeOrigin(value, this.protected);
    if (t.siteScope !== "internet" && !t.origins.includes(origin))
      throw new Error("Website is outside the approved Chrome scope.");
  }
  private async call(
    t: Task,
    method: ChromeMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (t.lost) throw new Error("Chrome session authority expired. Call browser_reconnect; never replay an unconfirmed action.");
    if (!chromeParams(method, params))
      throw new Error(
        "Unavailable Chrome operation parameters; use exact references and bounded inputs.",
      );
    // Removal can arrive before an in-flight open/select response. Never restore
    // a revoked capability from that response; retain tombstones only while pending.
    const removed = new Set<string>();
    t.pendingRemovals.add(removed);
    try {
      const result = await this.bridge.call(
        t.profile,
        t.generation,
        t.id,
        t.run ?? t.authorityRun,
        method,
        params,
        signal,
      );
      if (
        result &&
        typeof result === "object" &&
        "pageId" in result &&
        removed.has(String(result.pageId))
      )
        throw new Error(
          "Chrome tab was closed during the operation. No action was replayed.",
        );
      return result;
    } finally {
      t.pendingRemovals.delete(removed);
    }
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
            connected: !t.lost,
            active: t.active,
            tabs: [...t.tabs],
            handoff: t.handoff,
            origins: t.origins,
            siteScope: t.siteScope,
          }
        : null,
    };
  }
  async pauseForNativeHandoff() {
    await Promise.all([...this.tasks.values()].map(async t => {
      if (t.lost || t.paused) return;
      await this.pause(t);
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
    const tab = pageId ?? t.active;
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
    await this.call(
      t,
      ["deliverable", "handoff"].includes(operation)
        ? "mark"
        : (operation as ChromeMethod),
      ["deliverable", "handoff"].includes(operation)
        ? { tab, mark: operation }
        : operation === "focus"
          ? { tab }
          : {},
    );
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
    const securityPaused = t.paused;
    let retained: string[] = !t.begun && !t.lost ? [...t.tabs] : [];
    try {
      if (t.begun && !t.lost) {
        if (this.humanState() && !securityPaused) {
          // Settlement ends this run; preserve temporary tabs without
          // overwriting explicit deliverable/handoff marks.
          await this.call(t, "pause", {});
        }
        const result = (await this.call(t, "end", {})) as {
          retained?: string[];
        };
        retained = result?.retained?.filter((cap) => t.tabs.has(cap)) ?? [];
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
