import { compatibleModel, defaultModelForMode, effortsForModel } from "../shared/models";
import type { ModelId, Effort } from "../shared/models";
import type { AgentSession, FileEntry } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type {
  AgentInput,
  Activity,
  AgentRecord,
  Mode,
  RunRecord,
  Snapshot,
  MessageMode,
  PendingMessage,
} from "../shared/types";
import { Store } from "./store";
import { SubagentStore } from "./subagent-store";
import { thinkingPreview } from "./activity-preview";
import { Harness } from "./harness";
import { HttpError } from "./errors";
export { HttpError } from "./errors";
import { BrowserSessions } from "./browser-sessions";
import { ChromeSessions } from "./chrome-sessions";
import { ChromeShare } from "./chrome-share";
import type { ChromeSelection } from "../shared/chrome-protocol";
import { Interventions } from "./interventions";
import { interventionTools } from "./agent-tools";
import { AppsService } from "./apps";
import { appsTools } from "./apps-tools";
import type { SudoExecutor } from "./sudo";
import { validateDirectory, effectiveCwd } from "./directories";
import { DesktopSessions } from "./desktop-sessions";
import { desktopTools } from "./desktop-tools";
import type { DesktopUIStatus } from "../shared/desktop";
import type { BrowserPort } from "./browser-sessions";

const MAX_RUN_TURNS = 1_000;
const MAX_RUN_DURATION_MS = 5 * 60 * 60 * 1_000;
interface ActiveRun {
  agentId: string;
  thinkingPreview?: string;
  thinkingTimer?: ReturnType<typeof setTimeout>;
  freshSession?: boolean;
  naming?: AbortController;
  session?: AgentSession;
  cancelled: boolean;
  acceptsSteering: boolean;
  steering: Map<Message, PendingMessage>;
  done: Promise<void>;
}

