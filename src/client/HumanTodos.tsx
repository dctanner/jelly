import { useEffect, useRef, useState } from "react";
import {
  Check,
  CircleCheck,
  KeyRound,
  ListTodo,
  Plus,
  Search,
  X,
} from "lucide-react";
import type { AgentRecord, Snapshot } from "../shared/types";
import type {
  HumanTodo,
  HumanTodoDetail,
  HumanTodoSummary,
  HumanTodosPage,
} from "../shared/human-todos";
import { api, control } from "./api";
import { requestId } from "./request-id";
import { Modal } from "./Modal";
import { GoalsPanel } from "./Goals";
import { Avatar } from "./Avatar";
import "./HumanTodos.css";

function creationAge(value: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 60000),
  );
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}
const path = (id: string) => `/human-todos/${encodeURIComponent(id)}`;
export function openTodo(id: string | null) {
  window.history.pushState(
    {},
    "",
    id ? `/todos/${encodeURIComponent(id)}` : "/todos",
  );
  window.dispatchEvent(new window.PopStateEvent("popstate"));
}
export function openTodoAgent(id: string, activity?: number | null) {
  window.history.pushState(
    { jellyAgent: id, jellyChat: true },
    "",
    `/agents/${encodeURIComponent(id)}${activity ? `?activity=${activity}` : ""}`,
  );
  window.dispatchEvent(new window.PopStateEvent("popstate"));
}
function changed() {
  window.dispatchEvent(new window.CustomEvent("jelly:todos-updated"));
}
function useTodoRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const update = () => setRevision((value) => value + 1);
    window.addEventListener("jelly:todos-updated", update);
    return () => window.removeEventListener("jelly:todos-updated", update);
  }, []);
  return revision;
}
function linkedAgent(todo: HumanTodoSummary, agents: AgentRecord[]) {
  return agents.find((agent) => agent.id === todo.agentId);
}

/** Active agents for pickers, most recently active first (server order). */
function pickableAgents(agents: AgentRecord[], keep?: string | null) {
  return agents.filter((agent) => !agent.archivedAt || agent.id === keep);
}
const handoffLabel = (kind: string) =>
  kind === "sudo"
    ? "Approve an admin command"
    : kind === "browser_login"
      ? "Sign in to a website"
      : kind === "browser_recovery"
        ? "Recover the browser"
        : "Take back the desktop";

