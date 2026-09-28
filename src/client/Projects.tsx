import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Folder,
  ChevronDown,
  ChevronRight,
  ArrowLeft,
  Plus,
  Check,
  Settings2,
  Home,
} from "lucide-react";
import type { ProjectRecord, AgentRecord } from "../shared/types";
import { projectApi as api } from "./api";
import { Modal } from "./Modal";
import { belongs, scopeKey, scopeName, type Scope } from "./project-state";
export function ProjectButton({
  scope,
  projects,
  onClick,
  className = "",
}: {
  scope: Scope;
  projects: ProjectRecord[];
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      className={`project-trigger ${className}`}
      onClick={onClick}
      aria-haspopup="dialog"
    >
      <Folder size={18} />
      <span>{scopeName(scope, projects)}</span>
      <ChevronDown size={16} />
    </button>
  );
}
export function ProjectSwitcher({
  scope,
  projects,
  agents,
  recent,
  onSelect,
  onClose,
  onCreate,
  onManage,
  keyboard = false,
}: {
  scope: Scope;
  projects: ProjectRecord[];
  agents: AgentRecord[];
  recent: string[];
  onSelect: (s: Scope) => void;
  onClose: () => void;
  onCreate: () => void;
  onManage: () => void;
  keyboard?: boolean;
}) {
  const [search, setSearch] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (keyboard) searchInput.current?.focus();
  }, [keyboard]);
  const list = useRef<HTMLDivElement>(null);
  const scopes: Scope[] = [
    { kind: "all" },
    { kind: "ungrouped" },
    ...projects
      .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => {
        const ai = recent.indexOf(a.id),
          bi = recent.indexOf(b.id);
        return (
          (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) ||
          a.name.localeCompare(b.name)
        );
      })
      .map((p) => ({ kind: "project" as const, projectId: p.id })),
  ];
  return (
    <Modal
      title="Switch project"
      onClose={onClose}
      kind="dropdown"
      className="project-switcher"
    >
      <input
        ref={searchInput}
        className="project-search"
        aria-label="Find a project"
        placeholder="Find a project…"
        autoFocus={keyboard}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            list.current?.querySelector("button")?.focus();
          }
        }}
      />
      <div
        ref={list}
        className="project-options"
        onKeyDown={(e) => {
          if (
            !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) ||
            e.nativeEvent.isComposing
          )
            return;
          const buttons = [...list.current!.querySelectorAll("button")],
            i = buttons.indexOf(document.activeElement as HTMLButtonElement);
          e.preventDefault();
          buttons[
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? buttons.length - 1
                : (i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                  buttons.length
          ]?.focus();
        }}
      >
        {scopes.map((s) => {
          const members = agents.filter((a) => !a.archivedAt && belongs(a, s)),
            working = members.filter((a) => a.status === "running").length,
            waiting = members.filter((a) => a.status === "waiting").length;
          return (
            <button
              key={scopeKey(s)}
              className="project-option"
              aria-current={
                scopeKey(s) === scopeKey(scope) ? "true" : undefined
              }
              onClick={() => onSelect(s)}
            >
              <Folder size={18} />
              <span>
                <strong>{scopeName(s, projects)}</strong>
                {(working > 0 || waiting > 0) && (
                  <small>
                    {working > 0 ? `${working} working` : ""}
                    {working > 0 && waiting > 0 ? " · " : ""}
                    {waiting > 0 ? `${waiting} need you` : ""}
                  </small>
                )}
              </span>
              <small>{members.length}</small>
              {scopeKey(s) === scopeKey(scope) && <Check size={16} />}
            </button>
          );
        })}
      </div>
      <div className="project-footer">
        <button onClick={onCreate}>
          <Plus size={17} />
          New project
        </button>
        {scope.kind === "project" && (
          <button onClick={onManage}>
            <Settings2 size={17} />
            Project settings
          </button>
        )}
      </div>
    </Modal>
  );
}
interface DirectoryPage {
  path: string;
  home: string;
  parent: string | null;
  entries: { name: string; path: string; available: boolean }[];
  cursor: string | null;
}
export function DirectoryPicker({
  initial,
  instance,
  onClose,
  onChoose,
}: {
  initial?: string;
  instance: string;
  onClose: () => void;
  onChoose: (path: string) => void;
}) {
  const [path, setPath] = useState(initial),
    [hidden, setHidden] = useState(false),
    [data, setData] = useState<DirectoryPage | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const focusNext = useRef(false);
  const folderList = useRef<HTMLDivElement>(null);
  const useFolder = useRef<HTMLButtonElement>(null);
  const navigate = (next: string | undefined) => {
    focusNext.current = true;
    setPath(next);
  };
  useEffect(() => {
    if (!busy && focusNext.current) {
      focusNext.current = false;
      (
        folderList.current?.querySelector<HTMLButtonElement>(
          "button:not(:disabled)",
        ) ?? useFolder.current
      )?.focus();
    }
  }, [data, busy]);
  useEffect(() => {
    const controller = new AbortController();
    const token = ++generation.current;
    setBusy(true);
    setError("");
    setData(null);
    api<DirectoryPage>(
      `/directories?hidden=${hidden}${path ? `&path=${encodeURIComponent(path)}` : ""}`,
      { signal: controller.signal },
    )
      .then((d) => {
        if (token === generation.current && !controller.signal.aborted)
          setData(d);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [path, hidden, retry]);
  async function more() {
    if (!data?.cursor) return;
    const token = generation.current;
    setBusy(true);
    try {
      const next = await api<DirectoryPage>(
        `/directories?path=${encodeURIComponent(data.path)}&hidden=${hidden}&cursor=${encodeURIComponent(data.cursor)}`,
      );
      if (token === generation.current)
        setData({ ...next, entries: [...data.entries, ...next.entries] });
    } catch (e) {
      if (token === generation.current) setError((e as Error).message);
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  return (
    <Modal title="Choose a folder" onClose={onClose} className="folder-picker">
      <p className="subtle">
        Folders on <strong>{instance}</strong> · Jelly server
      </p>
      <div className="folder-navigation">
        <button aria-label="Home folder" onClick={() => navigate(undefined)}>
          <Home size={18} />
        </button>
        <button
          aria-label="Parent folder"
          disabled={!path && !data?.parent}
          onClick={() =>
            navigate(
              data?.parent ?? (path?.slice(0, path.lastIndexOf("/")) || "/"),
            )
          }
        >
          <ArrowLeft size={18} />
        </button>
        <div className="breadcrumbs">
          {(data?.path ?? path ?? "Home").split("/").map((part, i, parts) => (
            <button
              key={i}
              onClick={() => navigate(parts.slice(0, i + 1).join("/") || "/")}
            >
              {part || "/"}
              {part && <ChevronRight size={12} />}
            </button>
          ))}
        </div>
      </div>
      <label className="hidden-folders">
        <input
          type="checkbox"
          checked={hidden}
          onChange={(e) => setHidden(e.target.checked)}
        />
        Show hidden folders
      </label>
      <div className="folder-list" ref={folderList}>
        {busy && !data && <p role="status">Loading folders…</p>}
        {error && (
          <p className="error-text" role="alert">
            {error}{" "}
            <button onClick={() => setRetry((v) => v + 1)}>Retry</button>
          </p>
        )}
        {data?.entries.map((e) => (
          <button
            className="folder-row"
            key={e.name}
            disabled={!e.available || busy}
            onClick={() => navigate(e.path)}
          >
            <Folder size={19} />
            <span>{e.name}</span>
            {e.available ? (
              <ChevronRight size={17} />
            ) : (
              <small>Unavailable</small>
            )}
          </button>
        ))}
        {data && !data.entries.length && !busy && (
          <p className="subtle">No subfolders. You can use this folder.</p>
        )}
        {data?.cursor && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void more()}
          >
            Load more folders
          </button>
        )}
      </div>
      <div className="folder-confirm">
        <code className="directory-path">
          {data?.path ?? path ?? "Select a folder"}
        </code>
        <button
          className="primary wide"
          disabled={busy || !!error || !data}
          ref={useFolder}
          onClick={() => data && onChoose(data.path)}
        >
          Use this folder
        </button>
      </div>
    </Modal>
  );
}
export function ProjectForm({
  project,
  instance,
  count,
  onClose,
  onSaved,
  onDeleted,
}: {
  project?: ProjectRecord;
  instance: string;
  count: number;
  onClose: () => void;
  onSaved: (p: ProjectRecord) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(project?.name ?? ""),
    [cwd, setCwd] = useState(project?.defaultCwd ?? ""),
    [picker, setPicker] = useState(false),
    [deleting, setDeleting] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSaved(
        await api<ProjectRecord>(
          project ? `/projects/${project.id}` : "/projects",
          {
            method: project ? "PATCH" : "POST",
            body: JSON.stringify({ name, defaultCwd: cwd }),
          },
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await api(`/projects/${project!.id}`, { method: "DELETE" });
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (picker)
    return (
      <DirectoryPicker
        initial={cwd || undefined}
        instance={instance}
        onClose={() => setPicker(false)}
        onChoose={(p) => {
          setCwd(p);
          setPicker(false);
        }}
      />
    );
  return (
    <Modal
      title={
        deleting
          ? "Delete project?"
          : project
            ? "Project settings"
            : "New project"
      }
      onClose={onClose}
    >
      {deleting ? (
        <>
          <p>
            Delete <strong>{project?.name}</strong>? {count} active agent
            {count === 1 ? "" : "s"} and any archived agents will move to
            Ungrouped. Conversations, files, and working directories stay
            unchanged.
          </p>
          <div className="dialog-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setDeleting(false)}
            >
              Keep project
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              Delete project
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={save}>
          <p className="subtle">
            An optional space to keep related agents together.
          </p>
          <label>
            Project name
            <input
              autoFocus
              required
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Website"
            />
          </label>
          <label>
            Default working directory
            <code className="directory-path">
              {cwd || "No folder selected"}
            </code>
          </label>
          <button
            className="secondary"
            type="button"
            onClick={() => setPicker(true)}
          >
            <Folder size={17} />
            {cwd ? "Change folder…" : "Choose folder…"}
          </button>
          <p className="subtle folder-hint">
            Used by new agents. Existing agents keep their working directories.
            This is a folder on the Jelly server.
          </p>
          <button
            className="primary wide"
            disabled={busy || !name.trim() || !cwd}
          >
            {busy ? "Saving…" : project ? "Save project" : "Create project"}
          </button>
          {project && (
            <button
              type="button"
              className="delete-project"
              onClick={() => setDeleting(true)}
            >
              Delete project…
            </button>
          )}
        </form>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
export function MoveAgent({
  agent,
  agents,
  projects,
  targetProject,
  onClose,
  onMoved,
}: {
  agent?: AgentRecord;
  agents: AgentRecord[];
  projects: ProjectRecord[];
  targetProject?: string;
  onClose: () => void;
  onMoved: (a: AgentRecord) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function move(a: AgentRecord, id: string | null) {
    setBusy(true);
    try {
      onMoved(
        await api<AgentRecord>(`/agents/${a.id}/project`, {
          method: "PATCH",
          body: JSON.stringify({ projectId: id }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={agent ? "Move to project" : "Add an existing agent"}
      onClose={onClose}
    >
      <p className="subtle">
        The agent keeps its conversation and working directory.
      </p>
      {agent ? (
        <>
          <code className="directory-path">{agent.cwd}</code>
          {[{ id: "", name: "Ungrouped" }, ...projects].map((p) => (
            <button
              disabled={busy}
              className="project-option"
              key={p.id}
              onClick={() => void move(agent, p.id || null)}
            >
              <Folder size={18} />
              {p.name}
              {(agent.projectId ?? "") === p.id && <Check size={16} />}
            </button>
          ))}
        </>
      ) : (
        agents
          .filter((a) => !a.archivedAt && a.projectId !== targetProject)
          .map((a) => (
            <button
              className="project-option"
              disabled={busy}
              key={a.id}
              onClick={() => void move(a, targetProject ?? null)}
            >
              {a.name}
              <small>{projects.find((p) => p.id === a.projectId)?.name ?? "Ungrouped"}</small>
            </button>
          ))
      )}
      {!agent &&
        !agents.some((a) => !a.archivedAt && a.projectId !== targetProject) && (
          <p>No other agents to add.</p>
        )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </Modal>
  );
}
