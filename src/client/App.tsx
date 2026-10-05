import { Avatar } from "./Avatar";
import { InitialAgentIdentity } from "./InitialAgentIdentity";
import { DEFAULT_AGENT_NAME } from "../shared/agent-names";
import { Settings, SettingsRow } from "./Settings";
import { ComposerSettings } from "./ComposerSettings";
import { captureAnchor, restoreAnchor, mergeHistory, snapshotHistory, type ScrollAnchor } from "./history";
import { useChatNavigation } from "./useChatNavigation";
import { useInputModality } from "./useInputModality";
import { useKeyboardViewport } from "./useKeyboardViewport";
import { useComposerSize } from "./useComposerSize";
import { useUnreadMessages } from "./useUnreadMessages";
import { AgentInbox } from "./AgentInbox";
import { MessageText } from "./MessageText";
import { GeneratedImages } from "./GeneratedImages";
import { BrowserScreenshots } from "./BrowserScreenshots";
import { toolImages, toolResultForDisplay } from "../shared/tool-images";
import { RenderedFiles } from "./RenderedFiles";
import { Modal } from "./Modal";
import { UploadFiles } from "./UploadFiles";
import {
  ProjectForm,
  MoveAgent,
} from "./Projects";
import {
  belongs,
  scopeKey,
  scopeName,
  scopeQuery,
  validScope,
  type Scope,
} from "./project-state";
import { AVATARS } from "../shared/avatars";
import { isToolActivity } from "./activityGroups";
import { conversationActivity } from "./conversationActivity";
import { WorkActivity } from "./WorkActivity";
import { copyText } from "./clipboard";
import type { ProjectRecord } from "../shared/types";
import { Folder, ChevronLeft } from "lucide-react";
import { requestId } from "./request-id";
import { InterventionCard } from "./InterventionCard";
import { ComputerPanel } from "./ComputerPanel";
import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  Archive,
  ArchiveRestore,
  RefreshCw,
  ArrowUp,
  ArrowDown,
  Plus,
  Monitor,
  X,
  Square,
  Check,
  Copy,
  LoaderCircle,
  ChevronDown,
  Pencil,
  AlertCircle,
  Ellipsis,
} from "lucide-react";
import type {
  Activity,
  AgentRecord,
  HistoryPage,
  RunRecord,
  Snapshot,
  MessageMode,
} from "../shared/types";
import { api, control, post } from "./api";
import { readPreference, savePreference, useTheme } from "./theme";
import { registerWorkspaceTools } from "./webmcp";

function previewTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}
function previewText(value: string) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
const colors = ["#b5bafc", "#a3d0b0", "#edbc8e", "#a4c8e8", "#e4acd0"];
function ArchivedAgents({
  scope,
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (id: string) => void;
  scope: Scope;
}) {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  async function load(cursor = "", signal?: AbortSignal) {
    setBusy(true);
    setError("");
    try {
      const page = await api<{ agents: AgentRecord[]; after: string | null }>(
        `/agents/archived?after=${encodeURIComponent(cursor)}&${scopeQuery(scope)}`,
        { signal },
      );
      if (signal?.aborted) return;
      setAgents((current) =>
        cursor ? [...current, ...page.agents] : page.agents,
      );
      setAfter(page.after);
    } catch (error) {
      if (!signal?.aborted) setError((error as Error).message);
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load("", controller.signal);
    return () => controller.abort();
  }, []);
  return (
    <Modal title="Archived agents" onClose={onClose}>
      <p className="subtle">
        Profiles and conversations stay here. Open an agent to review its
        history or restore it.
      </p>
      {agents.map((agent) => (
        <button
          className="agent-row"
          key={agent.id}
          onClick={() => onSelect(agent.id)}
        >
          <Avatar agent={agent} />
          <span>
            <strong>{agent.name}</strong>
          </span>
        </button>
      ))}
      {!busy && !agents.length && !error && <p>No archived agents.</p>}
      {error && (
        <p className="error-text" role="alert">
          {error} <button onClick={() => void load(after ?? "")}>Retry</button>
        </p>
      )}
      {busy && <p role="status">Loading…</p>}
      {after && (
        <button
          className="primary wide"
          disabled={busy}
          onClick={() => void load(after)}
        >
          Load more agents
        </button>
      )}
    </Modal>
  );
}
function Profile({
  projects,
  defaultProject,
  agent,
  onClose,
  onSave,
  embedded = false,
  onDirty,
  onBusy,
  disabled = false,
}: {
  projects: ProjectRecord[];
  defaultProject?: string;
  agent?: AgentRecord;
  onClose: () => void;
  onSave: (agent: AgentRecord) => void;
  embedded?: boolean;
  onDirty?: (dirty: boolean) => void;
  onBusy?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const [name, setName] = useState(agent?.name ?? DEFAULT_AGENT_NAME);
  const [nameEdited, setNameEdited] = useState(false);
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [color] = useState(agent?.color ?? colors[0]!);
  const [avatarId, setAvatarId] = useState(agent?.avatarId ?? "jellyfish");
  const [projectId, setProjectId] = useState(defaultProject ?? "");
  const [avatarPicker, setAvatarPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty =
    nameEdited || name !== (agent?.name ?? DEFAULT_AGENT_NAME) ||
    instructions !== (agent?.instructions ?? "") ||
    avatarId !== (agent?.avatarId ?? "jellyfish") ||
    (!agent && projectId !== (defaultProject ?? ""));
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    onBusy?.(busy);
  }, [busy, onBusy]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (disabled || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<AgentRecord>(
        agent ? `/agents/${agent.id}` : "/agents",
        {
          method: agent ? "PATCH" : "POST",
          body: JSON.stringify({
            name,
            nameEdited,
            instructions,
            color,
            avatarId,
            ...(!agent ? { projectId: projectId || null } : {}),
          }),
        },
      );
      onSave(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const form = (
    <form onSubmit={submit}>
      {disabled && <p role="status">Wait until the agent is idle and connected to edit its profile.</p>}
      <fieldset className="profile-fields" disabled={disabled || busy}>
      <div className="profile-preview">
        <Avatar agent={{ name: name || "J", color, avatarId }} size="large" />
        <button
          className="secondary"
          type="button"
          onClick={() => setAvatarPicker(!avatarPicker)}
          aria-expanded={avatarPicker}
        >
          Choose avatar
        </button>
      </div>
      {avatarPicker && (
        <div className="sea-avatar-grid" aria-label="Sea creature avatars">
          {AVATARS.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={avatarId === id}
              onClick={() => {
                setAvatarId(id);
                setAvatarPicker(false);
              }}
            >
              <Avatar agent={{ name: id, color, avatarId: id }} />
              <span>{id.replaceAll("-", " ")}</span>
            </button>
          ))}
        </div>
      )}
      {!agent && (
        <label>
          Project
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">Ungrouped</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Working directory
        <code className="directory-path">
          {agent?.cwd ??
            projects.find((p) => p.id === projectId)?.defaultCwd ??
            "A private workspace will be created"}
        </code>
        <small>
          {agent
            ? "Moving projects keeps this directory."
            : projectId
              ? "Inherited from the project."
              : "No project is required."}
        </small>
      </label>
      <label>
        Name
        <input
          autoFocus
          required
          maxLength={60}
          value={name}
          onChange={(e) => { setName(e.target.value); setNameEdited(true); }}
          placeholder="e.g. Scout"
        />
      </label>
      <label>
        Instructions
        <textarea
          rows={4}
          maxLength={12000}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="What should this agent help with? How should it work?"
        />
      </label>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <button className="primary wide" disabled={busy || !name.trim()}>
        {busy ? "Saving…" : agent ? "Save profile" : "Create agent"}
      </button>
      </fieldset>
    </form>
  );
  return embedded ? (
    form
  ) : (
    <Modal
      title={agent ? "Agent profile" : "Create an agent"}
      onClose={onClose}
      detent="large"
      dirty={dirty}
      dismissible={!busy}
      cancelLabel="Cancel"
    >
      {form}
    </Modal>
  );
}
function AgentDetails({
  agent,
  projects,
  connected,
  running,
  archiving,
  refreshing,
  canCompact,
  onFreshSession,
  onClose,
  onUpload,
  onComputer,
  onMove,
  onArchive,
  onSaved,
}: {
  agent: AgentRecord;
  projects: ProjectRecord[];
  connected: boolean;
  running: boolean;
  archiving: boolean;
  refreshing: boolean;
  canCompact: boolean;
  onFreshSession: () => void;
  onClose: () => void;
  onUpload: () => void;
  onComputer: () => void;
  onMove: () => void;
  onArchive: () => void;
  onSaved: () => void;
}) {
  const [page, setPage] = useState<"details" | "profile" | "workspace">(
    "details",
  );
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const project =
    projects.find((p) => p.id === agent.projectId)?.name ?? "Ungrouped";
  return (
    <Modal
      title={
        page === "details"
          ? agent.name
          : page === "profile"
            ? "Agent profile"
            : "Workspace"
      }
      className="agent-sheet"
      detent={page === "details" ? "medium" : "large"}
      dirty={dirty}
      dismissible={!busy}
      onClose={onClose}
      backDiscards={page === "profile"}
      onBack={
        page === "details"
          ? undefined
          : () => {
              setDirty(false);
              setPage("details");
            }
      }
    >
      {page === "details" && (
        <>
          <div className="agent-contact">
            <Avatar agent={agent} size="large" />
            <strong>{agent.name}</strong>
            <span>{project}</span>
            {["waiting", "error", "interrupted"].includes(agent.status) && (
              <small>Needs your attention</small>
            )}
          </div>
          <div className="settings-group">
            <SettingsRow
              label="Edit agent profile"
              icon={<Pencil size={19} />}
              disabled={running || !connected}
              onClick={() => setPage("profile")}
            />
            <SettingsRow
              label="Move to project"
              value={project}
              icon={<Folder size={19} />}
              disabled={!connected}
              onClick={onMove}
            />
            <SettingsRow
              label="Upload file"
              icon={<Plus size={19} />}
              disabled={!connected || !!agent.archivedAt}
              onClick={onUpload}
            />
            <SettingsRow
              label="Computer"
              icon={<Monitor size={19} />}
              disabled={!connected}
              onClick={onComputer}
            />
            <SettingsRow
              label="Fresh Session"
              value={canCompact ? "Compact context · keep chat history" : "Connect a model to compact"}
              icon={<RefreshCw size={19} />}
              disabled={running || !connected || refreshing || !!agent.archivedAt || !canCompact}
              onClick={onFreshSession}
            />
            <SettingsRow
              label="Workspace"
              icon={<Folder size={19} />}
              onClick={() => setPage("workspace")}
            />
          </div>
          <div className="settings-group archive-group">
            <button
              type="button"
              className="settings-row"
              disabled={running || !connected || archiving}
              onClick={onArchive}
            >
              <Archive size={19} />
              {agent.archivedAt ? "Restore agent" : "Archive agent"}
            </button>
          </div>
        </>
      )}
      {page === "workspace" && (
        <div className="settings-group settings-description">
          <p>Working directory</p>
          <code className="directory-path">{agent.cwd}</code>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void copyText(agent.cwd)
                .then(() => setCopyStatus("Copied"))
                .catch(() => setCopyStatus("Copy unavailable"))
            }
          >
            Copy directory
          </button>
          <p role="status">{copyStatus}</p>
          <p className="subtle">Moving projects keeps this directory.</p>
        </div>
      )}
      {page === "profile" && (
        <Profile
          embedded
          agent={agent}
          projects={projects}
          onDirty={setDirty}
          onBusy={setBusy}
          onClose={onClose}
          onSave={() => {
            setDirty(false);
            setBusy(false);
            onSaved();
            setPage("details");
          }}
        />
      )}
    </Modal>
  );
}
function EventItem({
  event,
  events,
  agent,
  runs,
}: {
  event: Activity;
  events: Activity[];
  runs: RunRecord[];
  agent: AgentRecord;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [copyVisible, setCopyVisible] = useState(false);
  if (event.type === "image_generated")
    return <GeneratedImages images={event.data.images} />;
  if (event.type === "file_rendered")
    return <RenderedFiles files={event.data.files} />;
  const attachments = toolImages(event);
  if (attachments.length) return <GeneratedImages images={attachments} />;
  if (event.type === "message")
    return (
      <article
        aria-label={
          event.data.role === "user" ? "Your message" : "Assistant reply"
        }
        className={`message ${event.data.role === "user" ? "from-user" : "from-agent"} ${copyVisible ? "copy-visible" : ""}`}
      >
        <div
          className="bubble"
          onPointerDown={(e) => {
            if (e.pointerType === "touch" || e.pointerType === "pen")
              setCopyVisible((visible) => !visible);
          }}
        >
          {event.data.role === "user" ? (
            String(event.data.text)
          ) : (
            <MessageText text={String(event.data.text)} />
          )}
        </div>
        {event.data.deliveryStatus === "cancelled" && (
          <small className="message-delivery">
            {String(event.data.reason)}
          </small>
        )}
        {event.data.role === "user" &&
          event.data.mode === "steer" &&
          event.data.deliveryStatus !== "cancelled" && (
            <small className="message-delivery">Steer</small>
          )}
        {event.data.role !== "user" && (
          <button
            type="button"
            className="copy-message"
            aria-label="Copy response"
            title={
              copied
                ? "Copied"
                : copyError
                  ? "Copy unavailable"
                  : "Copy response"
            }
            onClick={() => {
              setCopied(false);
              setCopyError(false);
              void copyText(String(event.data.text))
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                })
                .catch(() => setCopyError(true));
            }}
          >
            {copied ? (
              <Check size={16} aria-hidden="true" />
            ) : copyError ? (
              <AlertCircle size={16} aria-hidden="true" />
            ) : (
              <Copy size={16} aria-hidden="true" />
            )}
            <span className="sr-only" role="status">
              {copied ? "Copied" : copyError ? "Copy unavailable" : ""}
            </span>
          </button>
        )}
      </article>
    );
  if (event.type === "tool_started") {
    const end = events.find(
      (e) =>
        e.type === "tool_completed" &&
        e.data.toolCallId === event.data.toolCallId,
    );
    const settled =
      runs.some((run) => run.id === event.runId && run.status !== "running") ||
      events.some(
        (e) =>
          e.runId === event.runId &&
          [
            "run_failed",
            "run_cancelled",
            "run_interrupted",
            "run_completed",
          ].includes(e.type),
      );
    const label = end
      ? end.data.isError
        ? "Tool failed"
        : event.data.name === "instance_info"
          ? "Workspace checked"
          : "Tool completed"
      : settled
        ? runs.find((run) => run.id === event.runId)?.status === "completed"
          ? "Tool finished · result in newer activity"
          : "Tool interrupted"
        : event.data.name === "instance_info"
          ? "Checking workspace"
          : "Using tool";
    return (
      <details className="tool-event">
        <summary>
          {end ? (
            <Check size={14} />
          ) : settled ? (
            <AlertCircle size={14} />
          ) : (
            <LoaderCircle size={14} className="spin" />
          )}
          <span>{label}</span>
          <code>{String(event.data.name)}</code>
          <ChevronDown size={14} />
        </summary>
        <pre>
          {JSON.stringify(
            toolResultForDisplay(end?.data.result ?? event.data.args),
            null,
            2,
          )}
        </pre>
      </details>
    );
  }
  if (
    event.type === "tool_completed" &&
    !events.some(
      (item) =>
        item.type === "tool_started" &&
        item.runId === event.runId &&
        item.data.toolCallId === event.data.toolCallId,
    )
  )
    return (
      <details className="tool-event">
        <summary>
          <Check size={14} />
          {event.data.isError ? "Tool failed" : "Tool completed"}
          <code>{String(event.data.name)}</code>
        </summary>
        <pre>
          {JSON.stringify(toolResultForDisplay(event.data.result), null, 2)}
        </pre>
      </details>
    );
  if (event.type === "session_started")
    return <div className="run-note">Fresh session started · {event.data.compacted
      ? "compacted context carried forward" : "existing context carried forward"} · chat history preserved</div>;
  if (
    event.type === "compaction_started" ||
    event.type === "compaction_completed"
  )
    return (
      <div className="run-note">
        {event.type === "compaction_started"
          ? "Summarizing earlier context…"
          : event.data.success
            ? "Earlier context summarized · full conversation preserved"
            : event.data.aborted
              ? "Context summary stopped"
              : `Context summary failed: ${String(event.data.error ?? "Please try again.")}`}
      </div>
    );
  if (event.type.startsWith("subagent_"))
    return (
      <div className="run-note">
        Subagent {String(event.data.agent ?? "")} ·{" "}
        {String(
          event.data.status ??
            event.data.state ??
            event.type.replace("subagent_", ""),
        )}
      </div>
    );
  if (event.type === "run_completed")
    return (
      <div className="run-note">
        <Check size={13} /> Complete
        {events.some(
          (e) =>
            e.runId === event.runId &&
            e.type === "run_started" &&
            e.data.mode === "demo",
        )
          ? " · Local demo"
          : ""}
      </div>
    );
  if (event.type === "run_failed" || event.type === "run_interrupted")
    return (
      <div className="run-error" role="alert">
        <AlertCircle size={16} />
        <span>{String(event.data.error ?? "This run did not finish.")}</span>
      </div>
    );
  if (event.type === "run_cancelled")
    return (
      <div className="run-note">
        <Square size={12} /> Stopped
      </div>
    );
  return null;
}
export function App() {
  const appRoot = useRef<HTMLDivElement>(null);
  useInputModality(appRoot);
  const { theme, setTheme, resolved } = useTheme();
  const [computerOpen, setComputerOpen] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<AgentRecord | null>(null);
  const [data, setData] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState("");
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [listOpen, setListOpen] = useState(true);
  const [mobile, setMobile] = useState(
    () => window.matchMedia("(max-width:767px)").matches,
  );
  useEffect(() => {
    const m = window.matchMedia("(max-width:767px)");
    const update = () => setMobile(m.matches);
    m.addEventListener("change", update);
    return () => m.removeEventListener("change", update);
  }, []);
  const [projectModal, setProjectModal] = useState<
    "create" | "edit" | "move" | "add" | null
  >(null);
  const [announcement, setAnnouncement] = useState("");
  const nav = useRef<{
    scope: Scope;
    selected: string;
    last: Record<string, string>;
    recent: string[];
    instance: string;
  }>({
    scope: { kind: "all" },
    selected: "",
    last: {},
    recent: [],
    instance: "",
  });
  const persistNav = () => {
    if (nav.current.instance)
      savePreference(
        `jelly.navigation.${nav.current.instance}`,
        JSON.stringify(nav.current),
      );
  };
  const [connected, setConnected] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [modal, setModal] = useState<
    "settings" | "archived" | "options" | "profile" | null
  >(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [uploadTarget, setUploadTarget] = useState<AgentRecord | null>(null);
  const [sending, setSending] = useState(false);
  const [messageMode, setMessageMode] = useState<MessageMode>("queue");
  const [steering, setSteering] = useState<string | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const [archiving, setArchiving] = useState(false);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [creationError, setCreationError] = useState("");
  const creationPending = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const [history, setHistory] = useState<{
    agentId: string;
    page: HistoryPage;
  } | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const historyGeneration = useRef(0);
  const historyCache = useRef(new Map<string, HistoryPage>());
  const historyRequest = useRef<{ generation: number; before: number } | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [scrolledUp, setScrolledUp] = useState(false);
  const prependAnchor = useRef<{ agentId: string; anchor: ScrollAnchor } | null>(null);
  const latestData = useRef(data);
  latestData.current = data;
  useLayoutEffect(() => {
    if (history) historyCache.current.set(history.agentId, history.page);
  }, [history]);
  useEffect(() => () => { historyGeneration.current++; }, []);
  const conversation = useRef<HTMLDivElement>(null);
  useKeyboardViewport(appRoot, conversation);
  const [actionError, setActionError] = useState("");
  const [editingIdentity, setEditingIdentity] = useState(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const scrollMemory = useRef(
    new Map<string, { top: number; bottom: boolean }>(),
  );
  const scrollAgent = useRef("");
  const readingAnchor = useRef<ScrollAnchor | null>(null);
  const applyHistoryScope = useRef<(id?: string) => void>(() => {});
  const backToAgents = useCallback(() => {
    setListOpen(true);
    composerInput.current?.blur();
    if (window.history.state?.jellyChat) window.history.back();
  }, []);
  useChatNavigation(appRoot, mobile, listOpen, backToAgents);
  useEffect(() => {
    if (!mobile) return;
    const timer = window.setTimeout(
      () => {
        const root = appRoot.current;
        if (!root || root.querySelector("dialog[open]")) return;
        const page = root.querySelector(listOpen ? ".sidebar" : "main");
        if (page?.contains(document.activeElement)) return;
        const target = page?.querySelector<HTMLElement>(
          listOpen ? ".agent-row[aria-current], .agent-row" : ".mobile-back",
        );
        target?.focus({ preventScroll: true });
      },
      350,
    );
    return () => window.clearTimeout(timer);
  }, [mobile, listOpen]);
  useEffect(() => {
    const pop = () => {
      setListOpen(!window.history.state?.jellyChat);
      applyHistoryScope.current(window.history.state?.jellyProject);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [mobile]);
  const rememberScroll = () => {
    const chat = conversation.current;
    if (chat && selected === data?.selectedAgentId) {
      const bottom = chat.scrollHeight - chat.clientHeight - chat.scrollTop < 48;
      scrollMemory.current.set(selected, { top: chat.scrollTop, bottom });
      readingAnchor.current = captureAnchor(chat);
      setScrolledUp(!bottom);
    }
  };
  const onConversationScroll = () => {
    const chat = conversation.current;
    const previous = scrollMemory.current.get(selected);
    rememberScroll();
    if (!chat || selected !== data?.selectedAgentId) return;
    // Once reading earlier messages, retain the live tail as snapshots advance.
    if (chat.scrollHeight - chat.clientHeight - chat.scrollTop >= 48 && !history)
      setHistory({ agentId: selected, page: snapshotHistory(data) });
    if (previous && chat.scrollTop < previous.top && chat.scrollTop <= 160 && !historyError)
      void olderHistory();
  };
  const pending = useRef<{ id: string; agentId: string; text: string } | null>(
    null,
  );
  useEffect(() => {
    let dead = false;
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest = 0;
    const load = async () => {
      const request = ++latest;
      try {
        let next: Snapshot;
        try {
          next = await api<Snapshot>(
            `/state${nav.current.selected ? `?agentId=${encodeURIComponent(nav.current.selected)}` : nav.current.instance ? "?selection=none" : ""}`,
          );
        } catch (error) {
          if (
            nav.current.selected &&
            (error as Error).message === "Agent not found."
          ) {
            nav.current.selected = "";
            next = await api<Snapshot>("/state?selection=none");
          } else throw error;
        }
        if (dead || request !== latest) return;
        next.projects ??= [];
        if (
          !nav.current.instance ||
          nav.current.instance !== next.instance.id
        ) {
          let saved: Record<string, any> = {};
          try {
            const value = JSON.parse(
              readPreference(`jelly.navigation.${next.instance.id}`, "{}"),
            );
            if (value && typeof value === "object" && !Array.isArray(value))
              saved = value;
          } catch {}
          nav.current = {
            scope: validScope(saved.scope, next.projects),
            selected:
              typeof saved.selected === "string"
                ? saved.selected
                : readPreference("jelly.agent", ""),
            last:
              saved.last && typeof saved.last === "object" ? saved.last : {},
            recent: Array.isArray(saved.recent)
              ? saved.recent.filter((id: unknown) => typeof id === "string")
              : [],
            instance: next.instance.id,
          };
          setScope(nav.current.scope);
          if (nav.current.scope.kind === "project" && !window.history.state?.jellyProject)
            window.history.replaceState({ ...window.history.state, jellyProject: nav.current.scope.projectId, jellyProjectEntry: false }, "");
        }
        const currentScope = validScope(nav.current.scope, next.projects);
        nav.current.scope = currentScope;
        setScope(currentScope);
        const eligible = next.agents.filter(
          (a) => !a.archivedAt && belongs(a, currentScope),
        );
        const current = next.agents.find((a) => a.id === nav.current.selected);
        const destination =
          current && belongs(current, currentScope)
            ? current.id
            : (eligible.find(
                (a) => a.id === nav.current.last[scopeKey(currentScope)],
              )?.id ??
              eligible[0]?.id ??
              "");
        if (destination !== nav.current.selected) {
          historyGeneration.current++;
          setHistory(historyCache.current.has(destination) ? { agentId: destination, page: historyCache.current.get(destination)! } : null);
          setLoadingHistory(false);
          setHistoryError("");
          prependAnchor.current = null;
          nav.current.selected = destination;
        }
        setSelected(destination);
        persistNav();
        if ((next.selectedAgentId ?? "") !== destination) {
          setData({
            ...next,
            selectedAgentId: null,
            events: [],
            runs: [],
            interventions: [],
            historyBefore: null,
          });
          void load();
          return;
        }
        setHistory(previous => previous?.agentId === next.selectedAgentId
          ? { agentId: previous.agentId, page: mergeHistory(previous.page, snapshotHistory(next)) }
          : previous);
        setData(next);
        setLoadError("");
        if (source?.readyState === EventSource.OPEN) setConnected(true);
        if (!source) {
          const connection = new EventSource(
            `/api/events?after=${next.cursor}`,
          );
          source = connection;
          source.onopen = () => {
            if (!dead && source === connection) {
              setConnected(true);
              void load();
            }
          };
          source.onerror = () => {
            if (dead || source !== connection) return;
            setConnected(false);
            source?.close();
            source = undefined;
            // Reopen from a fresh snapshot instead of retrying an expired cursor.
            clearTimeout(timer);
            timer = setTimeout(() => void load(), 1000);
          };
          source.addEventListener("reset", () => {
            if (dead || source !== connection) return;
            source?.close();
            source = undefined;
            setConnected(false);
            void load();
          });
          source.addEventListener("activity", () => {
            if (dead || source !== connection) return;
            clearTimeout(timer);
            timer = setTimeout(() => void load(), 25);
          });
        }
      } catch (error) {
        if (!dead && request === latest) {
          setLoadError((error as Error).message);
          setConnected(false);
        }
      }
    };
    refresh.current = load;
    void load();
    const retry = setInterval(() => {
      if (!source || source.readyState !== EventSource.OPEN) void load();
    }, 3000);
    return () => {
      dead = true;
      source?.close();
      clearInterval(retry);
      clearTimeout(timer);
    };
  }, []);
  useLayoutEffect(() => {
    const chat = conversation.current;
    if (!chat || !selected || selected !== data?.selectedAgentId) return;
    const pending = prependAnchor.current;
    if (pending?.agentId === selected) {
      restoreAnchor(chat, pending.anchor);
      prependAnchor.current = null;
      rememberScroll();
      return;
    }
    const saved = scrollMemory.current.get(selected);
    const changed = scrollAgent.current !== selected;
    if (changed || !saved || (saved.bottom && Math.abs(chat.scrollTop - saved.top) < 1)) {
      chat.scrollTo({
        top: saved && !saved.bottom ? saved.top : chat.scrollHeight,
        behavior: "instant",
      });
    } else if (readingAnchor.current?.key) {
      restoreAnchor(chat, readingAnchor.current);
    }
    scrollAgent.current = selected;
    rememberScroll();
  }, [
    data?.events.at(-1)?.id,
    data?.pendingMessages?.length,
    data?.selectedAgentId,
    selected,
    history,
  ]);
  useLayoutEffect(() => {
    const chat = conversation.current;
    if (!chat || !selected || selected !== data?.selectedAgentId || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (scrollAgent.current !== selected || nav.current.selected !== selected) return;
      // An empty agent's expanding avatar picker is a form, not a new reply.
      // Following its bottom hides the identity pill above the taller composer.
      if (chat.querySelector(".initial-agent-profile")) return;
      const saved = scrollMemory.current.get(selected);
      if (saved?.bottom && Math.abs(chat.scrollTop - saved.top) < 1) {
        const bottom = Math.max(0, chat.scrollHeight - chat.clientHeight);
        if (Math.abs(bottom - chat.scrollTop) > 0.5)
          chat.scrollTo({ top: bottom, behavior: "instant" });
      } else if (readingAnchor.current?.key) {
        restoreAnchor(chat, readingAnchor.current);
      }
      rememberScroll();
    });
    // The viewport can stay the same size while an image, font, or expanded
    // preview changes the height of content above the reader.
    observer.observe(chat);
    for (const child of chat.children) observer.observe(child);
    return () => observer.disconnect();
  }, [selected, data?.selectedAgentId, data?.events.length, history]);
  useEffect(() => {
    return registerWorkspaceTools({
      read: () => api<Snapshot>("/state"),
      create: async (input) => {
        const agent = await post<AgentRecord>("/agents", input);
        nav.current.scope = { kind: "all" };
        setScope({ kind: "all" });
        nav.current.selected = agent.id;
        setSelected(agent.id);
        persistNav();
        await refresh.current();
        return agent;
      },
    });
  }, []);
  // A newly built client can briefly be served by the previous backend.
  const connectionReady = data?.config.ready ?? (
    data?.config.activeMode === "chatgpt"
      ? data.config.chatgptReady
      : data?.config.activeMode === "api" && data.config.apiReady
  );
  const agent = data?.agents.find(
    (a) =>
      a.id === selected && a.id === data.selectedAgentId && belongs(a, scope),
  );
  const projects = data?.projects ?? [];
  const currentProject =
    scope.kind === "project"
      ? projects.find((p) => p.id === scope.projectId)
      : undefined;
  const unreadAgents = useUnreadMessages(
    data?.instance.id ?? "",
    data?.latestAssistantMessages,
    agent && (!mobile || !listOpen) && !scrolledUp ? agent.id : null,
  );
  const draft = agent ? (drafts[agent.id] ?? "") : "";
  useComposerSize(composerInput, draft, agent?.id, actionError, connectionReady, !!agent?.archivedAt);
  const running = agent?.status === "running" || agent?.status === "waiting";
  const selectionReady = !!data && (data.selectedAgentId ?? "") === selected;
  const canSend =
    connectionReady &&
    selectionReady &&
    !!agent &&
    !agent.archivedAt &&
    connected &&
    stopping !== agent.id &&
    !sending &&
    !savingModel &&
    !editingIdentity &&
    !!draft.trim();
  const select = (id: string) => {
    rememberScroll();
    if (mobile && !window.history.state?.jellyChat)
      window.history.pushState(
        { ...window.history.state, jellyChat: true },
        "",
      );
    historyGeneration.current++;
    setHistory(historyCache.current.has(id) ? { agentId: id, page: historyCache.current.get(id)! } : null);
    setLoadingHistory(false);
    setHistoryError("");
    prependAnchor.current = null;
    nav.current.selected = id;
    nav.current.last[scopeKey(nav.current.scope)] = id;
    setSelected(id);
    setListOpen(false);
    persistNav();
    void refresh.current();
    setActionError("");
  };
  const switchScope = (next: Scope, desired?: string) => {
    rememberScroll();
    const previous = nav.current;
    previous.last[scopeKey(previous.scope)] = previous.selected;
    const eligible = (data?.agents ?? []).filter(
      (a) => !a.archivedAt && belongs(a, next),
    );
    const id =
      desired ??
      eligible.find((a) => a.id === previous.last[scopeKey(next)])?.id ??
      eligible.find((a) => a.id === previous.selected)?.id ??
      eligible[0]?.id ??
      "";
    previous.scope = next;
    previous.selected = id;
    if (next.kind === "project")
      previous.recent = [
        next.projectId,
        ...previous.recent.filter((p) => p !== next.projectId),
      ].slice(0, 8);
    setScope(next);
    setSelected(id);
    setProjectModal(null);
    setActionError("");
    historyGeneration.current++;
    setHistory(historyCache.current.has(id) ? { agentId: id, page: historyCache.current.get(id)! } : null);
    setLoadingHistory(false);
    setHistoryError("");
    prependAnchor.current = null;
    persistNav();
    setData((d) =>
      d
        ? {
            ...d,
            selectedAgentId: null,
            events: [],
            runs: [],
            interventions: [],
            historyBefore: null,
          }
        : d,
    );
    setAnnouncement(`${scopeName(next, projects)} selected`);
    void refresh.current();
  };
  applyHistoryScope.current = (id) => {
    const next: Scope = id && projects.some(p => p.id === id) ? { kind: "project", projectId: id } : { kind: "all" };
    if (scopeKey(next) !== scopeKey(nav.current.scope)) switchScope(next);
  };
  function openProject(id: string) {
    if (nav.current.scope.kind !== "project" || nav.current.scope.projectId !== id) {
      const state = window.history.state;
      if (state?.jellyChat && nav.current.scope.kind !== "project")
        window.history.replaceState({ ...state, jellyChat: false }, "");
      const next = { ...window.history.state, jellyProject: id, jellyProjectEntry: true, jellyChat: false };
      if (state?.jellyProjectEntry && !state?.jellyChat) window.history.replaceState(next, "");
      else window.history.pushState(next, "");
    }
    switchScope({ kind: "project", projectId: id });
    setListOpen(true);
  }
  function backToProjects() {
    if (window.history.state?.jellyProjectEntry && window.history.length > 1) {
      window.history.go(window.history.state?.jellyChat ? -2 : -1);
    } else {
      window.history.replaceState({ ...window.history.state, jellyProject: null, jellyProjectEntry: false, jellyChat: false }, "");
      switchScope({ kind: "all" });
      setListOpen(true);
    }
  }
  function openInboxAgent(id: string) {
    const target = data?.agents.find(a => a.id === id);
    if (target?.projectId && (scope.kind !== "project" || scope.projectId !== target.projectId)) openProject(target.projectId);
    select(id);
  }
  async function createAgent() {
    if (!connected || creationPending.current) return;
    creationPending.current = true;
    setCreatingAgent(true);
    setCreationError("");
    const targetScope = nav.current.scope;
    try {
      const created = await post<AgentRecord>("/agents", {
        name: DEFAULT_AGENT_NAME,
        instructions: "",
        color: colors[0],
        avatarId: "jellyfish",
        nameEdited: false,
        projectId: targetScope.kind === "project" ? targetScope.projectId : null,
      });
      if (mobile && listOpen && !window.history.state?.jellyChat)
        window.history.pushState({ ...window.history.state, jellyChat: true }, "");
      switchScope(targetScope, created.id);
      setListOpen(false);
      setModal(null);
      setAnnouncement("New Agent created");
    } catch (error) {
      setCreationError((error as Error).message);
    } finally {
      creationPending.current = false;
      setCreatingAgent(false);
    }
  }
  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!canSend || !agent) return;
    setSending(true);
    setActionError("");
    const target = agent.id;
    const text = draft.trim();
    if (
      !pending.current ||
      pending.current.agentId !== target ||
      pending.current.text !== text
    )
      pending.current = { id: requestId(), agentId: target, text };
    try {
      await post(`/agents/${target}/messages`, {
        text,
        requestId: pending.current.id,
        mode: messageMode,
      });
      setDrafts((d) => ({
        ...d,
        [target]: d[target]?.trim() === text ? "" : (d[target] ?? ""),
      }));
      pending.current = null;
      setMessageMode("queue");
      if (nav.current.selected === target) jumpToBottom();
      await refresh.current();
    } catch (error) {
      if (nav.current.selected === target)
        setActionError((error as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function stop() {
    if (!agent || stopping === agent.id) return;
    const target = agent.id;
    setStopping(target);
    try {
      await post(`/agents/${target}/stop`, {});
      await refresh.current();
    } catch (error) {
      if (nav.current.selected === target)
        setActionError((error as Error).message);
    } finally {
      setStopping(null);
    }
  }
  async function steerMessage(messageId: string) {
    if (!agent || steering) return;
    const target = agent.id;
    setSteering(messageId);
    setActionError("");
    try {
      await post(`/agents/${target}/steer`, { messageId });
      await refresh.current();
    } catch (error) {
      if (nav.current.selected === target)
        setActionError((error as Error).message);
      await refresh.current();
    } finally {
      setSteering(null);
    }
  }
  async function freshSession() {
    if (!agent || running || refreshing) return;
    const target = agent.id;
    setRefreshing(true);
    setActionError("");
    setModal(null);
    try {
      await control(`/agents/${target}/fresh-session`, { requestId: requestId() });
      await refresh.current();
    } catch (error) {
      if (nav.current.selected === target) setActionError((error as Error).message);
    } finally {
      setRefreshing(false);
    }
  }
  async function archive(archived: boolean) {
    if (!agent || archiving) return;
    const target = agent.id;
    setArchiving(true);
    setActionError("");
    try {
      await post(`/agents/${target}/${archived ? "archive" : "restore"}`, {});
      await refresh.current();
    } catch (error) {
      if (nav.current.selected === target)
        setActionError((error as Error).message);
    } finally {
      setArchiving(false);
    }
  }
  const page = history?.agentId === agent?.id ? history?.page : null;
  const visibleEvents = page?.events ?? data?.events ?? [];
  const visibleRuns = page?.runs ?? data?.runs ?? [];
  const before = page ? page.before : data?.historyBefore;
  async function olderHistory() {
    if (!agent || before == null || loadingHistory) return;
    const generation = historyGeneration.current;
    if (historyRequest.current?.generation === generation) return;
    const request = { generation, before };
    historyRequest.current = request;
    const base = page ?? snapshotHistory(data!);
    setLoadingHistory(true);
    setHistoryError("");
    try {
      const older = await api<HistoryPage>(
        `/agents/${agent.id}/history?before=${before}`,
      );
      if (generation !== historyGeneration.current) return;
      const chat = conversation.current;
      // Capture at completion, not request start: the reader may still be moving.
      if (chat && !scrollMemory.current.get(agent.id)?.bottom)
        prependAnchor.current = { agentId: agent.id, anchor: captureAnchor(chat) };
      setHistory(previous => ({
        agentId: agent.id,
        page: mergeHistory(mergeHistory(older, base),
          previous?.agentId === agent.id ? previous.page
            : latestData.current?.selectedAgentId === agent.id ? snapshotHistory(latestData.current) : base),
      }));
    } catch (error) {
      if (generation === historyGeneration.current)
        setHistoryError((error as Error).message);
    } finally {
      if (historyRequest.current === request) historyRequest.current = null;
      if (generation === historyGeneration.current) setLoadingHistory(false);
    }
  }
  function jumpToBottom() {
    const chat = conversation.current;
    if (!chat || !agent) return;
    // Cancel any pending prepend correction without discarding loaded history.
    prependAnchor.current = null;
    chat.scrollTo({ top: chat.scrollHeight, behavior: "instant" });
    rememberScroll();
  }
  const meaningful =
    visibleEvents.some((e) => e.type === "message") ||
    running ||
    before != null ||
    !!(agent && data?.agentPreviews?.[agent.id]);
  return (
    <div
      ref={appRoot}
      className={`app t-page-slide ${listOpen ? "show-agent-list" : "show-chat"}`}
      data-page={listOpen ? "1" : "2"}
    >
      <span className="sr-only" role="status">
        {announcement}
      </span>
      <aside
        className="sidebar t-page"
        data-page-id="1"
        inert={mobile && !listOpen}
        aria-label="Agents"
      >
        <AgentInbox
          data={data}
          projectId={scope.kind === "project" ? scope.projectId : undefined}
          selectedId={agent?.id}
          unread={unreadAgents}
          connected={connected}
          visible={!mobile || listOpen}
          dark={resolved === "dark"}
          onProject={openProject}
          onBack={backToProjects}
          onAgent={openInboxAgent}
          onArchived={() => setModal("archived")}
          onSettings={() => setModal("settings")}
          onToggleTheme={() => setTheme(resolved === "dark" ? "light" : "dark")}
          onNewProject={() => setProjectModal("create")}
          onManageProject={() => setProjectModal("edit")}
          onAddAgent={() => setProjectModal("add")}
          previewTime={previewTime}
          previewText={previewText}
        />
        {creationError && (!mobile || listOpen) && <p className="error-text" role="alert">{creationError}</p>}
        <button
          type="button"
          className="agent-create-fab"
          aria-label="Create agent"
          title="Create agent"
          onClick={() => void createAgent()}
          disabled={!connected || creatingAgent}
          aria-busy={creatingAgent}
        >
          {creatingAgent ? <LoaderCircle size={28} className="spin" aria-hidden="true" /> : <Plus size={30} strokeWidth={1.8} aria-hidden="true" />}
        </button>
      </aside>
      <main className="t-page" data-page-id="2" inert={mobile && listOpen}>
        <header className="conversation-header">
          <button
            className="icon mobile-back"
            aria-label="Agents"
            title="Back to agents"
            onClick={backToAgents}
          >
            <ChevronLeft size={22} />
          </button>
          {agent && meaningful ? (
            <button
              className="agent-identity"
              aria-label={`Edit ${agent.name} profile`}
              aria-haspopup="dialog"
              onClick={() => setModal("profile")}
            >
              <span
                className={`agent-avatar${agent.status === "running" ? " is-working" : ""}`}
                aria-hidden="true"
              >
                <Avatar
                  agent={agent}
                  size="small"
                  working={agent.status === "running"}
                />
              </span>
              <span className="agent-identity-copy">
                <strong>{agent.name}</strong>
                <span className="header-status">
                  <i className={`status-dot ${agent.status}`} />
                  {agent.archivedAt
                    ? "Archived"
                    : agent.status === "waiting"
                      ? "Needs you"
                      : running
                        ? "Working"
                        : connected
                          ? "Ready"
                          : "Offline"}
                </span>
              </span>
            </button>
          ) : !agent ? (
            <span className="empty-header-title">Your agents</span>
          ) : null}
          <div className="conversation-actions">
            <button
              className="icon computer-button"
              aria-label="Computer"
              title="Computer"
              onClick={() => setComputerOpen(agent?.id ?? null)}
              disabled={!connected}
            >
              <Monitor size={20} />
            </button>
            {agent && (
              <button
                className="icon agent-options"
                aria-label="Agent options"
                title="Agent options"
                aria-haspopup="dialog"
                onClick={() => setModal("options")}
              >
                <Ellipsis size={20} />
              </button>
            )}
          </div>
        </header>
        {creationError && mobile && !listOpen && <p className="error-text" role="alert">{creationError}</p>}
        {loadError && (
          <div className="connection-error" role="alert">
            {loadError}{" "}
            <button onClick={() => void refresh.current()}>Retry</button>
          </div>
        )}
        {!connected && data && !loadError && (
          <div className="connection-error" role="status">
            Reconnecting to Jelly. Work continues on the server.
          </div>
        )}
        <div
          className="conversation"
          ref={conversation}
          onScroll={onConversationScroll}
          aria-label="Conversation"
          aria-live="polite"
        >
          {selectionReady && before != null && (
            <div className="history-navigation">
              {historyError ? <span role="alert">Could not load older messages. {historyError}</span> : null}
              <button disabled={loadingHistory} onClick={() => void olderHistory()}>
                {loadingHistory ? "Loading older messages…" : historyError ? "Retry loading older messages" : "Load older messages"}
              </button>
            </div>
          )}
          {!data || !selectionReady ? (
            <div className="welcome">
              <LoaderCircle className="spin" />
              <p>Connecting to your workspace…</p>
            </div>
          ) : agent && !meaningful ? (
            <div className="welcome">
              <InitialAgentIdentity
                key={agent.id}
                agent={agent}
                disabled={!connected || !!agent.archivedAt}
                onEditing={setEditingIdentity}
                onSaved={(updated) => {
                  setData((current) => current ? {
                    ...current,
                    agents: current.agents.map((item) => item.id === updated.id ? updated : item),
                  } : current);
                  void refresh.current();
                }}
              />
            </div>
          ) : agent ? (
            <div className="timeline">
              {conversationActivity(visibleEvents, visibleRuns).map(
                (entry) =>
                  entry.kind === "work" ? (
                    <div key={entry.key} data-activity-key={entry.key}>
                    <WorkActivity
                      events={entry.events}
                      run={entry.run}
                      agent={agent}
                      stopping={
                        stopping === agent.id && entry.run?.status === "running"
                      }
                      renderEvent={(event) => (
                        <EventItem
                          key={event.id}
                          event={event}
                          events={visibleEvents}
                          runs={visibleRuns}
                          agent={agent}
                        />
                      )}
                    />
                    </div>
                  ) : (
                    <div key={entry.key} data-activity-key={entry.key}>
                      {entry.kind === "screenshots" ? (
                        <BrowserScreenshots events={entry.events} />
                      ) : (
                      <EventItem
                        event={entry.event}
                        events={visibleEvents}
                        runs={visibleRuns}
                        agent={agent}
                      />
                      )}
                    </div>
                  ),
              )}
            </div>
          ) : (
            <div className="welcome">
              <img className="empty-jelly" src="/brand/jelly-mark.png" alt="" />
              <h1>
                {currentProject
                  ? "A fresh space for your ideas."
                  : "Create your next agent."}
              </h1>
              <p>
                {currentProject
                  ? `No agents in ${currentProject.name} yet. New agents will start in the project folder.`
                  : "A little help for whatever comes next."}
              </p>
              {currentProject && (
                <code className="directory-path">
                  {currentProject.defaultCwd}
                </code>
              )}
              <div className="empty-actions">
                <button className="primary" disabled={!connected || creatingAgent} onClick={() => void createAgent()}>
                  {creatingAgent ? "Creating…" : "Create agent"}
                </button>
                {currentProject && (
                  <button
                    className="secondary"
                    onClick={() => setProjectModal("add")}
                  >
                    Add existing agent
                  </button>
                )}
              </div>
            </div>
          )}
          {(page?.interventions ?? data?.interventions ?? [])
            .filter((i) => i.agentId === agent?.id)
            .map((item) => (
              <InterventionCard
                key={item.id}
                hasInlineTool={visibleEvents.some(
                  (event) =>
                    event.runId === item.runId &&
                    isToolActivity(event) &&
                    event.data.name ===
                      (item.kind === "sudo"
                        ? "request_sudo"
                        : "request_browser_login"),
                )}
                item={
                  data?.interventions.find(
                    (current) => current.id === item.id,
                  ) ?? item
                }
                onComputer={() => setComputerOpen(item.agentId)}
                onChange={() => void refresh.current()}
              />
            ))}
          {agent &&
            (data?.pendingMessages ?? [])
              .filter((message) => message.agentId === agent.id)
              .map((message) => (
                <article
                  className="message from-user pending-message"
                  key={message.id}
                >
                  <div className="bubble">{message.text}</div>
                  <div className="message-delivery">
                    <span role="status">
                      {message.mode === "queue"
                        ? "Queued"
                        : "Steer · waiting for the next interruption point"}
                    </span>
                    {message.mode === "queue" && (
                      <button
                        type="button"
                        onClick={() => void steerMessage(message.id)}
                        disabled={
                          !connected || !connectionReady || !!steering || stopping === agent.id
                        }
                      >
                        {steering === message.id ? "Steering…" : "Steer now"}
                      </button>
                    )}
                  </div>
                </article>
              ))}
        </div>
        {agent && selectionReady && scrolledUp && (
          <button className="jump-to-bottom" type="button" aria-label="Jump to bottom" title="Jump to bottom" onClick={jumpToBottom}>
            <ArrowDown size={20} aria-hidden="true" />
          </button>
        )}
        <div className="composer-wrap">
          {data && !connectionReady && (
            <div className="connection-required" role="status">
              <span>{data.config.notice}</span>
              <button type="button" onClick={() => setModal("settings")}>
                Connect an account
              </button>
            </div>
          )}
          {actionError && (
            <p role="alert" className="error-text">
              {actionError}
            </p>
          )}
          {agent?.archivedAt && (
            <div className="archived-notice">
              <span>
                This agent is archived. Its profile and history are preserved.
              </span>
              <button
                onClick={() => void archive(false)}
                disabled={archiving || !connected}
              >
                Restore agent
              </button>
            </div>
          )}
          <form
            className={`composer ${running ? "has-delivery-options" : ""}`}
            onSubmit={send}
          >
            <div className="composer-input">
            <textarea
              ref={composerInput}
              rows={1}
              aria-label={`Message ${agent?.name ?? "agent"}`}
              placeholder=" "
              maxLength={24000}
              value={draft}
              disabled={!agent || !selectionReady || !!agent.archivedAt}
              onChange={(e) => {
                if (agent)
                  setDrafts((d) => ({ ...d, [agent.id]: e.target.value }));
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  !window.matchMedia("(pointer: coarse)").matches
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <span className="composer-placeholder" aria-hidden="true">
              Message {agent?.name ?? "your agent"}…
            </span>
            </div>
            <div className="composer-footer">
              <button
                type="button"
                className="icon composer-upload"
                aria-label="Upload file"
                title="Upload file"
                aria-haspopup="dialog"
                disabled={
                  !agent || !selectionReady || !connected || !!agent.archivedAt
                }
                onClick={() => agent && setUploadTarget(agent)}
              >
                <Plus size={20} aria-hidden="true" />
              </button>
              <span>
                {running
                  ? messageMode === "queue"
                    ? "Send after this run finishes"
                    : "Guide the current run at its next interruption point"
                  : "Enter to send · Shift + Enter for a new line"}
              </span>
              {agent && data && (
                <ComposerSettings
                  key={agent.id}
                  agentId={agent.id}
                  model={agent.model ?? data.config.selectedModel}
                  effort={agent.effort ?? "high"}
                  readOnly={agent.model == null || agent.effort == null}
                  disabled={!connected || sending || savingModel}
                  refresh={() => refresh.current()}
                  onBusy={setSavingModel}
                />
              )}
              {running && (
                <select
                  className="message-mode"
                  aria-label="Message delivery"
                  value={messageMode}
                  onChange={(e) =>
                    setMessageMode(e.target.value as MessageMode)
                  }
                  disabled={sending}
                >
                  <option value="queue">Queued</option>
                  <option value="steer">Steer</option>
                </select>
              )}
              {running && (
                <button
                  type="button"
                  className="send stop"
                  aria-label="Stop agent"
                  disabled={stopping === agent?.id}
                  onClick={stop}
                >
                  <Square size={15} fill="currentColor" />
                </button>
              )}
              <button
                className="send"
                aria-label={
                  running
                    ? messageMode === "queue"
                      ? "Queue message"
                      : "Steer agent"
                    : "Send message"
                }
                disabled={!canSend}
              >
                {sending ? (
                  <LoaderCircle size={19} className="spin" />
                ) : (
                  <ArrowUp size={22} />
                )}
              </button>
            </div>
          </form>
        </div>
      </main>
      {(projectModal === "create" ||
        (projectModal === "edit" && currentProject)) &&
        data && (
          <ProjectForm
            project={projectModal === "edit" ? currentProject : undefined}
            instance={data.instance.name}
            count={data.agents.filter((a) => belongs(a, scope)).length}
            onClose={() => setProjectModal(null)}
            onSaved={(p) => {
              setData((d) =>
                d
                  ? {
                      ...d,
                      projects: [...d.projects.filter((x) => x.id !== p.id), p],
                    }
                  : d,
              );
              openProject(p.id);
            }}
            onDeleted={backToProjects}
          />
        )}
      {(projectModal === "move" || projectModal === "add") && data && (
        <MoveAgent
          agent={
            projectModal === "move" ? (moveTarget ?? undefined) : undefined
          }
          agents={data.agents}
          projects={projects}
          targetProject={currentProject?.id}
          onClose={() => setProjectModal(null)}
          onMoved={(a) => {
            switchScope(
              scope.kind === "all"
                ? scope
                : a.projectId
                  ? { kind: "project", projectId: a.projectId }
                  : { kind: "ungrouped" },
              a.id,
            );
            setAnnouncement(`${a.name} moved. Working directory unchanged.`);
          }}
        />
      )}
      {computerOpen && agent?.id === computerOpen && (
        <ComputerPanel
          key={computerOpen}
          agentId={computerOpen}
          onClose={() => setComputerOpen(null)}
          onChange={() => void refresh.current()}
        />
      )}
      {uploadTarget && data && (
        <UploadFiles
          agent={uploadTarget}
          instance={data.instance.name}
          onClose={() => setUploadTarget(null)}
          onUploaded={(name) => {
            const id = uploadTarget.id;
            setDrafts((drafts) => {
              const current = drafts[id] ?? "";
              return {
                ...drafts,
                [id]: `${current}${current && !/\s$/.test(current) ? " " : ""}${name}`,
              };
            });
          }}
        />
      )}
      {modal === "profile" && agent && (
        <Profile
          key={agent.id}
          agent={agent}
          projects={projects}
          disabled={!connected || !!running}
          onClose={() => setModal(null)}
          onSave={() => {
            setModal(null);
            void refresh.current();
          }}
        />
      )}
      {modal === "options" && agent && (
        <AgentDetails
          agent={agent}
          projects={projects}
          connected={connected}
          running={running}
          archiving={archiving}
          refreshing={refreshing}
          canCompact={!!connectionReady}
          onFreshSession={() => void freshSession()}
          onClose={() => setModal(null)}
          onUpload={() => {
            setUploadTarget(agent);
            setModal(null);
          }}
          onComputer={() => {
            setModal(null);
            setComputerOpen(agent?.id ?? null);
          }}
          onMove={() => {
            setModal(null);
            setMoveTarget(agent);
            setProjectModal("move");
          }}
          onArchive={() => {
            setModal(null);
            void archive(!agent.archivedAt);
          }}
          onSaved={() => void refresh.current()}
        />
      )}
      {modal === "archived" && (
        <ArchivedAgents
          key={scopeKey(scope)}
          scope={scope}
          onClose={() => setModal(null)}
          onSelect={(id) => {
            select(id);
            setModal(null);
          }}
        />
      )}
      {modal === "settings" && data && (
        <Settings
          data={data}
          theme={theme}
          setTheme={setTheme}
          onClose={() => setModal(null)}
          refresh={() => refresh.current()}
        />
      )}
    </div>
  );
}
