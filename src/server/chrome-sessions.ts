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
  paused: boolean; // Authority revoked, not necessarily safe for credential entry.
  pauseState: "active" | "pausing" | "paused" | "resuming" | "failed";
  pausePending: Promise<void> | null;
  resumePending: boolean;
  transition: number;
  preparingLogin: boolean;
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
  private protected: string[] = [];
  private privacyEpoch = 0;
  private desktopPrivate = false;
  get sharingDesktop() { return this.desktopPrivate; }
  assertAutomationAllowed() {
    if (this.desktopPrivate) throw new HttpError(409, "Connected Chrome browser tools paused for a private desktop share. Explicit Return control is required.");
  }
  lockDesktop() {
    this.desktopPrivate = true;
    ++this.privacyEpoch;
    this.bridge.setDesktopPrivate(true);
    for (const t of this.tasks.values()) {
      ++t.transition;
      t.paused = true;
      t.pauseState = "pausing";
      this.changed(t.agent);
    }
  }
  freezeDesktop() { return this.freezeDesktopProfiles(false); }
  /** Cleanup-only: dead tasks cannot ACK and must never regain authority. */
  freezeDesktopForCleanup() { return this.freezeDesktopProfiles(true); }
  private async freezeDesktopProfiles(cleanupOnly: boolean) {
    const epoch = this.privacyEpoch;
    const profiles = this.bridge.profiles();
    const pending = this.bridge.deferredProfiles();
    const bridgeEpoch = this.bridge.desktopEpoch;
    await Promise.all([this.bridge.waitDeferredReady(), ...profiles.map(p => this.bridge.call(p.id, p.generation, "desktop", "desktop", "freeze", {}))]);
    if (!this.desktopPrivate || epoch !== this.privacyEpoch || bridgeEpoch !== this.bridge.desktopEpoch ||
        JSON.stringify(pending) !== JSON.stringify(this.bridge.deferredProfiles()) ||
        JSON.stringify(profiles) !== JSON.stringify(this.bridge.profiles()))
      throw new Error("Chrome profiles changed while draining. Desktop remains paused.");
    for (const t of this.tasks.values()) {
      if (t.lost) {
        if (!cleanupOnly) throw new Error("Chrome task disconnected while draining.");
        t.paused = true;
        continue;
      }
      t.paused = true;
      t.pauseState = "paused";
      this.changed(t.agent);
    }
  }
  async unlockDesktop(allowed: () => boolean = () => true, beforePublish: () => Promise<void> = async () => {}) {
    // A failed unfreeze never opens server admission. No task is resumed here.
    const privacyEpoch = this.privacyEpoch, bridgeEpoch = this.bridge.desktopEpoch;
    const profiles = this.bridge.profiles();
    const valid = () => this.desktopPrivate && privacyEpoch === this.privacyEpoch && bridgeEpoch === this.bridge.desktopEpoch &&
      JSON.stringify(profiles) === JSON.stringify(this.bridge.profiles()) && allowed();
    const requireCurrent = () => { if (!valid()) throw new Error("Desktop handback authority changed. Browser tools remain paused."); };
    requireCurrent();
    await this.bridge.waitDeferredReady();
    requireCurrent();
    await Promise.all(profiles.map(p => this.bridge.call(p.id, p.generation, "desktop", "desktop", "unfreeze", {})));
    requireCurrent();
    await beforePublish();
    requireCurrent();
    this.bridge.publishDeferred(bridgeEpoch);
    this.desktopPrivate = false;
    ++this.privacyEpoch;
    this.bridge.setDesktopPrivate(false);
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
  ) {
    this.assertAutomationAllowed();
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
        paused: false,
        pauseState: "active",
        pausePending: null,
        resumePending: false,
        transition: 0,
        preparingLogin: false,
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
    const serialize = <T>(fn: () => Promise<T>) => {
      const next = t.chain.catch(() => {}).then(fn);
      t.chain = next;
      return next;
    };
    const begin = async () => {
      this.assertAutomationAllowed();
      if (t.lost || t.run !== run)
        throw new Error(
          "Chrome authority expired. Close the session and explicitly reconnect.",
        );
      if (!t.begun) {
        // Record cleanup authority before dispatch; a privacy epoch can revoke
        // the begin result after the extension has already created the task.
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
          t.paused = true;
          t.pauseState = "paused";
          t.tabs = new Set(
            (resumed.tabs ?? []).filter((cap) => t.tabs.has(cap)),
          );
          if (!t.active || !t.tabs.has(t.active))
            t.active = t.tabs.values().next().value ?? null;
        }
        t.authorityRun = run;
        t.begun = true;
      }
      if (t.paused)
        throw new Error(
          "Connected Chrome is paused for private human control. The user can return control in Jelly Settings → Connected Chrome → This agent’s pinned Chrome session → Resume (or the pending Chrome sign-in card). Do not direct them to a managed browser viewer or Computer panel; chat messages cannot resume Chrome.",
        );
    };
    return {
      target: "chrome" as const,
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
          return result;
        }),
      reserveLogin: (id: string, url: string, signal?: AbortSignal) =>
        serialize(async () => {
          t.preparingLogin = true;
          this.changed(agent);
          try {
            await begin();
            this.url(t, url);
            const result = (await this.call(t, "open", { url }, signal)) as {
              pageId: string;
            };
            t.tabs.add(result.pageId);
            t.active = result.pageId;
            await this.call(
              t,
              "mark",
              { tab: t.active, mark: "handoff" },
              signal,
            );
            await this.pause(t, signal);
            t.handoff = id;
          } catch (error) {
            t.paused = true;
            t.pauseState = "failed";
            throw error;
          } finally {
            t.preparingLogin = false;
            this.changed(agent);
          }
        }),
      cancelLogin: (id: string) => {
        if (t.handoff === id) {
          t.handoff = null;
          void this.pause(t).catch(() => {});
          this.changed(agent);
        }
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
    if (t.lost) throw new Error("Chrome session authority expired.");
    if (!chromeParams(method, params))
      throw new Error(
        "Unavailable Chrome operation parameters; use exact references and bounded inputs.",
      );
    const epoch = this.privacyEpoch;
    const automation = !["pause", "end", "focus"].includes(method);
    if (automation) this.assertAutomationAllowed();
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
      if (automation && (epoch !== this.privacyEpoch || this.desktopPrivate))
        throw new Error("Chrome result revoked by private desktop handoff.");
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
      task: t
        ? {
            profile: t.profile,
            paused:
              !t.lost &&
              !t.preparingLogin &&
              !t.resumePending &&
              t.pauseState === "paused",
            pauseState: t.lost
              ? "disconnected"
              : t.preparingLogin
                ? "pausing"
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
  async resumeAfterShare(agent: string) {
    const t = this.tasks.get(agent);
    if (!t || !t.run || !t.begun || t.lost || t.pauseState !== "paused") return null;
    return this.control(agent, "resume");
  }
  async control(agent: string, operation: string, pageId?: string) {
    this.assertAutomationAllowed();
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
        "Start a follow-up browser run, then explicitly resume its retained handoff.",
      );
    if (operation === "pause") {
      await this.pause(t);
      return null;
    }
    if (
      ["focus", "resume"].includes(operation) &&
      (t.lost || t.preparingLogin || t.pauseState !== "paused")
    )
      throw new HttpError(
        409,
        "Chrome pause is not acknowledged. Do not enter credentials yet.",
      );
    const handoff = t.handoff;
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
            "Chrome authority changed during resume. Pause explicitly before entering credentials.",
          );
        t.paused = false;
        t.pauseState = "active";
        t.handoff = null;
        return handoff;
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
    ++t.transition;
    await t.chain.catch(() => {});
    t.paused = true;
    t.pauseState = "pausing";
    this.changed(agent);
    let retained: string[] = !t.begun && !t.lost ? [...t.tabs] : [];
    try {
      if (t.begun && !t.lost) {
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
      t.begun = false;
      if (!retained.length) t.handoff = null;
      t.tabs = new Set(retained);
      t.active = retained[0] ?? null;
      if (!t.lost) {
        t.paused = this.desktopPrivate || retained.length > 0;
        t.pauseState = t.paused ? "paused" : "active";
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