/** Mounted independently of destination visibility so filters and list scroll survive navigation. */
export function HumanTodos({
  snapshot,
  active,
  agentId,
  todoId,
}: {
  snapshot: Snapshot | null;
  active: boolean;
  agentId?: string;
  todoId?: string | null;
}) {
  const [page, setPage] = useState<HumanTodosPage | null>(null);
  const [status, setStatus] = useState<"open" | "history">("open"),
    [q, setQ] = useState(""),
    [filterAgent, setFilterAgent] = useState("");
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [editing, setEditing] = useState<string | null>(null);
  const revision = useTodoRevision(),
    generation = useRef(0),
    request = useRef<AbortController | null>(null);
  const listKey = `${status}:${q}:${agentId ?? filterAgent}`;
  const currentKey = useRef(listKey);
  currentKey.current = listKey;
  const focusAfterDone = useRef<string | null>(null);
  const pagesWanted = useRef(1),
    loadedKey = useRef(listKey);
  const list = useRef<HTMLElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  async function load(after?: string) {
    const number = ++generation.current,
      key = listKey;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      if (loadedKey.current !== key) {
        pagesWanted.current = 1;
        loadedKey.current = key;
      }
      const params = new URLSearchParams({
        status,
        ...(q ? { q } : {}),
        ...((agentId ?? filterAgent)
          ? { agentId: agentId ?? filterAgent }
          : {}),
        ...(after ? { after } : {}),
      });
      let next = await api<HumanTodosPage>(`/human-todos?${params}`, {
        signal: controller.signal,
      });
      // Refresh every loaded cursor page, not just page one, after SSE/reconnect.
      if (!after)
        for (
          let index = 1;
          index < pagesWanted.current && next.after;
          index++
        ) {
          params.set("after", next.after);
          const more = await api<HumanTodosPage>(`/human-todos?${params}`, {
            signal: controller.signal,
          });
          next = {
            ...more,
            items: [
              ...next.items,
              ...more.items.filter(
                (item) => !next.items.some((old) => old.id === item.id),
              ),
            ],
          };
        }
      if (generation.current !== number || currentKey.current !== key) return;
      if (after) pagesWanted.current++;
      setPage((previous) =>
        after && previous
          ? {
              ...next,
              items: [
                ...previous.items,
                ...next.items.filter(
                  (item) => !previous.items.some((old) => old.id === item.id),
                ),
              ],
            }
          : next,
      );
      setError("");
      if (focusAfterDone.current) {
        const id = focusAfterDone.current;
        focusAfterDone.current = null;
        window.requestAnimationFrame(() =>
          (document.getElementById(`todo-${id}`) ?? heading.current)?.focus({
            preventScroll: true,
          }),
        );
      }
    } catch (error) {
      if (!controller.signal.aborted && generation.current === number)
        setError((error as Error).message);
    } finally {
      if (generation.current === number) setLoading(false);
    }
  }
  useEffect(() => {
    if (active) void load();
    return () => {
      generation.current++;
      request.current?.abort();
    };
  }, [active, listKey, revision]);
  useEffect(() => {
    if (active && !agentId) heading.current?.focus({ preventScroll: true });
  }, [active]);
  const selected = todoId ?? editing;
  const [doneRequests] = useState(() => new Map<string, string>());
  async function toggle(todo: HumanTodoSummary) {
    const key = `${todo.id}:${todo.revision}`;
    if (!doneRequests.has(key)) doneRequests.set(key, requestId());
    try {
      if (todo.status === "open")
        await control(path(todo.id) + "/complete", {
          requestId: doneRequests.get(key),
          expectedRevision: todo.revision,
        });
      else
        await api(path(todo.id), {
          method: "PATCH",
          body: JSON.stringify({
            requestId: doneRequests.get(key),
            expectedRevision: todo.revision,
            status: "open",
          }),
        });
      const index = page?.items.findIndex((item) => item.id === todo.id) ?? -1;
      focusAfterDone.current =
        page?.items[index + 1]?.id ?? page?.items[index - 1]?.id ?? "heading";
      changed();
    } catch (error) {
      setError((error as Error).message);
    }
  }
  const select = (id: string) => {
    if (agentId) setEditing(id);
    else openTodo(id);
  };
  const draftKey = `${snapshot?.instance.id ?? "unknown"}:${selected === "new" ? `new:${agentId ?? "unassigned"}` : selected}`;
  const close = () => {
    todoDrafts.delete(draftKey);
    if (todoId) openTodo(null);
    else setEditing(null);
    window.requestAnimationFrame(() => {
      if (document.activeElement === document.body)
        heading.current?.focus({ preventScroll: true });
    });
  };
  const agents = page?.agents ?? snapshot?.agents ?? [];
  const openCount = agentId
    ? (snapshot?.humanTodoCounts?.agents[agentId] ?? 0)
    : (snapshot?.humanTodoCounts?.total ?? page?.counts.total ?? 0);
  const handoffs = status === "open" ? (page?.handoffs ?? []) : [];
  const items =
    page?.items.filter(
      (todo) =>
        status !== "open" || !handoffs.some((item) => item.todoId === todo.id),
    ) ?? [];
  return (
    <section
      className={`human-todos ${agentId ? "agent-todos" : ""}`}
      aria-label={agentId ? "Agent todos" : "Todos"}
      ref={list}
    >
      <div className="todos-content">
        <header className="todos-heading">
          <h1 tabIndex={-1} ref={heading}>
            {agentId ? "Needs you" : "Todos"}
          </h1>
          <button className="todos-add" onClick={() => setEditing("new")}>
            <span>
              <Plus size={17} aria-hidden="true" />
              New todo
            </span>
          </button>
        </header>
        <div className="todo-toolbar">
          <div className="todo-segments" role="group" aria-label="Show">
            {(
              [
                ["open", "To do"],
                ["history", "Completed"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={status === value}
                onClick={() => setStatus(value)}
              >
                {label}
                {value === "open" && openCount > 0 && (
                  <span className="todo-segment-count">{openCount}</span>
                )}
              </button>
            ))}
          </div>
          <label className="todo-search">
            <Search size={17} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search"
              placeholder="Search"
              value={q}
              maxLength={200}
              onChange={(event) => setQ(event.target.value)}
            />
          </label>
          {!agentId && (
            <select
              className="todo-agent-filter"
              aria-label="Agent"
              value={filterAgent}
              onChange={(event) => setFilterAgent(event.target.value)}
            >
              <option value="">All agents</option>
              <option value="unassigned">No agent</option>
              {pickableAgents(agents, filterAgent).map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {error && (
          <p className="todo-error" role="alert">
            {error} <button onClick={() => void load()}>Retry</button>
          </p>
        )}
        {loading && !page && (
          <p className="todo-empty" role="status">
            Loading todos…
          </p>
        )}
        {!!handoffs.length && (
          <section className="todo-group" aria-label="Waiting on you now">
            <h2>Waiting on you now</h2>
            <ul className="todo-list">
              {handoffs.map((item) => {
                const agent = agents.find((a) => a.id === item.agentId);
                return (
                  <li className="todo-row todo-handoff" key={item.id}>
                    <span className="todo-handoff-icon" aria-hidden="true">
                      <KeyRound size={16} />
                    </span>
                    <div className="todo-copy">
                      <strong>{handoffLabel(item.kind)}</strong>
                      <span className="todo-meta">
                        {agent && <Avatar agent={agent} />}
                        {agent?.name ?? "Agent"} ·{" "}
                        {item.status === "executing"
                          ? "In progress"
                          : `Expires ${new Date(item.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
                      </span>
                      {item.todoId && (
                        <button
                          className="todo-link"
                          onClick={() => select(item.todoId!)}
                        >
                          View linked todo
                        </button>
                      )}
                    </div>
                    <button
                      className="todo-pill"
                      onClick={() =>
                        openTodoAgent(item.agentId, item.sourceActivityId)
                      }
                    >
                      Open
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {page && !items.length && !handoffs.length && (
          <div className="todo-empty">
            {q || filterAgent ? (
              <p>No matching todos.</p>
            ) : status === "open" ? (
              <>
                <CircleCheck size={36} aria-hidden="true" />
                <p>Nothing needs you right now.</p>
              </>
            ) : (
              <p>No completed todos yet.</p>
            )}
          </div>
        )}
        {!!items.length && (
          <ul className="todo-list">
            {items.map((todo) => {
              const agent = linkedAgent(todo, agents);
              const settled = todo.status !== "open";
              return (
                <li
                  className="todo-row"
                  data-status={todo.status}
                  key={todo.id}
                >
                  <button
                    className="todo-check"
                    aria-label={
                      settled ? `Reopen: ${todo.title}` : `Done: ${todo.title}`
                    }
                    title={settled ? "Reopen" : "Mark done"}
                    onClick={() => void toggle(todo)}
                  >
                    <span>
                      {todo.status === "done" ? (
                        <Check size={14} strokeWidth={3} />
                      ) : todo.status === "cancelled" ? (
                        <X size={14} strokeWidth={3} />
                      ) : null}
                    </span>
                  </button>
                  <button
                    className="todo-copy"
                    onClick={() => select(todo.id)}
                    id={`todo-${todo.id}`}
                    aria-label={`Open ${todo.title}`}
                  >
                    <strong>{todo.title}</strong>
                    {todo.body && <span className="todo-body">{todo.body}</span>}
                    <span className="todo-meta">
                      {agent ? (
                        <>
                          <Avatar agent={agent} />
                          {agent.name}
                        </>
                      ) : (
                        "No agent"
                      )}
                      <span aria-hidden="true">·</span>
                      {todo.status === "cancelled" ? "Won’t do · " : ""}
                      <time
                        dateTime={todo.resolvedAt ?? todo.createdAt}
                        title={new Date(
                          todo.resolvedAt ?? todo.createdAt,
                        ).toLocaleString()}
                      >
                        {creationAge(todo.resolvedAt ?? todo.createdAt)}
                      </time>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {page?.after && (
          <button
            className="todo-load-more"
            disabled={loading}
            onClick={() => void load(page.after!)}
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
      {active && selected && (
        <TodoEditor
          key={draftKey}
          id={selected}
          draftKey={draftKey}
          agentId={agentId}
          agents={agents}
          onClose={close}
          onNavigate={() => {
            todoDrafts.delete(draftKey);
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

type Draft = Pick<HumanTodo, "title" | "body" | "agentId">;
// In-tab only, scoped to the instance and canonical todo. Browser Back/destination
// changes must not discard a pinned edit; explicit Discard clears it.
const todoDrafts = new Map<
  string,
  {
    draft: Draft;
    base: number | null;
    note: string;
    dirty: boolean;
    retry: Map<string, string>;
  }
>();
const blank = (agentId?: string): Draft => ({
  title: "",
  body: "",
  agentId: agentId ?? null,
});
function TodoEditor({
  draftKey,
  id,
  agentId,
  agents,
  onClose,
  onNavigate,
}: {
  id: string;
  draftKey: string;
  agentId?: string;
  agents: AgentRecord[];
  onClose: () => void;
  onNavigate: () => void;
}) {
  const cached = todoDrafts.get(draftKey);
  const [reviewGoal, setReviewGoal] = useState(false);
  const [detail, setDetail] = useState<HumanTodoDetail | null>(null),
    [draft, setDraft] = useState<Draft>(() => cached?.draft ?? blank(agentId)),
    [base, setBase] = useState<number | null>(() => cached?.base ?? null);
  const [note, setNote] = useState(cached?.note ?? ""),
    [dirty, setDirty] = useState(cached?.dirty ?? false),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const generation = useRef(0),
    busy = useRef(false),
    mounted = useRef(true),
    refreshQueued = useRef(false),
    initialized = useRef(!!cached),
    revision = useTodoRevision();
  const retry = useRef(cached?.retry ?? new Map<string, string>());
  useEffect(() => {
    if (dirty || note)
      todoDrafts.set(draftKey, {
        draft,
        base,
        note,
        dirty,
        retry: retry.current,
      });
    else todoDrafts.delete(draftKey);
  }, [draftKey, draft, base, note, dirty]);
  async function load(reset = false, preserveNote = false, afterMutation = false) {
    if (id === "new") return;
    if (busy.current && !afterMutation) {
      refreshQueued.current = true;
      return;
    }
    refreshQueued.current = false;
    const number = ++generation.current;
    try {
      const next = await api<HumanTodoDetail>(path(id));
      if (number !== generation.current || !mounted.current) return;
      setDetail(next);
      if (!initialized.current || reset) {
        initialized.current = true;
        setDraft(
          Object.fromEntries(
            Object.keys(blank()).map((key) => [
              key,
              next.todo[key as keyof HumanTodo],
            ]),
          ) as Draft,
        );
        setBase(next.todo.revision);
        if (!preserveNote) setNote("");
        setDirty(false);
      }
    } catch (error) {
      if (number === generation.current) setError((error as Error).message);
    }
  }
  useEffect(() => { void load(); }, [id, revision]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  async function mutate(
    action: "save" | "save-note" | "complete" | "continue" | "delete" | "reopen" | "cancel",
    continueAgent = false,
  ) {
    if (busy.current || saving) return;
    // Every action applies to the revision displayed in the pinned editor.
    const expectedRevision = base;
    const data =
      action === "save"
        ? { ...draft, ...(id === "new" ? {} : { expectedRevision }) }
        : {
            expectedRevision,
            ...(action === "complete"
              ? { resolutionNote: note, continueAgent }
              : action === "save-note" ? { resolutionNote: note } : {}),
            ...(["reopen", "cancel"].includes(action)
              ? {
                  status: action === "reopen" ? "open" : "cancelled",
                  resolutionNote: note,
                }
              : {}),
          };
    const key = JSON.stringify([action, data]);
    if (!retry.current.has(key)) retry.current.set(key, requestId());
    busy.current = true;
    generation.current++;
    setSaving(true);
    setError("");
    try {
      const patch =
        (action === "save" && id !== "new") ||
        action === "save-note" ||
        action === "reopen" ||
        action === "cancel";
      const url =
        id === "new" ? "/human-todos" : path(id) + (patch ? "" : `/${action}`);
      await api(url, {
        method: patch ? "PATCH" : "POST",
        body: JSON.stringify({ ...data, requestId: retry.current.get(key) }),
      });
      changed();
      if (!mounted.current) return;
      if (id === "new") onClose();
      else await load(true, action === "save", true);
    } catch (error) {
      if (!mounted.current) return;
      setError((error as Error).message);
      await load(false, false, true);
    } finally {
      busy.current = false;
      if (mounted.current) {
        setSaving(false);
        if (refreshQueued.current) void load();
      }
    }
  }
  const todo = detail?.todo,
    delivery = detail?.delivery;
  const currentDelivery =
    delivery?.completionId === todo?.completionId ? delivery : null;
  const canContinue =
    todo?.agentId &&
    !todo.goalId &&
    !detail?.agent?.archivedAt &&
    currentDelivery?.state !== "admitted";
  if (reviewGoal && todo?.agentId && todo.goalId)
    return (
      <GoalsPanel
        agentId={todo.agentId}
        expectedGoalId={todo.goalId}
        archived={!!detail?.agent?.archivedAt}
        onClose={() => setReviewGoal(false)}
      />
    );
  const isNew = id === "new";
  const locked = dirty || !!note;
  const options = pickableAgents(agents, draft.agentId);
  const resolvedBy =
    todo?.resolutionActor?.kind === "agent"
      ? (agents.find((a) => a.id === (todo.resolutionActor as { agentId: string }).agentId)?.name ?? "an agent")
      : "you";
  return (
    <Modal
      title={isNew ? "New todo" : "Todo"}
      onClose={onClose}
      dirty={dirty || !!note}
      dismissible={!saving}
      focusHeading
      className="todo-sheet"
    >
      <fieldset className="todo-editor" data-open-todo-id={id} disabled={saving}>
        {error && (
          <p className="todo-error" role="alert">
            {error}{" "}
            <button type="button" onClick={() => void load()}>
              Refresh
            </button>
          </p>
        )}
        {!isNew && !detail ? (
          <p className="todo-empty">Loading todo…</p>
        ) : todo?.deletedAt ? (
          <p className="todo-banner">This todo was deleted.</p>
        ) : (
          <>
            {todo && todo.status !== "open" && (
              <p className="todo-banner" data-status={todo.status}>
                {todo.status === "done" ? (
                  <Check size={16} aria-hidden="true" />
                ) : (
                  <X size={16} aria-hidden="true" />
                )}
                <span>
                  {todo.status === "done" ? "Done" : "Won’t do"} · marked by{" "}
                  {resolvedBy}
                  {todo.resolvedAt
                    ? ` ${creationAge(todo.resolvedAt).toLowerCase()}`
                    : ""}
                </span>
              </p>
            )}
            {base !== null && todo && base !== todo.revision && (
              <p className="todo-banner" role="status">
                <span>Someone else changed this todo while you were editing.</span>
                <button type="button" onClick={() => void load(true)}>
                  Discard my edits
                </button>
              </p>
            )}
            <form
              className="todo-form"
              onSubmit={(event) => {
                event.preventDefault();
                void mutate("save");
              }}
            >
              <input
                className="todo-title-input"
                required
                aria-label="Title"
                placeholder="What needs doing?"
                maxLength={160}
                value={draft.title}
                aria-describedby="todo-privacy"
                onChange={(event) => {
                  setDraft({ ...draft, title: event.target.value });
                  setDirty(true);
                }}
              />
              <textarea
                className="todo-body-input"
                aria-label="Details"
                placeholder="Add details"
                maxLength={8000}
                value={draft.body}
                aria-describedby="todo-privacy"
                onChange={(event) => {
                  setDraft({ ...draft, body: event.target.value });
                  setDirty(true);
                }}
              />
              <label className="todo-agent-field">
                <span aria-hidden="true">Agent</span>
                <span className="todo-agent-select">
                  {(() => {
                    const current = agents.find((a) => a.id === draft.agentId);
                    return current ? <Avatar agent={current} /> : null;
                  })()}
                  <select
                    aria-label="Assigned agent"
                    value={draft.agentId ?? ""}
                    onChange={(event) => {
                      setDraft({ ...draft, agentId: event.target.value || null });
                      setDirty(true);
                    }}
                  >
                    <option value="">No agent</option>
                    {options.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                        {agent.archivedAt ? " (archived)" : ""}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
              <p className="todo-hint" id="todo-privacy">
                The assigned agent can read this. Don’t include passwords or
                codes.
              </p>
              {(isNew || dirty) && (
                <div className="todo-actions">
                  {!isNew && (
                    <button type="button" onClick={() => void load(true)}>
                      Revert
                    </button>
                  )}
                  <button
                    type="submit"
                    className="primary"
                    disabled={saving || !draft.title.trim()}
                  >
                    {isNew ? "Add todo" : "Save changes"}
                  </button>
                </div>
              )}
            </form>
            {todo && (
              <section className="todo-resolve" aria-label="Resolution">
                {todo.resolutionNote && (
                  <p className="todo-note">{todo.resolutionNote}</p>
                )}
                {todo.status !== "cancelled" && (
                  <textarea
                    className="todo-note-input"
                    aria-label="Note"
                    placeholder={
                      todo.status === "open"
                        ? "Add a note for the agent (optional)"
                        : "Update the note (optional)"
                    }
                    value={note}
                    maxLength={4000}
                    aria-describedby="todo-privacy"
                    onChange={(event) => setNote(event.target.value)}
                  />
                )}
                {dirty && (
                  <p className="todo-hint">Save or revert your edits first.</p>
                )}
                <div className="todo-actions">
                  {todo.status === "open" ? (
                    <>
                      <button
                        type="button"
                        disabled={saving || dirty}
                        onClick={() => void mutate("cancel")}
                      >
                        Won’t do
                      </button>
                      <button
                        type="button"
                        className={canContinue ? undefined : "primary"}
                        disabled={saving || dirty}
                        onClick={() => void mutate("complete")}
                      >
                        Mark done
                      </button>
                      {canContinue && (
                        <button
                          type="button"
                          className="primary"
                          disabled={saving || dirty}
                          onClick={() => void mutate("complete", true)}
                        >
                          Done &amp; tell agent
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={saving || dirty}
                        onClick={() => void mutate("reopen")}
                      >
                        Reopen
                      </button>
                      {todo.status === "done" && !!note && (
                        <button
                          type="button"
                          disabled={saving || dirty}
                          onClick={() => void mutate("save-note")}
                        >
                          Save note
                        </button>
                      )}
                      {todo.status === "done" && canContinue && (
                        <button
                          type="button"
                          className="primary"
                          disabled={saving || dirty || !!note}
                          onClick={() => void mutate("continue")}
                        >
                          {currentDelivery?.state === "needs_retry" ||
                          currentDelivery?.state === "cancelled"
                            ? "Retry telling agent"
                            : "Tell agent"}
                        </button>
                      )}
                    </>
                  )}
                </div>
                {todo.goalId && (
                  <p className="todo-hint">
                    This todo is blocking a goal. Marking it done won’t resume
                    the goal automatically.{" "}
                    <button
                      type="button"
                      className="todo-link"
                      disabled={locked}
                      onClick={() => setReviewGoal(true)}
                    >
                      Review goal
                    </button>
                  </p>
                )}
                {delivery && (
                  <p className="todo-hint" aria-label="Continuation">
                    {currentDelivery ? "" : "Earlier: "}
                    {delivery.state === "waiting"
                      ? "Agent will pick this up when it’s free."
                      : delivery.state === "needs_retry"
                        ? `Agent wasn’t told — ${delivery.reason}`
                        : delivery.state === "admitted"
                          ? `Agent was told${detail?.run ? ` (run ${detail.run.status})` : ""}.`
                          : `Not sent — ${delivery.reason}`}
                  </p>
                )}
              </section>
            )}
            {todo && (
              <nav className="todo-links" aria-label="Related">
                {todo.agentId && (
                  <button
                    type="button"
                    className="todo-link"
                    disabled={locked}
                    onClick={() => {
                      onNavigate();
                      openTodoAgent(todo.agentId!);
                    }}
                  >
                    Open agent
                  </button>
                )}
                {todo.sourceActivityId && todo.sourceAgentId && (
                  <button
                    type="button"
                    className="todo-link"
                    disabled={locked}
                    onClick={() => {
                      onNavigate();
                      const origin = todo.sourceAgentId;
                      if (origin) openTodoAgent(origin, todo.sourceActivityId);
                    }}
                  >
                    Source conversation
                  </button>
                )}
                <button
                  type="button"
                  className="todo-link danger-link"
                  disabled={saving}
                  onClick={() => {
                    if (window.confirm("Delete this todo?"))
                      void mutate("delete");
                  }}
                >
                  Delete
                </button>
              </nav>
            )}
            {todo && !!detail?.history.length && (
              <details className="todo-history">
                <summary>Activity</summary>
                <ol>
                  {detail.history.map((entry, index) => (
                    <li key={`${entry.requestId}:${index}`}>
                      <span>
                        {entry.actor.kind === "human"
                          ? "You"
                          : (agents.find((a) => a.id === (entry.actor as { agentId: string }).agentId)?.name ?? "Agent")}{" "}
                        {historyVerb(entry)}
                      </span>
                      <time dateTime={entry.createdAt}>
                        {new Date(entry.createdAt).toLocaleString()}
                      </time>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </>
        )}
      </fieldset>
    </Modal>
  );
}
function historyVerb(entry: import("../shared/human-todos").HumanTodoAudit) {
  const status = entry.changes?.status;
  const note = entry.changes?.resolutionNote;
  const verb =
    entry.action === "create"
      ? "created this"
      : entry.action === "complete"
        ? "marked it done"
        : entry.action === "continue"
          ? "told the agent"
          : entry.action === "delete"
            ? "deleted it"
            : entry.action === "deduplicated"
              ? "re-requested it"
              : status === "open"
                ? "reopened it"
                : status === "cancelled"
                  ? "marked it won’t do"
                  : status === "done"
                    ? "marked it done"
                    : "edited it";
  return note ? `${verb}: “${String(note)}”` : verb;
}

export function AgentNeedsYou({
  snapshot,
  agentId,
  active,
}: {
  snapshot: Snapshot;
  agentId: string;
  active: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState("");
  const revision = useTodoRevision(),
    count = snapshot.humanTodoCounts?.agents[agentId] ?? 0;
  useEffect(() => {
    let stale = false;
    if (count)
      void api<HumanTodosPage>(
        `/human-todos?agentId=${encodeURIComponent(agentId)}&limit=1`,
      )
        .then((page) => {
          if (!stale)
            setPreview(
              page.items[0]?.title ?? "",
            );
        })
        .catch(() => {});
    else setPreview("");
    return () => {
      stale = true;
    };
  }, [agentId, count, revision]);
  return (
    <div className="needs-you-strip">
      <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <ListTodo size={16} />
        {count ? `Needs you · ${count}` : "Todos"}
        {preview && <span>{preview}</span>}
      </button>
      {expanded && (
        <HumanTodos snapshot={snapshot} active={active} agentId={agentId} />
      )}
    </div>
  );
}
// Shared live todo reads for chat rows. One request per todo, refreshed on
// todo invalidation, so many transcript rows never fan out duplicate fetches.
const chatTodoCache = new Map<string, Promise<HumanTodo | null>>();
function useChatTodo(id: string) {
  const revision = useTodoRevision();
  const [todo, setTodo] = useState<HumanTodo | null | undefined>(undefined);
  useEffect(() => {
    let stale = false;
    const key = `${id}:${revision}`;
    if (!chatTodoCache.has(key)) {
      chatTodoCache.set(
        key,
        api<HumanTodoDetail>(path(id))
          .then((detail) => detail.todo)
          .catch(() => null),
      );
      for (const old of chatTodoCache.keys())
        if (old.startsWith(`${id}:`) && old !== key) chatTodoCache.delete(old);
    }
    void chatTodoCache.get(key)!.then((value) => {
      if (!stale) setTodo(value);
    });
    return () => {
      stale = true;
    };
  }, [id, revision]);
  return todo;
}
function chatTodoLabel(event: import("../shared/types").Activity) {
  if (event.type === "message") return "You marked this done and told the agent";
  const status = event.data.status;
  switch (event.data.action) {
    case "create":
      return "Added to your todos";
    case "complete":
      return "Marked done";
    case "delete":
      return "Deleted";
    default:
      return status === "open"
        ? "Reopened"
        : status === "done"
          ? "Marked done"
          : status === "cancelled"
            ? "Won’t do"
            : "Updated";
  }
}

export function HumanTodoActivity({
  event,
}: {
  event: import("../shared/types").Activity;
}) {
  if (event.type === "human_todo_changed" && !event.data.meaningful)
    return null;
  if (
    event.type === "human_todo_attention" ||
    event.type === "human_todo_continuation_changed"
  )
    return null;
  const id = String(event.data.todoId ?? "");
  if (!id) return null;
  // Creation shows the live item; later changes are one quiet line.
  if (event.type === "human_todo_changed" && event.data.action === "create")
    return <ChatTodo id={id} label={chatTodoLabel(event)} />;
  return <ChatTodoUpdate id={id} label={chatTodoLabel(event)} />;
}

function ChatTodoUpdate({ id, label }: { id: string; label: string }) {
  const todo = useChatTodo(id);
  return (
    <button
      type="button"
      className="chat-todo-update"
      onClick={() => openTodo(id)}
      aria-label={`${label}${todo ? `: ${todo.title}` : ""}. Open todo`}
    >
      {/done|told/i.test(label) ? (
        <CircleCheck size={14} aria-hidden="true" />
      ) : (
        <ListTodo size={14} aria-hidden="true" />
      )}
      <span>{label}</span>
      {todo && <strong>{todo.title}</strong>}
    </button>
  );
}

/** A todo row in the transcript: the live item, styled like the Todos list. */
function ChatTodo({ id, label }: { id: string; label: string }) {
  const todo = useChatTodo(id);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [requests] = useState(() => new Map<string, string>());
  const status = todo?.deletedAt ? "deleted" : (todo?.status ?? "open");
  async function toggle() {
    if (!todo || todo.deletedAt || busy) return;
    const key = `${todo.id}:${todo.revision}`;
    if (!requests.has(key)) requests.set(key, requestId());
    setBusy(true);
    setError("");
    try {
      if (todo.status === "open")
        await control(path(todo.id) + "/complete", {
          requestId: requests.get(key),
          expectedRevision: todo.revision,
        });
      else
        await api(path(todo.id), {
          method: "PATCH",
          body: JSON.stringify({
            requestId: requests.get(key),
            expectedRevision: todo.revision,
            status: "open",
          }),
        });
      changed();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="chat-todo" data-status={status}>
      <span className="chat-todo-label">
        <ListTodo size={13} aria-hidden="true" />
        {label}
      </span>
      <div className="chat-todo-row">
        <button
          type="button"
          className="todo-check"
          disabled={!todo || !!todo.deletedAt || busy}
          aria-label={
            todo
              ? status === "open"
                ? `Done: ${todo.title}`
                : `Reopen: ${todo.title}`
              : "Todo loading"
          }
          title={status === "open" ? "Mark done" : "Reopen"}
          onClick={() => void toggle()}
        >
          <span>
            {status === "done" ? (
              <Check size={14} strokeWidth={3} />
            ) : status === "cancelled" || status === "deleted" ? (
              <X size={14} strokeWidth={3} />
            ) : null}
          </span>
        </button>
        <button
          type="button"
          className="chat-todo-copy"
          aria-label={`Open todo${todo ? `: ${todo.title}` : ""}`}
          onClick={() => openTodo(id)}
        >
          <strong>
            {todo === undefined
              ? "Loading todo…"
              : todo === null
                ? "Todo unavailable"
                : todo.title}
          </strong>
          {todo?.body && <span className="todo-body">{todo.body}</span>}
          {todo && (status === "cancelled" || status === "deleted") && (
            <span className="chat-todo-state">
              {status === "cancelled" ? "Won’t do" : "Deleted"}
            </span>
          )}
        </button>
      </div>
      {error && (
        <p className="chat-todo-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
