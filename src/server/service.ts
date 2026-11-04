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
import { Goals, goalPrompt } from "./goals";
import { goalExtension } from "./goal-extension";
import type { Goal, GoalAction, GoalBinding } from "../shared/goals";
import { Schedules, scheduledWake } from "./schedules";
import { Scheduler } from "./scheduler";
import { scheduleTools } from "./schedule-tools";
import type { ScheduleOccurrence, ScheduleSource } from "../shared/schedules";
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
import { Desktop, type DesktopOptions } from "./desktop";
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
  readonly goals: Goals;
  readonly schedules: Schedules;
  readonly scheduler: Scheduler;
  readonly desktop: Desktop;
  constructor(
    readonly store: Store,
    readonly harness: Harness,
    options: {
      schedulerOptions?: { concurrency?: number; batchSize?: number; pollMs?: number };
      scheduleClock?: () => number;
      sudoExecutor?: SudoExecutor;
      interventionTtlMs?: number;
      allowedOrigins?: string[];
      desktopOptions?: DesktopOptions;
    } = {},
  ) {
    store.recover();
    this.goals = new Goals(store, event => this.notify(event));
    this.goals.recover();
    this.schedules = new Schedules(store, options.scheduleClock, event => { this.notify(event); this.scheduler?.wake(); });
    this.scheduler = new Scheduler(this.schedules, occurrence => this.startScheduled(occurrence), options.schedulerOptions);
    this.subagents = new SubagentStore(store.db);
    this.apps = new AppsService(store, {
      dataDir: harness.dataDir,
      allowedOrigins: options.allowedOrigins,
      emit: (type: string, data: Record<string, unknown>) => this.emit(null, null, type, data),
    });
    this.chrome = new ChromeSessions(harness.dataDir, store.instance().id, id => {
      this.emit(id, null, "chrome_changed", {});
    });
    this.chromeShare = new ChromeShare(this.chrome, harness.dataDir, async () => {}, () => this.emit(null, null, "chrome_changed", {}));
    this.chromeShare.onDone = async handoffs => {
      for (const { agent, id } of handoffs) {
        if (this.chrome.state(agent).task?.handoff !== id) continue;
        if (this.store.intervention(id)?.status === "pending") await this.completeBrowserControl(agent, id);
        else this.chrome.done(agent, id);
      }
    };
    this.browsers = new BrowserSessions(this.chrome);
    this.desktop = new Desktop(harness.dataDir, options.desktopOptions, () =>
      this.emit(null, null, "desktop_changed", {}));
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
  }
  private scopedBrowser(agentId: string, runId: string, selection: ChromeSelection, name: string) {
    const scoped = this.browsers.forRun(agentId, runId, selection, name, () => {
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
        port = browser;
        return port;
      },
    };
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
    if (archived) this.goals.stop(id, "Agent archived. Restore and explicitly resume to continue.");
    let event: Activity;
    const agent = this.store.db.transaction(() => {
      const agent = this.store.archiveAgent(id, archived);
      if (archived) this.schedules.pauseAgent(id);
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
    const chromeChanges = Object.fromEntries(Object.entries(input).filter(([key, value]) => key === "chromeProfile" && value !== undefined));
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
    this.goals.stop(agentId, "Paused for Fresh Session. Usage is preserved; resume explicitly.");
    return this.startRun(agent, `fresh-session:${requestId}`, "Fresh Session", "queue", true);
  }
  start(
    agentId: string,
    requestId: string,
    prompt: string,
    mode: MessageMode = "queue",
    browserTimezone?: string,
  ) {
    if (this.closing) throw new HttpError(503, "Jelly is shutting down.");
    if (requestId.startsWith("schedule:") || requestId.startsWith("goal:")) throw new HttpError(400, "Automated admission request IDs are reserved for the server.");
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
    const requestedTimezone = browserTimezone === undefined ? undefined : this.schedules.saveTimezone(agentId, browserTimezone).timezone;
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
      this.goals.stop(agentId, "Paused for human input. Resume explicitly to continue the goal.");
      let event: Activity;
      const message = this.store.db.transaction(() => {
        const message = this.store.enqueueMessage(
          requestId,
          agentId,
          prompt,
          mode,
          requestedTimezone,
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
    return this.startRun(agent, requestId, prompt, mode, false, undefined, requestedTimezone);
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
  changeGoal(agentId: string, action: GoalAction, input: Record<string, unknown>) {
    if (this.closing) throw new HttpError(409, "Jelly is shutting down.");
    const result = this.goals.mutate(agentId, action, input);
    if (action === "resume" && !result.reused) {
      try {
        if (this.activeFor(agentId)) throw new HttpError(409, "Wait for current work to finish before resuming.");
        this.startRun(this.store.agent(agentId)!, `goal:${result.goal.id}:${result.goal.epoch}`, goalPrompt(result.goal), "queue", false, undefined, undefined, result.goal);
      } catch (error) {
        this.goals.stop(agentId, `Not started: ${error instanceof Error ? error.message : "Could not start goal."}`, "blocked");
      }
    }
    return this.goals.view(agentId);
  }
  private startScheduled(occurrence: ScheduleOccurrence) {
    if (this.closing || this.activeFor(occurrence.agentId) || this.store.pendingMessages(occurrence.agentId).length) return false;
    const current = this.schedules.occurrence(occurrence.id);
    if (!current || current.state !== "pending") return false;
    const agent = this.store.agent(occurrence.agentId);
    if (!agent || agent.archivedAt) return false;
    const wake = scheduledWake(current, new Date(this.schedules.now()).toISOString());
    this.startRun(agent, current.requestId, wake.text, "queue", false, wake.source);
    return true;
  }
  private startRun(
    agent: AgentRecord,
    requestId: string,
    prompt: string,
    mode: MessageMode = "queue",
    freshSession = false,
    source?: ScheduleSource,
    browserTimezone?: string,
    goal?: Goal,
  ) {
    // Admission owns its transaction. Launching harness/model work under an outer
    // transaction would break crash guarantees even if the nested savepoint committed.
    if (this.store.db.inTransaction) throw new Error("Run admission cannot execute inside an outer transaction.");
    const agentId = agent.id;
    const instance = this.store.instance();
    const config = this.agentConfig(agent);
    const browserSelection = this.store.browserSelection();
    this.harness.requireConnection(config);
    const events: Activity[] = [];
    let nameAgent = false;
    let goalBinding: GoalBinding | undefined;
    const provenance = goal ? { source: "goal", goalId: goal.id, goalEpoch: goal.epoch, goalObjective: goal.objective } : source;
    const run = this.store.db.transaction(() => {
      if (!freshSession && !source && !goal) nameAgent = this.store.claimAgentName(agentId);
      if (!freshSession && !source && !goal && !this.store.pendingMessage(requestId))
        this.store.enqueueMessage(requestId, agentId, prompt, mode, browserTimezone);
      const run = this.store.createRun(
        agentId,
        requestId,
        prompt,
        config.activeMode!,
        config.model,
      );
      if (goal) goalBinding = this.goals.admit(goal, run.id);
      if (source) {
        this.schedules.admit(source.occurrenceId, run.id, source);
        this.store.db.query("UPDATE runs SET source=? WHERE id=?").run(JSON.stringify(source), run.id);
      }
      this.store.setStatus(agentId, "running");
      if (!freshSession) {
        if (!source && !goal) this.store.deliverMessage(requestId, run.id);
        this.store.saveMessage(agentId, run.id, {
          role: "user",
          content: prompt,
          timestamp: Date.now(),
        }, source);
        events.push(
          this.store.event(agentId, run.id, "message", {
            ...provenance,
            role: "user",
            text: prompt,
            messageId: requestId,
            mode: this.store.pendingMessage(requestId)?.mode ?? "queue",
          }),
        );
      }
      events.push(
        this.store.event(agentId, run.id, "run_started", {
          ...provenance,
          operation: goal ? "goal" : freshSession ? "fresh_session" : "message",
          mode: config.activeMode,
          model: config.model,
          selectedModel: config.selectedModel,
          effort: config.effort,
          status: "running",
        }),
      );
      return this.store.run(run.id)!;
    })();
    return this.executeRun({ agent, run, requestId, prompt, config, instance, browserSelection, nameAgent, freshSession, source, goalBinding, events });
  }
  /** Post-commit execution only; scheduler and interactive admission share this lifecycle. */
  private executeRun(input: {
    agent: AgentRecord;
    run: RunRecord;
    requestId: string;
    prompt: string;
    config: ReturnType<JellyService["agentConfig"]>;
    instance: ReturnType<Store["instance"]>;
    browserSelection: ChromeSelection;
    nameAgent: boolean;
    freshSession: boolean;
    source?: ScheduleSource;
    goalBinding?: GoalBinding;
    events: Activity[];
  }) {
    let { agent } = input;
    const { run, requestId, prompt, config, instance, browserSelection, nameAgent, freshSession, source, goalBinding, events } = input;
    const agentId = agent.id;
    // Only after the complete admission commits may naming, tools or provider work start.
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
      let checkpointed = false;
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
          catch (error) {
            // Claude can stop naming to protect subscription billing. Preserve
            // that failure and do not follow it with a second model request.
            if (config.activeMode === "claude-code") throw error;
            // Other naming failures remain best-effort.
          } finally {
            state.naming = undefined;
          }
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
        let deliveredRequestId = requestId;
        const schedulingTools = scheduleTools(
          this.schedules, agent.id, run.id,
          () => !this.closing && !state.cancelled && this.store.run(run.id)?.status === "running",
          () => deliveredRequestId,
        );
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
            ),
            ...this.desktop.tools(),
            ...appsTools(this.apps, agent),
            ...schedulingTools,
          ],
          (type, data) => this.emit(agentId, run.id, type, data),
          context,
          (snapshot, sources) => this.subagents.save(agentId, run.id, snapshot, sources),
          this.apps,
          goalBinding ? [goalExtension(this.goals, goalBinding, () => {
            if (this.closing || state.cancelled || failure || !state.session) return false;
            if (this.store.pendingMessages(agentId).length) {
              this.goals.stop(agentId, "Paused for queued human input. Resume explicitly afterward.");
              return false;
            }
            return !this.harness.hasChildWork(state.session);
          })] : [],
        );
        state.session = session;
        if (state.cancelled || failure) return;
        session.subscribe((event) => {
          if (event.type === "compaction_start") {
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
              deliveredRequestId = pending.id;
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
              this.store.saveMessage(agentId, run.id, message, source);
              // Pi's earlier core listener has already persisted this boundary.
              // Commit model context with the transcript, including tool results,
              // so a process crash cannot revert to the last successful run.
              this.store.saveContext(agentId, run.id, this.harness.checkpoint(session));
              checkpointed = true;
              if (message.role === "assistant") {
                if (goalBinding) {
                  // Other message hooks may append custom entries after the assistant.
                  const entryId = session.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant")?.id;
                  if (!entryId) throw new Error("Finalized goal message has no persisted assistant entry.");
                  const usageEvent = this.goals.account(goalBinding, entryId, message.usage);
                  if (usageEvent) saved.push(usageEvent);
                }
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
                    ...source,
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
          } else if (event.type === "message_end") {
            this.store.saveContext(agentId, run.id, this.harness.checkpoint(session));
            checkpointed = true;
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
      } catch (error) {
        failure ??= error instanceof Error ? error.message : "The run failed.";
      } finally {
        state.acceptsSteering = false;
        clearTimeout(state.thinkingTimer);
        clearTimeout(deadline);
        await stopping;
        if (!freshSession && checkpointed && state.session)
          try {
            // Preserve final compaction/extension state even when the last
            // request failed or the operator stopped the run.
            checkpoint = this.harness.checkpoint(state.session);
          } catch (error) {
            failure ??= error instanceof Error ? error.message : "Could not checkpoint session";
          }
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
        const status: RunRecord["status"] = state.cancelled
          ? "cancelled"
          : failure
            ? "failed"
            : "completed";
        let event: Activity;
        let freshEvent: Activity | undefined;
        this.store.db.transaction(() => {
          this.store.finishRun(run.id, status, failure);
          if (checkpoint && (!freshSession || status === "completed")) {
            this.store.saveContext(agentId, run.id, checkpoint);
            if (freshSession)
              freshEvent = this.store.event(agentId, run.id, "session_started", {
                sessionId: checkpoint[0]!.id, compacted,
              });
          }
          this.store.setStatus(agentId, status === "failed" ? "error" : "idle");
          event = this.store.event(agentId, run.id, `run_${status}`, {
            ...source,
            status,
            error: failure,
          });
        })();
        if (freshEvent) this.notify(freshEvent);
        this.notify(event!);
        this.active.delete(run.id);
        if (goalBinding) {
          // A settled run does not prove completion. Never stop a newer execution.
          const current = this.goals.get(agentId);
          if (current?.id === goalBinding.id && current.epoch === goalBinding.epoch && current.state === "active")
            this.goals.stop(agentId, failure ?? "Execution settled without goal completion. Review and resume explicitly.", "blocked");
        }
        this.scheduler.wake();
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
      message: this.store.pendingMessage(requestId),
      reused: false,
    };
  }
  async stop(agentId: string) {
    if (!this.store.agent(agentId))
      throw new HttpError(404, "Agent not found.");
    this.goals.stop(agentId, "Stopped by operator. Resume explicitly to continue.");
    this.store.db.transaction(() => this.schedules.stopAgent(agentId))();
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
    this.scheduler.stop();
    this.closing = true;
    for (const agent of this.store.agents()) this.goals.stop(agent.id, "Jelly shut down. Inspect current work and resume explicitly.");
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