export class JellyService {
  private listeners = new Set<(event: Activity) => void>();
  private active = new Map<string, ActiveRun>();
  private closing = false;
  readonly browsers: BrowserSessions;
  readonly chrome: ChromeSessions;
  readonly chromeShare: ChromeShare;
  readonly interventions: Interventions;
  readonly subagents: SubagentStore;
  readonly apps: AppsService;
  readonly desktop: DesktopSessions;
  private desktopPrivate = false;
  private privateBoundaries = new Set<string>();
  private desktopHandoff: DesktopUIStatus["handoff"] = null;
  constructor(
    readonly store: Store,
    readonly harness: Harness,
    options: {
      sudoExecutor?: SudoExecutor;
      interventionTtlMs?: number;
      allowedOrigins?: string[];
      desktopOptions?: Omit<ConstructorParameters<typeof DesktopSessions>[1], "isRunActive" | "notify" | "canAdmit">;
    } = {},
  ) {
    store.recover();
    this.subagents = new SubagentStore(store.db);
    this.apps = new AppsService(store, {
      dataDir: harness.dataDir,
      allowedOrigins: options.allowedOrigins,
      emit: (type: string, data: Record<string, unknown>) => this.emit(null, null, type, data),
    });
    this.chrome = new ChromeSessions(harness.dataDir, store.instance().id, id => {
      this.emit(id, null, "chrome_changed", {});
    });
    this.chromeShare = new ChromeShare(this.chrome, harness.dataDir, async () => {
      if (this.desktopHandoff) throw new HttpError(409, "Return the existing desktop handoff first.");
      await this.pauseDesktopForPrivacy("chrome-share");
    }, () => this.emit(null, null, "chrome_changed", {}));
    this.chromeShare.onDone = async handoffs => {
      for (const { agent, id } of handoffs) {
        if (this.chrome.state(agent).task?.handoff !== id) continue;
        if (this.store.intervention(id)?.status === "pending") await this.completeBrowserControl(agent, id);
        else { this.chrome.done(agent, id); await this.finishBrowserPrivacy(agent); }
      }
    };
    this.browsers = new BrowserSessions(this.chrome);
    this.desktop = new DesktopSessions(harness.dataDir, {
      ...options.desktopOptions,
      isRunActive: (agentId, runId) => {
        const state = this.active.get(runId);
        return !this.closing && state?.agentId === agentId && !state.cancelled;
      },
      canAdmit: () => !this.desktopPrivate && !this.desktopHandoff && !this.browserPrivate(),
      notify: () => { this.chromeShare.checkPrivacy(); this.emit(null, null, "desktop_changed", {}); },
    });
    this.chromeShare.privacyValid = () => this.desktop.status().privateSafe;
    this.interventions = new Interventions(
      store,
      (agentId, runId, type, data) => {
        if (store.run(runId)?.status === "running")
          store.setStatus(
            agentId,
            type === "intervention_requested" ? "waiting" : "running",
          );
        this.emit(agentId, runId, type, data);
      },
      options.sudoExecutor,
      options.interventionTtlMs,
    );
    if (!store.agents().length)
      this.createAgent({
        name: "Jelly",
        instructions:
          "Be thoughtful, practical, and concise. Help me turn ideas into useful work.",
        color: "#b5bafc",
      });
  }
  private browserPrivate(agentId?: string) {
    // Native Mac desktop privacy remains exclusive, including uncertain viewer
    // cleanup. This guard is never used to admit browser operations.
    return this.chromeShare.state().status !== "idle" || this.chrome.humanState() ||
      this.store.agents().filter(agent => !agentId || agent.id === agentId).some(agent => {
        const task = this.chrome.state(agent.id).task;
        return !!task && (task.pauseState !== "active" || !!task.handoff);
      });
  }
  chromeStatus(agentId?: string) {
    return { ...this.chrome.state(agentId),
      selectedProfile: this.store.browserSelection().chromeProfile,
      desktopShared: this.chromeShare.state().status !== "idle" };
  }
  async completeBrowserControl(agent: string, handoff: string | null) {
    const request = handoff ? this.store.intervention(handoff) : null;
    if (handoff && (!request || request.agentId !== agent || request.kind !== "browser_login" || request.status !== "pending"))
      throw new HttpError(409, "This browser request is no longer current.");
    if (this.chrome.state(agent).task) this.chrome.done(agent, handoff);
    if (request) {
      if (Date.parse(request.expiresAt) <= Date.now()) this.interventions.cancel(request.id, "expired");
      else this.interventions.completeLogin(request.id);
    }
    await this.finishBrowserPrivacy(agent);
  }
  desktopStatus(): DesktopUIStatus {
    const handoff = this.desktopHandoff;
    const pending = handoff && this.store.intervention(handoff.id)?.status === "pending";
    return {
      ...this.desktop.status(),
      handoff: handoff && pending ? { ...handoff, safe: handoff.safe && this.desktop.status().privateSafe } : null,
      browserPrivate: this.browserPrivate(),
    };
  }
  async pauseDesktopForPrivacy(boundary = "desktop-manual") {
    this.privateBoundaries.add(boundary);
    // Revoke before the first await. Explicit handback can reopen configuration
    // admission, but desktop input always needs a separate explicit resume.
    this.desktopPrivate = true;
    const state = await this.desktop.pauseForPrivacy();
    if (!state.privateSafe)
      throw new HttpError(409, "Desktop work has not safely drained. Do not enter credentials.");
  }
  private scopedBrowser(agentId: string, runId: string, selection: ChromeSelection, name: string) {
    const guard = () => {
      if (this.desktopHandoff) throw new Error("Browser automation is paused for private desktop control. Explicit desktop handback is required.");
    };
    const scoped = this.browsers.forRun(agentId, runId, selection, name, () => {
      guard();
      const active = this.active.get(runId);
      if (this.closing || active?.agentId !== agentId || active.cancelled)
        throw new Error("Browser reconnect requires this agent's current active run.");
    });
    let port: BrowserPort | undefined;
    return {
      target: scoped.target,
      get: (id: string): BrowserPort => {
        if (port && id === agentId) return port;
        const browser = scoped.get(id);
        port = {
          ...browser,
          action: (method, params, signal) => { guard(); return browser.action(method, params, signal); },
          reserveLogin: async (handoff, url, signal) => {
            guard();
            await this.pauseDesktopForPrivacy(`browser:${agentId}`);
            signal?.throwIfAborted();
            return browser.reserveLogin(handoff, url, signal);
          },
          keepTab: browser.keepTab ? async mark => { guard(); return browser.keepTab!(mark); } : undefined,
        };
        return port;
      },
    };
  }
  async requestDesktopHandoff(agentId: string, runId: string, reason: string, signal?: AbortSignal) {
    if (this.active.get(runId)?.agentId !== agentId || this.active.get(runId)?.cancelled)
      throw new HttpError(409, "Desktop run authority expired.");
    if (this.desktopHandoff) throw new HttpError(409, "A private desktop handoff is already reserved.");
    if (this.browserPrivate()) throw new HttpError(409, "Finish the existing private browser handoff first.");
    signal?.throwIfAborted();
    this.desktopPrivate = true;
    const pending = this.interventions.request("desktop_handoff", agentId, runId, { reason }, signal);
    this.desktopHandoff = { id: pending.request.id, agentId, runId, safe: false };
    void pending.promise.catch(() => {});
    try {
      await this.pauseDesktopForPrivacy(`desktop-handoff:${pending.request.id}`);
      await this.chrome.pauseForNativeHandoff();
      signal?.throwIfAborted();
      if (this.desktopHandoff?.id !== pending.request.id ||
          this.store.intervention(pending.request.id)?.status !== "pending")
        throw new HttpError(409, "Desktop handoff expired or was revoked.");
      this.desktopHandoff.safe = true;
      this.emit(null, null, "desktop_changed", {});
      return await pending.promise;
    } catch (error) {
      this.interventions.cancel(pending.request.id);
      // Preserve the latch even if the card expires or the run stops.
      throw error;
    }
  }
  async resumeDesktop(agentId: string, runId: string, handoffId?: string) {
    const active = this.active.get(runId);
    if (active?.agentId !== agentId || active.cancelled)
      throw new HttpError(409, "Start a current desktop run before explicitly resuming.");
    const handoff = this.desktopHandoff;
    if (handoff && this.store.intervention(handoff.id)?.status === "pending" &&
        (!handoff.safe || handoff.id !== handoffId || handoff.agentId !== agentId || handoff.runId !== runId))
      throw new HttpError(409, "A matching, safely drained desktop handoff is required.");
    if (handoff && handoff.safe && handoff.id === handoffId && this.store.intervention(handoff.id)?.status === "pending") {
      // Explicit native handback clears only pauses created by this handoff.
      await this.chrome.finishNativeHandoff();
      this.privateBoundaries.delete(`desktop-handoff:${handoff.id}`);
      if (!this.privateBoundaries.size && !this.browserPrivate()) {
        await this.desktop.releasePrivateControl();
        this.desktopPrivate = false;
      }
      this.desktopHandoff = null;
      this.interventions.completeDesktopHandoff(handoff.id);
      this.emit(null, null, "desktop_changed", {});
      return this.desktopStatus();
    }
    if (this.browserPrivate())
      throw new HttpError(409, "Return all private browser sessions first. Desktop control remains paused.");
    this.desktopPrivate = false;
    this.desktopHandoff = null;
    // Explicit desktop resume is the standalone native private-work handback.
    // Live private browser sessions were rejected above; cancelled boundaries
    // never reach here without this explicit operator action.
    this.privateBoundaries.clear();
    try {
      await this.desktop.releasePrivateControl();
      await this.desktop.resume(agentId, runId);
      await this.chrome.finishNativeHandoff();
      if (handoff && this.store.intervention(handoff.id)?.status === "pending")
        this.interventions.completeDesktopHandoff(handoff.id);
    } catch (error) {
      this.desktopPrivate = true;
      this.desktopHandoff = handoff;
      await this.desktop.pauseForPrivacy();
      throw error;
    }
    return this.desktopStatus();
  }
  assertBrowserHandbackAllowed() {
    if (this.desktopHandoff && this.store.intervention(this.desktopHandoff.id)?.status === "pending")
      throw new HttpError(409, "Private desktop control is reserved. Return desktop control first.");
  }
  async finishBrowserPrivacy(agentId: string) {
    const task = this.chrome.state(agentId).task;
    if (!task?.humanUsing && !task?.handoff) this.privateBoundaries.delete(`browser:${agentId}`);
    if (!this.privateBoundaries.size && !this.browserPrivate() && !this.desktopHandoff) {
      await this.desktop.releasePrivateControl();
      this.desktopPrivate = false;
    }
    // Explicit browser handback never resumes desktop automation.
  }
  async finishDesktopPrivacy() {
    if (this.desktopHandoff && this.store.intervention(this.desktopHandoff.id)?.status === "pending")
      throw new HttpError(409, "Return the matching desktop handoff card first.");
    if (this.chromeShare.state().status === "idle") this.privateBoundaries.delete("chrome-share");
    this.privateBoundaries.delete("desktop-manual");
    for (const boundary of this.privateBoundaries)
      if (boundary.startsWith("desktop-handoff:") &&
          this.store.intervention(boundary.slice("desktop-handoff:".length))?.status !== "pending")
        this.privateBoundaries.delete(boundary);
    if (this.desktopHandoff && this.store.intervention(this.desktopHandoff.id)?.status !== "pending")
      this.desktopHandoff = null;
    if (!this.privateBoundaries.size && !this.browserPrivate()) {
      await this.desktop.releasePrivateControl();
      this.desktopPrivate = false;
    }
    return this.desktopStatus();
  }
  subscribe(listener: (event: Activity) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify(event: Activity) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }
  emit(
    agentId: string | null,
    runId: string | null,
    type: string,
    data: Record<string, unknown>,
  ) {
    const event = this.store.event(agentId, runId, type, data);
    this.notify(event);
    return event;
  }
  snapshot(agentId?: string | null): Snapshot {
    const agents = this.store.agents(false);
    const selected =
      agentId === null
        ? undefined
        : agentId
          ? this.store.agent(agentId)
          : agents[0];
    if (selected?.archivedAt) agents.push(selected);
    if (agentId && !selected) throw new HttpError(404, "Agent not found.");
    const instance = this.store.instance();
    const page = selected
      ? this.store.historyPage(selected.id)
      : { events: [], runs: [], interventions: [], before: null };
    const agentActivity = this.store.agentActivity();
    for (const state of this.active.values()) {
      if (state.thinkingPreview && agents.some(a => a.id === state.agentId && a.status === "running" && !a.archivedAt))
        agentActivity[state.agentId] = state.thinkingPreview;
    }
    return {
      agentNotifications: this.store.agentNotifications(),
      latestAssistantMessages: this.store.latestAssistantMessages(),
      agentPreviews: this.store.agentPreviews(),
      agentActivity,
      pendingMessages: selected ? this.store.pendingMessages(selected.id) : [],
      instance: { id: instance.id, name: instance.name },
      agents,
      projects: this.store.projects(),
      selectedAgentId: selected?.id ?? null,
      events: page.events,
      runs: page.runs,
      historyBefore: page.before,
      cursor: this.store.cursor(),
      config: { ...this.harness.config(instance.mode, instance), ...this.store.browserSelection() },
      agentConfig: selected ? this.agentConfig(selected) : undefined,
      interventions: page.interventions,
    };
  }
  createAgent(input: AgentInput) {
    let event: Activity;
    const agent = this.store.db.transaction(() => {
      if (input.projectId) {
        const project = this.store.project(input.projectId);
        if (!project) throw new HttpError(404, "Project not found.");
        validateDirectory(project.defaultCwd);
      }
      const agent = this.store.addAgent(input);
      event = this.store.event(agent.id, null, "agent_created", { agent });
      return agent;
    })();
    this.notify(event!);
    return agent;
  }
  updateAgent(id: string, input: AgentInput) {
    const existing = this.store.agent(id);
    if (!existing) throw new HttpError(404, "Agent not found.");
    if (["running", "waiting"].includes(existing.status))
      throw new HttpError(
        409,
        "Wait for this agent to finish before editing its profile.",
      );
    let event: Activity;
    const agent = this.store.db.transaction(() => {
      const agent = this.store.updateAgent(id, input);
      event = this.store.event(id, null, "agent_updated", { agent });
      return agent;
    })();
    this.notify(event!);
    return agent;
  }
  saveProject(id: string | null, input: Record<string, unknown>) {
    const existing = id ? this.store.project(id) : null;
    if (id && !existing) throw new HttpError(404, "Project not found.");
    const rawName = input.name ?? existing?.name;
    if (
      typeof rawName !== "string" ||
      !rawName.trim() ||
      rawName.trim().length > 60
    )
      throw new HttpError(
        400,
        "Project name must be between 1 and 60 characters.",
      );
    const name = rawName.trim().normalize("NFKC");
    const key = name.toLowerCase();
    if (name.length > 60)
      throw new HttpError(400, "Project name must be at most 60 characters.");
    if (["all agents", "ungrouped"].includes(key))
      throw new HttpError(400, "Choose a different project name.");
    const cwd = validateDirectory(input.defaultCwd ?? existing?.defaultCwd);
    let event: Activity;
    const result = this.store.db.transaction(() => {
      if (
        this.store
          .projects()
          .some(
            (p) =>
              p.id !== id && p.name.normalize("NFKC").toLowerCase() === key,
          )
      )
        throw new HttpError(409, "A project with this name already exists.");
      const project = this.store.saveProject(
        id ?? crypto.randomUUID(),
        name,
        key,
        cwd,
      );
      event = this.store.event(
        null,
        null,
        id ? "project_updated" : "project_created",
        { project },
      );
      return project;
    })();
    this.notify(event!);
    return result;
  }
  deleteProject(id: string) {
    if (!this.store.project(id)) throw new HttpError(404, "Project not found.");
    const event = this.store.db.transaction(() => {
      this.store.deleteProject(id);
      return this.store.event(null, null, "project_deleted", { projectId: id });
    })();
    this.notify(event);
    return { ok: true };
  }
  moveAgent(id: string, projectId: unknown) {
    if (projectId !== null && (typeof projectId !== "string" || !projectId))
      throw new HttpError(400, "Choose a project or Ungrouped.");
    if (!this.store.agent(id)) throw new HttpError(404, "Agent not found.");
    if (projectId && !this.store.project(projectId))
      throw new HttpError(404, "Project not found.");
    let event: Activity;
    const agent = this.store.db.transaction(() => {
      const agent = this.store.moveAgent(id, projectId as string | null);
      event = this.store.event(id, null, "agent_project_changed", { agent });
      return agent;
    })();
    this.notify(event!);
    return agent;
  }
  archiveAgent(id: string, archived: boolean) {
    const existing = this.store.agent(id);
    if (!existing) throw new HttpError(404, "Agent not found.");
    // Synchronous check and write: archive cannot interleave with accepting a run.
    if (
      ["running", "waiting"].includes(existing.status) ||
      [...this.active.keys()].some(
        (runId) => this.store.run(runId)?.agentId === id,
      )
    )
      throw new HttpError(
        409,
        "Stop this agent or wait for it to finish before archiving.",
      );
    if (!!existing.archivedAt === archived) return existing;
    let event: Activity;
    const agent = this.store.db.transaction(() => {
      const agent = this.store.archiveAgent(id, archived);
      event = this.store.event(
        id,
        null,
        archived ? "agent_archived" : "agent_restored",
        { agent },
      );
      return agent;
    })();
    this.notify(event!);
    return agent;
  }
  historyPage(id: string, before?: number) {
    if (!this.store.agent(id)) throw new HttpError(404, "Agent not found.");
    return this.store.historyPage(id, before);
  }
  private agentConfig(agent: AgentRecord) {
    const config = this.harness.config(agent.mode ?? "auto", agent);
    if (agent.providerLocked && (!agent.mode || agent.mode === "auto"))
      return { ...config, ready: false, activeMode: null, notice: "This legacy agent’s provider could not be identified. Create a new agent; its historical session will not be retargeted." };
    if (!compatibleModel(agent.mode ?? "auto", agent.model) || !effortsForModel(agent.model).some(option => option.id === agent.effort))
      return { ...config, ready: false, notice: "This agent’s model or effort is incompatible with its provider. Choose supported settings in the model panel." };
    return config;
  }
  setMode(mode: Mode) {
    return this.setConfig({ mode });
  }
  setConfig(input: { agentId?: string; mode?: Mode; model?: ModelId; effort?: Effort } & Partial<ChromeSelection>) {
    const chromeChanges = Object.fromEntries(Object.entries(input).filter(([key, value]) => ["chromeProfile", "chromeOrigins", "chromeSiteScope"].includes(key) && value !== undefined));
    const selection = { ...this.store.browserSelection(), ...chromeChanges };
    // Connection/model settings remain usable before Chrome has been configured.
    if (Object.keys(chromeChanges).length) {
      if (input.agentId !== undefined) throw new HttpError(400, "Chrome settings are global.");
      this.chrome.validate(selection);
    }
    if (input.mode !== undefined && !["auto", "chatgpt", "api", "claude-code"].includes(input.mode))
      throw new HttpError(400, "Unknown connection mode.");
    const current = this.store.instance();
    const agent = input.agentId !== undefined ? this.store.agent(input.agentId) : null;
    if (input.agentId !== undefined && !agent)
      throw new HttpError(404, "Agent not found.");
    const switching = input.mode !== undefined || input.model !== undefined || input.effort !== undefined;
    const baseline = agent ?? current;
    const mode = input.mode ?? baseline.mode ?? "auto";
    if (agent?.providerLocked && mode !== agent.mode)
      throw new HttpError(409, "This agent’s provider is locked. Create a new agent to use another provider; Fresh Session retains context and provider.");
    const next = {
      mode,
      model: input.model ?? (compatibleModel(mode, baseline.model) ? baseline.model : defaultModelForMode(mode)),
      effort: input.effort ?? baseline.effort,
    };
    if (!compatibleModel(next.mode, next.model)) throw new HttpError(400, "Model is not supported by this provider.");
    if (!effortsForModel(next.model).some(option => option.id === next.effort))
      throw new HttpError(400, "Reasoning effort is not supported by this model.");
    const event = this.store.db.transaction(() => {
      this.store.setConfig(next.mode, next.model, next.effort);
      this.store.setBrowserSelection(selection);
      if (agent && switching) this.store.setAgentConfig(agent.id, next.model, next.effort, next.mode);
      return this.store.event(null, null, "config_changed", { ...next, agentId: agent?.id ?? null });
    })();
    this.notify(event);
    return { ...this.harness.config(next.mode, next), ...selection };
  }
  freshSession(agentId: string, requestId: string) {
    if (this.closing) throw new HttpError(503, "Jelly is shutting down.");
    const prior = this.store.byRequest(`fresh-session:${requestId}`);
    if (prior) {
      if (prior.agentId !== agentId || prior.prompt !== "Fresh Session")
        throw new HttpError(409, "This request ID was already used for another action.");
      return { run: this.store.run(prior.id)!, reused: true };
    }
    const agent = this.store.agent(agentId);
    if (!agent) throw new HttpError(404, "Agent not found.");
    if (agent.archivedAt) throw new HttpError(409, "Restore this agent before starting a fresh session.");
    if (this.activeFor(agentId)) throw new HttpError(409, "Wait for this agent to finish before starting a fresh session.");
    this.harness.requireConnection(this.agentConfig(agent));
    return this.startRun(agent, `fresh-session:${requestId}`, "Fresh Session", "queue", true);
  }
  start(
    agentId: string,
    requestId: string,
    prompt: string,
    mode: MessageMode = "queue",
  ) {
    if (this.closing) throw new HttpError(503, "Jelly is shutting down.");
    if (mode !== "queue" && mode !== "steer")
      throw new HttpError(400, "Message mode must be queue or steer.");
    const existing = this.store.pendingMessage(requestId);
    if (existing) {
      if (existing.agentId !== agentId || existing.text !== prompt)
        throw new HttpError(
          409,
          "This request ID was already used for another message.",
        );
      return {
        message: existing,
        run: existing.runId ? this.store.run(existing.runId) : null,
        reused: true,
      };
    }
    const prior = this.store.byRequest(requestId);
    if (prior) {
      if (prior.agentId !== agentId || prior.prompt !== prompt)
        throw new HttpError(
          409,
          "This request ID was already used for another message.",
        );
      return { run: this.store.run(prior.id)!, reused: true };
    }
    const agent = this.store.agent(agentId);
    if (!agent) throw new HttpError(404, "Agent not found.");
    if (agent.archivedAt)
      throw new HttpError(409, "Restore this agent before sending a message.");
    this.harness.requireConnection(this.agentConfig(agent));
    const active = this.activeFor(agentId);
    if (active?.cancelled)
      throw new HttpError(
        409,
        "This agent is stopping. Wait for it to stop before sending a message.",
      );
    if (active?.freshSession && mode === "steer")
      throw new HttpError(409, "Fresh Session is in progress. Queue the message instead.");
    if (active) {
      let event: Activity;
      const message = this.store.db.transaction(() => {
        const message = this.store.enqueueMessage(
          requestId,
          agentId,
          prompt,
          mode,
        );
        event = this.store.event(agentId, null, "message_pending", {
          messageId: message.id,
          mode,
        });
        return message;
      })();
      this.notify(event!);
      if (mode === "steer") this.injectSteering(active, message);
      return { message, run: null, reused: false };
    }
    return this.startRun(agent, requestId, prompt, mode);
  }
  private activeFor(agentId: string) {
    return [...this.active].find(
      ([id]) => this.store.run(id)?.agentId === agentId,
    )?.[1];
  }
  steer(agentId: string, messageId: string) {
    if (this.closing) throw new HttpError(503, "Jelly is shutting down.");
    const agent = this.store.agent(agentId);
    if (!agent) throw new HttpError(404, "Agent not found.");
    this.harness.requireConnection(this.agentConfig(agent));
    const message = this.store.pendingMessage(messageId);
    if (!message || message.agentId !== agentId)
      throw new HttpError(404, "Message not found.");
    if (message.mode === "steer" && message.status !== "cancelled")
      return message;
    if (message.status !== "pending")
      throw new HttpError(409, "This message is no longer queued.");
    const active = this.activeFor(agentId);
    if (!active || active.cancelled || active.freshSession)
      throw new HttpError(
        409,
        "This agent is no longer accepting steering messages.",
      );
    const event = this.store.db.transaction(() => {
      this.store.db
        .query("UPDATE pending_messages SET mode='steer' WHERE id=?")
        .run(messageId);
      return this.store.event(agentId, null, "message_pending", {
        messageId,
        mode: "steer",
      });
    })();
    message.mode = "steer";
    this.notify(event);
    this.injectSteering(active, message);
    return message;
  }
  private injectSteering(state: ActiveRun, pending: PendingMessage) {
    if (!state.session || !state.acceptsSteering || state.cancelled) return;
    const message: Message = {
      role: "user",
      content: pending.text,
      timestamp: Date.now(),
    };
    state.steering.set(message, pending);
    state.session.agent.steer(message);
    this.harness.wakeSteering(state.session);
  }
  private startRun(
    agent: AgentRecord,
    requestId: string,
    prompt: string,
    mode: MessageMode = "queue",
    freshSession = false,
  ) {
    const agentId = agent.id;
    const instance = this.store.instance();
    const config = this.agentConfig(agent);
    const browserSelection = this.store.browserSelection();
    this.harness.requireConnection(config);
    const events: Activity[] = [];
    let nameAgent = false;
    const run = this.store.db.transaction(() => {
      if (!freshSession) nameAgent = this.store.claimAgentName(agentId);
      if (!freshSession && !this.store.pendingMessage(requestId))
        this.store.enqueueMessage(requestId, agentId, prompt, mode);
      const run = this.store.createRun(
        agentId,
        requestId,
        prompt,
        config.activeMode!,
        config.model,
      );
      this.store.setStatus(agentId, "running");
      if (!freshSession) {
        this.store.deliverMessage(requestId, run.id);
        this.store.saveMessage(agentId, run.id, {
          role: "user",
          content: prompt,
          timestamp: Date.now(),
        });
        events.push(
          this.store.event(agentId, run.id, "message", {
            role: "user",
            text: prompt,
            messageId: requestId,
            mode: this.store.pendingMessage(requestId)?.mode ?? "queue",
          }),
        );
      }
      events.push(
        this.store.event(agentId, run.id, "run_started", {
          operation: freshSession ? "fresh_session" : "message",
          mode: config.activeMode,
          model: config.model,
          selectedModel: config.selectedModel,
          effort: config.effort,
          status: "running",
        }),
      );
      return run;
    })();
    const state: ActiveRun = {
      agentId,
      freshSession,
      cancelled: false,
      acceptsSteering: false,
      steering: new Map(),
      done: Promise.resolve(),
    };
    this.active.set(run.id, state);
    for (const event of events) this.notify(event);
    state.done = (async () => {
      let failure: string | null = null;
      let turns = 0;
      let modelFailure: string | null = null;
      let checkpoint: FileEntry[] | undefined;
      let compacted = false;
      let stopping: Promise<void> | undefined;
      const deadline = setTimeout(() => {
        failure ??=
          "The run reached the 5-hour limit. Send a new message to continue.";
        state.naming?.abort();
        if (state.session)
          stopping = this.harness.stop(state.session).catch(() => {});
      }, MAX_RUN_DURATION_MS);
      try {
        if (nameAgent) {
          state.naming = new AbortController();
          let name: string | null = null;
          try { name = await this.harness.generateAgentName(prompt, config, state.naming.signal); }
          catch { /* Naming is best-effort; never fail or replay the user's task. */ }
          state.naming = undefined;
          if (state.cancelled || failure) return;
          if (name) {
            const event = this.store.db.transaction(() => {
              const renamed = this.store.applyAgentName(agentId, name!);
              return renamed ? this.store.event(agentId, null, "agent_updated", { agent: renamed }) : null;
            })();
            if (event) this.notify(event);
          }
          agent = this.store.agent(agentId)!;
        }
        if (state.cancelled || failure) return;
        const context = this.store.context(agentId);
        const session = await this.harness.create(
          agent,
          context ? [] : this.store.history(agentId),
          config,
          instance,
          [
            ...interventionTools(
              this.scopedBrowser(agentId, run.id, browserSelection, agent.name),
              this.interventions,
              agentId,
              run.id,
              effectiveCwd(agent),
              () => this.pauseDesktopForPrivacy(`browser:${agentId}`),
            ),
            ...desktopTools(this.desktop, agentId, run.id,
              (reason, signal) => this.requestDesktopHandoff(agentId, run.id, reason, signal)),
            ...appsTools(this.apps, agent),
          ],
          (type, data) => this.emit(agentId, run.id, type, data),
          context,
          (snapshot, sources) => this.subagents.save(agentId, run.id, snapshot, sources),
          this.apps,
        );
        state.session = session;
        if (state.cancelled || failure) return;
        session.subscribe((event) => {
          if (event.type === "compaction_start") {
            this.desktop.invalidateRun(agentId, run.id);
            this.emit(agentId, run.id, "compaction_started", {
              reason: event.reason,
            });
          }
          if (event.type === "compaction_end")
            this.emit(agentId, run.id, "compaction_completed", {
              reason: event.reason,
              success: !!event.result,
              aborted: event.aborted,
              tokensBefore: event.result?.tokensBefore,
              tokensAfter: event.result?.estimatedTokensAfter,
              error: event.errorMessage,
            });
        });
        if (freshSession) {
          const result = await this.harness.freshCheckpoint(session);
          checkpoint = result.entries;
          compacted = result.compacted;
          return;
        }
        const updateThinking = (text: string) => {
          const line = thinkingPreview(text);
          if (!line || line === state.thinkingPreview) return;
          state.thinkingPreview = line;
          // Stream a bounded preview without writing every delta to the transcript.
          if (!state.thinkingTimer) state.thinkingTimer = setTimeout(() => {
            state.thinkingTimer = undefined;
            this.emit(null, run.id, "agent_activity", { agentId });
          }, 250);
        };
        // Subscribe to the awaited Pi core lifecycle so each boundary is durable before execution proceeds.
        session.agent.subscribe((event) => {
          if (event.type === "message_update" && event.message.role === "assistant") {
            const update = event.assistantMessageEvent;
            if (update.type === "thinking_delta" || update.type === "thinking_end") {
              const block = update.partial.content[update.contentIndex];
              if (block?.type === "thinking" && !block.redacted) updateThinking(block.thinking);
            }
          } else if (event.type === "message_start" && event.message.role === "user") {
            const pending = state.steering.get(event.message);
            if (pending) {
              const saved = this.store.db.transaction(() => {
                this.store.deliverMessage(pending.id, run.id);
                this.store.saveMessage(
                  agentId,
                  run.id,
                  event.message as Message,
                );
                return this.store.event(agentId, run.id, "message", {
                  role: "user",
                  text: pending.text,
                  messageId: pending.id,
                  mode: "steer",
                });
              })();
              state.steering.delete(event.message);
              this.notify(saved);
            }
          } else if (
            event.type === "message_end" &&
            event.message.role !== "user"
          ) {
            const message = event.message as Message;
            const text =
              typeof message.content === "string"
                ? message.content
                : message.content
                    .filter((c) => c.type === "text")
                    .map((c) => c.text)
                    .join("\n");
            const saved: Activity[] = [];
            this.store.db.transaction(() => {
              this.store.saveMessage(agentId, run.id, message);
              if (message.role === "assistant") {
                // Only the provider's displayable thinking text belongs in the UI.
                // Never project redacted blocks or opaque reasoning signatures.
                const thinking = message.content
                  .filter((block) => block.type === "thinking" && !block.redacted)
                  .map((block) => block.type === "thinking" ? block.thinking : "")
                  .filter((value) => value.trim())
                  .join("\n\n");
                if (thinking) {
                  updateThinking(thinking);
                  saved.push(this.store.event(agentId, run.id, "thinking", { text: thinking }));
                }
                if (text)
                  saved.push(this.store.event(agentId, run.id, "message", {
                    role: "assistant",
                    text,
                  }));
              }
            })();
            for (const activity of saved) this.notify(activity);
            if (message.role === "assistant")
              modelFailure = ["error", "aborted"].includes(message.stopReason)
                ? message.errorMessage ||
                  "The model could not complete this turn."
                : null;
          } else if (event.type === "tool_execution_start") {
            this.emit(agentId, run.id, "tool_started", {
              toolCallId: event.toolCallId,
              name: event.toolName,
              args: event.args,
            });
          } else if (event.type === "tool_execution_end") {
            this.emit(agentId, run.id, "tool_completed", {
              toolCallId: event.toolCallId,
              name: event.toolName,
              result: event.result,
              isError: event.isError,
            });
          } else if (event.type === "turn_end") {
            this.emit(agentId, run.id, "turn_completed", { turn: ++turns });
            if (turns >= MAX_RUN_TURNS) {
              failure ??=
                "The run reached the 1,000-turn limit. Send a new message to continue.";
              session.agent.abort();
              stopping ??= this.harness.stop(session).catch(() => {});
            }
          }
        });
        state.acceptsSteering = true;
        for (const pending of this.store.pendingMessages(agentId))
          if (pending.mode === "steer") this.injectSteering(state, pending);
        try {
          await session.prompt(prompt, { expandPromptTemplates: false });
          // The parent remains interactive while children are running and
          // native completion/heartbeat turns arrive in this same Pi session.
          await this.harness.settle(session);
        } finally {
          state.acceptsSteering = false;
        }
        failure ??= modelFailure;
        // Pi may recover an overflow internally. Judge the final projected answer,
        // not an earlier failed attempt that compaction removed from context.
        const last = session.sessionManager
          .buildSessionContext()
          .messages.slice()
          .reverse()
          .find((message) => message.role === "assistant");
        if (
          last?.role === "assistant" &&
          ["error", "aborted"].includes(last.stopReason)
        )
          failure ??=
            last.errorMessage || "The model could not complete this turn.";
        if (!failure && !state.cancelled)
          checkpoint = this.harness.checkpoint(session);
      } catch (error) {
        failure ??= error instanceof Error ? error.message : "The run failed.";
      } finally {
        state.acceptsSteering = false;
        clearTimeout(state.thinkingTimer);
        clearTimeout(deadline);
        await stopping;
        if (state.session)
          try {
            await this.harness.dispose(state.session, !freshSession && !failure && !state.cancelled);
          } catch (error) {
            failure ??=
              error instanceof Error
                ? error.message
                : "Could not stop subagent work";
          }
        try { await this.chrome.settle(agentId, run.id); }
        catch { failure ??= "Chrome cleanup could not be confirmed."; }
        try { await this.desktop.settle(agentId, run.id); }
        catch { failure ??= "Desktop cleanup is unconfirmed. Automation remains blocked; no input was replayed."; }
        const status: RunRecord["status"] = state.cancelled
          ? "cancelled"
          : failure
            ? "failed"
            : "completed";
        let event: Activity;
        let freshEvent: Activity | undefined;
        this.store.db.transaction(() => {
          this.store.finishRun(run.id, status, failure);
          if (status === "completed" && checkpoint) {
            this.store.saveContext(agentId, run.id, checkpoint);
            if (freshSession)
              freshEvent = this.store.event(agentId, run.id, "session_started", {
                sessionId: checkpoint[0]!.id, compacted,
              });
          }
          this.store.setStatus(agentId, status === "failed" ? "error" : "idle");
          event = this.store.event(agentId, run.id, `run_${status}`, {
            status,
            error: failure,
          });
        })();
        if (freshEvent) this.notify(freshEvent);
        this.notify(event!);
        this.active.delete(run.id);
        if (status === "completed" && !this.closing) {
          const next = this.store.pendingMessages(agentId)[0];
          if (next) {
            try {
              this.startRun(this.store.agent(agentId)!, next.id, next.text);
            } catch (error) {
              const reason = `Not sent: ${error instanceof Error ? error.message : "Could not start the next run."}`;
              for (const event of this.store.db.transaction(() =>
                this.store.cancelPendingMessages(agentId, reason),
              )()) this.notify(event);
            }
          }
        } else {
          const reason =
            status === "failed"
              ? "Not sent: the previous run failed. Send this message again to continue."
              : "Not sent: the agent was stopped. Send this message again to continue.";
          for (const event of this.store.db.transaction(() =>
            this.store.cancelPendingMessages(agentId, reason),
          )())
            this.notify(event);
        }
      }
    })();
    return {
      run,
      message: this.store.pendingMessage(requestId)!,
      reused: false,
    };
  }
  async stop(agentId: string) {
    if (!this.store.agent(agentId))
      throw new HttpError(404, "Agent not found.");
    for (const [id, state] of this.active)
      if (this.store.run(id)?.agentId === agentId) {
        state.cancelled = true;
        state.naming?.abort();
        if (state.session) await this.harness.stop(state.session);
        await state.done;
        return;
      }
  }
  async settled() {
    while (this.active.size) {
      const outcomes = await Promise.allSettled(
        [...this.active.values()].map((state) => state.done),
      );
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
  }
  async close() {
    this.closing = true;
    const states = [...this.active.values()];
    for (const state of states) { state.cancelled = true; state.naming?.abort(); }
    const outcomes = await Promise.allSettled([
      this.interventions.close(),
      ...states.map((state) =>
        state.session ? this.harness.stop(state.session) : Promise.resolve(),
      ),
    ]);
    // Even if a stop handler fails, wait for every run before giving up ownership.
    const settled = await Promise.allSettled([this.settled()]);
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => this.desktop.close()),
      Promise.resolve().then(async () => {
        try { await this.chromeShare.close(); }
        finally { await this.chrome.close(); }
      }),
    ]);
    this.harness.chatgptTransport.close();
    this.store.close();
    const failure = [...outcomes, ...settled, ...cleanup].find(
      (outcome) => outcome.status === "rejected",
    );
    if (failure?.status === "rejected") throw failure.reason;
  }
}
