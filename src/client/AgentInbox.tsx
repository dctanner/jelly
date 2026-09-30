import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Avatar } from "./Avatar";
import { AgentListMenu } from "./AgentListMenu";
import { Modal } from "./Modal";
import { sortAgentsByResponse } from "./agent-order";
import type { AgentRecord, ProjectRecord, Snapshot } from "../shared/types";

const attention = (agent: AgentRecord) =>
  ["waiting", "error", "interrupted"].includes(agent.status);
const time = (value?: string) => Date.parse(value ?? "") || 0;
type Entry =
  { agent: AgentRecord } | { project: ProjectRecord; members: AgentRecord[] };

export function AgentInbox({
  data,
  projectId,
  selectedId,
  unread,
  connected,
  visible,
  dark,
  onProject,
  onBack,
  onAgent,
  onArchived,
  onSettings,
  onToggleTheme,
  onNewProject,
  onManageProject,
  onAddAgent,
  previewTime,
  previewText,
}: {
  data: Snapshot | null;
  projectId?: string;
  selectedId?: string;
  unread: Set<string>;
  connected: boolean;
  visible: boolean;
  dark: boolean;
  onProject: (id: string) => void;
  onBack: () => void;
  onAgent: (id: string) => void;
  onArchived: () => void;
  onSettings: () => void;
  onToggleTheme: () => void;
  onNewProject: () => void;
  onManageProject: () => void;
  onAddAgent: () => void;
  previewTime: (value: string) => string;
  previewText: (value: string) => string;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const lastProject = useRef(projectId);
  if (projectId) lastProject.current = projectId;
  const project = data?.projects.find(
    (p) => p.id === (projectId ?? lastProject.current),
  );
  const inProject = !!projectId && !!project;
  const heading = useRef<HTMLHeadingElement>(null);
  const projectList = useRef<HTMLElement>(null);
  const scrolls = useRef(new Map<string, number>());
  const previous = useRef(projectId);
  useLayoutEffect(() => {
    if (previous.current && projectList.current)
      scrolls.current.set(previous.current, projectList.current.scrollTop);
    if (projectId && projectList.current)
      projectList.current.scrollTop = scrolls.current.get(projectId) ?? 0;
    const changed = previous.current !== projectId;
    previous.current = projectId;
    if (!changed || !visible) return;
    const timer = window.setTimeout(() => {
      const title = heading.current;
      const active = document.activeElement;
      // Do not override a menu, search, or row the person used during the slide.
      if (
        !title ||
        title.closest("[inert]") ||
        document.querySelector("dialog[open]") ||
        (active &&
          active !== document.body &&
          active.isConnected &&
          !active.closest("[inert]"))
      )
        return;
      title.focus({ preventScroll: true });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [projectId]);
  useEffect(() => {
    const search = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k" &&
        !event.isComposing
      ) {
        event.preventDefault();
        setQuery("");
        setSearching(true);
      }
    };
    window.addEventListener("keydown", search);
    return () => window.removeEventListener("keydown", search);
  }, []);
  const agents = sortAgentsByResponse(
    data?.agents.filter((a) => !a.archivedAt) ?? [],
    data?.agentPreviews,
    data?.latestAssistantMessages ?? {},
  );
  const groups = (data?.projects ?? []).map((project) => ({
    project,
    members: agents.filter((a) => a.projectId === project.id),
  }));
  const latest = (entry: Entry) =>
    "agent" in entry ? entry.agent : entry.members[0];
  const entries: Entry[] = [
    ...groups,
    ...agents
      .filter(
        (a) =>
          !a.projectId || !data?.projects.some((p) => p.id === a.projectId),
      )
      .map((agent) => ({ agent })),
  ];
  const sort = (rows: Entry[]) =>
    rows.sort((a, b) => {
      const left = latest(a),
        right = latest(b);
      return (
        time(right && data?.agentPreviews?.[right.id]?.createdAt) -
          time(left && data?.agentPreviews?.[left.id]?.createdAt) ||
        (right ? (data?.latestAssistantMessages[right.id] ?? 0) : 0) -
          (left ? (data?.latestAssistantMessages[left.id] ?? 0) : 0)
      );
    });
  sort(entries);
  const members =
    groups.find((g) => g.project.id === project?.id)?.members ?? [];
  const searchRows: Entry[] = inProject
    ? members.map((agent) => ({ agent }))
    : sort([...groups, ...agents.map((agent) => ({ agent }))]);
  const results = searchRows.filter((entry) =>
    ("agent" in entry ? entry.agent.name : entry.project.name)
      .toLowerCase()
      .includes(query.toLowerCase().trim()),
  );
  const openAgent = (id: string) => {
    setSearching(false);
    onAgent(id);
  };
  const openProject = (id: string) => {
    setSearching(false);
    onProject(id);
  };
  function agentRow(a: AgentRecord) {
    const preview = data?.agentPreviews?.[a.id];
    return (
      <button
        key={a.id}
        className={`agent-row ${a.id === selectedId ? "selected" : ""}`}
        onClick={() => openAgent(a.id)}
        aria-current={a.id === selectedId ? "page" : undefined}
        title={`${a.name} · ${a.status}`}
      >
        <span
          className={`agent-avatar${a.status === "running" ? " is-working" : a.status === "waiting" ? " is-waiting" : ""}`}
          aria-hidden="true"
        >
          <Avatar agent={a} working={a.status === "running"} />
        </span>
        <span className="agent-row-copy">
          <span className="agent-row-heading">
            <strong>{a.name}</strong>
            {a.status === "running" ? (
              <span className="agent-row-status work-status-sheen">
                Working
              </span>
            ) : a.status === "waiting" ? (
              <span className="agent-row-status">Needs you</span>
            ) : preview ? (
              <time dateTime={preview.createdAt}>
                {previewTime(preview.createdAt)}
              </time>
            ) : null}
          </span>
          <small className={`agent-preview${a.status === "running" ? " is-thinking" : ""}`}>
            {a.status === "running"
              ? (data?.agentActivity?.[a.id] ?? "Thinking…")
              : a.status === "waiting"
                ? "Waiting for your help…"
                : preview
                  ? previewText(preview.text)
                  : "Start a conversation"}
          </small>
        </span>
        <Indicator needsAttention={attention(a)} unread={unread.has(a.id)} />
      </button>
    );
  }
  function row(entry: Entry) {
    return "agent" in entry ? (
      agentRow(entry.agent)
    ) : (
      <ProjectRow
        key={entry.project.id}
        project={entry.project}
        members={entry.members}
        unread={unread}
        onClick={() => openProject(entry.project.id)}
      />
    );
  }
  return (
    <>
      <div className="inbox-toolbar">
        {inProject ? (
          <button
            className="inbox-back"
            onClick={onBack}
            aria-label="Back to all agents"
          >
            <ChevronLeft size={22} aria-hidden="true" />
            <span>Back</span>
          </button>
        ) : (
          <span />
        )}
        <h1
          ref={heading}
          tabIndex={-1}
          title={inProject ? project.name : "Agents"}
        >
          {inProject ? project.name : "Agents"}
        </h1>
        <AgentListMenu
          disabled={!data}
          archivedDisabled={!connected}
          visible={visible}
          dark={dark}
          onSearch={() => {
            setQuery("");
            setSearching(true);
          }}
          onNewProject={onNewProject}
          onManageProject={inProject ? onManageProject : undefined}
          onAddAgent={inProject ? onAddAgent : undefined}
          onArchived={onArchived}
          onSettings={onSettings}
          onToggleTheme={onToggleTheme}
        />
      </div>
      <div className={`inbox-stack${inProject ? " in-project" : ""}`}>
        <nav
          className="inbox-pane inbox-root"
          aria-label="Projects and agents"
          inert={inProject}
          aria-hidden={inProject}
        >
          {entries.map(row)}
          {data && !entries.length && (
            <p className="subtle empty-agents">
              No agents here yet. Create one to get started.
            </p>
          )}
        </nav>
        <nav
          ref={projectList}
          className="inbox-pane inbox-project"
          aria-label={`${project?.name ?? "Project"} agents`}
          inert={!inProject}
          aria-hidden={!inProject}
        >
          {members.map(agentRow)}
          {!members.length && (
            <div className="subtle empty-agents">
              <p>No agents here yet. Create one to get started.</p>
              <button className="secondary wide" onClick={onAddAgent}>
                Add existing agent
              </button>
            </div>
          )}
        </nav>
      </div>
      {searching && (
        <Modal title="Search" onClose={() => setSearching(false)}>
          <div className="inbox-search">
            <Search size={18} aria-hidden="true" />
            <input
              autoFocus
              aria-label="Find an agent"
              placeholder={
                inProject
                  ? `Search ${project.name}`
                  : "Search agents and projects"
              }
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="inbox-search-results">
            {results.map(row)}
            {!results.length && (
              <p className="subtle">No matching agents or projects.</p>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
function Indicator({
  needsAttention,
  unread,
}: {
  needsAttention: boolean;
  unread: boolean;
}) {
  return needsAttention ? (
    <i
      className="status-dot agent-indicator attention"
      role="img"
      aria-label="Needs attention"
      title="Needs attention"
    />
  ) : unread ? (
    <i
      className="status-dot agent-indicator unread"
      role="img"
      aria-label="Unread messages"
      title="Unread messages"
    />
  ) : null;
}
function ProjectRow({
  project,
  members,
  unread,
  onClick,
}: {
  project: ProjectRecord;
  members: AgentRecord[];
  unread: Set<string>;
  onClick: () => void;
}) {
  const id = useId();
  const needs = members.filter(attention).length;
  const working = members.filter((a) => a.status === "running").length;
  const subtitle = needs
    ? `${needs} ${needs === 1 ? "agent needs" : "agents need"} attention`
    : working
      ? `${working} ${working === 1 ? "agent" : "agents"} working`
      : `${members.length} ${members.length === 1 ? "agent" : "agents"}`;
  const avatars = members
    .slice(0, 3)
    .map((a) => ({ name: a.name, color: a.color, avatarId: a.avatarId }));
  while (avatars.length < 3)
    avatars.push({ name: "Project", color: "", avatarId: "jellyfish" });
  return (
    <button
      className="agent-row project-row"
      data-project-id={project.id}
      onClick={onClick}
      aria-label={`Open project ${project.name}`}
      aria-describedby={id}
    >
      <span className="project-avatars" aria-hidden="true">
        {avatars.map((a, i) =>
          i === 2 ? (
            <span
              key={i}
              className={`agent-avatar project-avatar-front${working ? " is-working" : ""}`}
            >
              <Avatar agent={a} />
            </span>
          ) : (
            <Avatar key={i} agent={a} />
          ),
        )}
      </span>
      <span className="agent-row-copy">
        <span className="agent-row-heading">
          <strong>{project.name}</strong>
        </span>
        <small id={id} className="agent-preview">
          {subtitle}
        </small>
      </span>
      <Indicator
        needsAttention={needs > 0}
        unread={members.some((a) => unread.has(a.id))}
      />
      <ChevronRight className="project-chevron" size={17} aria-hidden="true" />
    </button>
  );
}
