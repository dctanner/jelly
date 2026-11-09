import { useEffect, useRef, useState } from "react";
import { Check, ListTodo } from "lucide-react";
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
import { ChatFormActions, ChatFormCard } from "./ChatFormCard";
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
  const [status, setStatus] = useState("open"),
    [q, setQ] = useState(""),
    [filterAgent, setFilterAgent] = useState(""),
    [project, setProject] = useState("");
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [editing, setEditing] = useState<string | null>(null);
  const revision = useTodoRevision(),
    generation = useRef(0),
    request = useRef<AbortController | null>(null);
  const listKey = `${status}:${q}:${agentId ?? filterAgent}:${project}`;
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
        ...(project ? { projectId: project } : {}),
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
  async function done(todo: HumanTodoSummary) {
    const key = `${todo.id}:${todo.revision}`;
    if (!doneRequests.has(key)) doneRequests.set(key, requestId());
    try {
      await control(path(todo.id) + "/complete", {
        requestId: doneRequests.get(key),
        expectedRevision: todo.revision,
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
  return (
    <section
      className={`human-todos ${agentId ? "agent-todos" : ""}`}
      aria-label={agentId ? "Agent todos" : "Todos"}
      ref={list}
    >
      <header className="todos-heading">
        <h1 tabIndex={-1} ref={heading}>
          {agentId ? "Needs you" : "Todos"}
        </h1>
        <button className="primary" onClick={() => setEditing("new")}>
          Add todo
        </button>
      </header>
      <div className="todo-filters">
        <label>
          Search
          <input
            type="search"
            value={q}
            maxLength={200}
            onChange={(event) => setQ(event.target.value)}
          />
        </label>
        <label>
          Show
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="open">Open todos</option>
            <option value="history">Done / Cancelled</option>
          </select>
        </label>
        {!agentId && (
          <>
            <label>
              Agent
              <select
                value={filterAgent}
                onChange={(event) => setFilterAgent(event.target.value)}
              >
                <option value="">All agents</option>
                <option value="unassigned">Unassigned</option>
                {(page?.agents ?? snapshot?.agents ?? []).map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                    {agent.archivedAt ? " (archived)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Project
              <select
                value={project}
                onChange={(event) => setProject(event.target.value)}
              >
                <option value="">All projects</option>
                {snapshot?.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      {error && (
        <p role="alert">
          {error} <button onClick={() => void load()}>Retry</button>
        </p>
      )}
      {loading && !page && <p role="status">Loading todos…</p>}
      {status === "open" && !!page?.handoffs.length && (
        <section aria-label="Needs attention now">
          <h2>Needs attention now</h2>
          {page.handoffs.map((item) => (
            <article className="todo-row" key={item.id}>
              <div>
                <strong>
                  {item.kind === "sudo"
                    ? "Sudo authentication"
                    : item.kind === "browser_login"
                      ? "Browser sign-in"
                      : item.kind === "browser_recovery"
                        ? "Browser recovery"
                        : "Desktop handback"}
                </strong>
                <p>
                  {page.agents.find((agent) => agent.id === item.agentId)?.name}{" "}
                  ·{" "}
                  {item.status === "executing"
                    ? "In progress"
                    : `Expires ${new Date(item.expiresAt).toLocaleString()}`}
                </p>
                {item.todoId && (
                  <button onClick={() => select(item.todoId!)}>
                    Linked todo · still needs completion
                  </button>
                )}
              </div>
              <button
                onClick={() =>
                  openTodoAgent(item.agentId, item.sourceActivityId)
                }
              >
                Open request
              </button>
            </article>
          ))}
        </section>
      )}
      {page &&
        !page.items.length &&
        !(status === "open" && page.handoffs.length) && (
          <p>
            {status === "open"
              ? "Nothing needs you right now."
              : "No resolved todos."}
          </p>
        )}
      <ul className="todo-list">
        {page?.items
          .filter(
            (todo) =>
              status !== "open" ||
              !page.handoffs.some((item) => item.todoId === todo.id),
          )
          .map((todo) => {
            const agent = linkedAgent(todo, page.agents);
            return (
              <li className="todo-row" key={todo.id}>
                {todo.status === "open" && (
                  <button
                    className="icon"
                    aria-label={`Done: ${todo.title}`}
                    title="Done — no agent run"
                    onClick={() => void done(todo)}
                  >
                    <Check size={20} />
                  </button>
                )}
                <button
                  className="todo-copy"
                  onClick={() => select(todo.id)}
                  id={`todo-${todo.id}`}
                >
                  <strong>{todo.title}</strong>
                  <span>
                    {todo.blocking ? "Blocking · " : ""}
                    {todo.status === "open"
                      ? "Open"
                      : todo.status === "done"
                        ? "Done · attested"
                        : "Cancelled"}{" "}
                    ·{" "}
                    <time
                      dateTime={todo.createdAt}
                      title={new Date(todo.createdAt).toLocaleString()}
                    >
                      {creationAge(todo.createdAt)}
                    </time>
                  </span>
                  <span>{todo.reason.slice(0, 200)}</span>
                  <span className="todo-agent">
                    {agent && <Avatar agent={agent} />}
                    {agent?.name ?? "Unassigned"}
                    {agent?.archivedAt ? " (archived)" : ""}
                    {agent?.projectId
                      ? ` · ${snapshot?.projects.find((project) => project.id === agent.projectId)?.name ?? "Project"}`
                      : ""}
                  </span>
                </button>
                <button
                  aria-label={`Edit or manage ${todo.title}`}
                  onClick={() => select(todo.id)}
                >
                  •••
                </button>
              </li>
            );
          })}
      </ul>
      {page?.after && (
        <button disabled={loading} onClick={() => void load(page.after!)}>
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
      {active && selected && (
        <TodoEditor
          key={draftKey}
          id={selected}
          draftKey={draftKey}
          agentId={agentId}
          agents={page?.agents ?? snapshot?.agents ?? []}
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

type Draft = Pick<
  HumanTodo,
  "title" | "instructions" | "reason" | "criteria" | "blocking" | "agentId"
>;
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
  instructions: "",
  reason: "",
  criteria: "",
  blocking: false,
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
  return (
    <Modal
      title={id === "new" ? "Add todo" : "Todo details"}
      onClose={onClose}
      dirty={dirty || !!note}
      dismissible={!saving}
      focusHeading
    >
      <fieldset className="todo-editor" data-open-todo-id={id} disabled={saving}>
        {error && (
          <p role="alert">
            {error}{" "}
            <button onClick={() => void load()}>Refresh saved state</button>
          </p>
        )}
        {id !== "new" && !detail ? (
          <p>Loading todo…</p>
        ) : (
          <>
            {todo?.deletedAt ? (
              <p>
                This todo was deleted. Its tombstone and audit remain; deletion
                is not permanent data erasure.
              </p>
            ) : (
              <>
                {base !== null && todo && base !== todo.revision && (
                  <p role="status">
                    This todo changed. Your draft is retained at revision {base}
                    ; saved revision is {todo.revision}.{" "}
                    <button onClick={() => void load(true)}>
                      Discard draft and load latest
                    </button>
                  </p>
                )}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void mutate("save");
                  }}
                >
                  <p id="todo-privacy">
                    Todo text and notes are persisted and may be sent to the
                    linked agent’s provider. Never enter credentials; use
                    private handoffs.
                  </p>
                  {(
                    [
                      ["title", "Action title", 160],
                      ["instructions", "Instructions", 8000],
                      ["reason", "Why it is needed", 4000],
                      ["criteria", "What counts as done", 4000],
                    ] as const
                  ).map(([key, label, max]) => (
                    <label className="chat-form-field" key={key}>
                      {label}
                      {key === "title" ? (
                        <input
                          required
                          maxLength={max}
                          value={draft[key]}
                          aria-describedby="todo-privacy"
                          onChange={(event) => {
                            setDraft({ ...draft, [key]: event.target.value });
                            setDirty(true);
                          }}
                        />
                      ) : (
                        <textarea
                          maxLength={max}
                          value={draft[key]}
                          aria-describedby="todo-privacy"
                          onChange={(event) => {
                            setDraft({ ...draft, [key]: event.target.value });
                            setDirty(true);
                          }}
                        />
                      )}
                    </label>
                  ))}
                  <label className="chat-form-field">
                    Linked agent
                    <select
                      value={draft.agentId ?? ""}
                      onChange={(event) => {
                        setDraft({
                          ...draft,
                          agentId: event.target.value || null,
                        });
                        setDirty(true);
                      }}
                    >
                      <option value="">Unassigned</option>
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                          {agent.archivedAt ? " (archived)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.blocking}
                      onChange={(event) => {
                        setDraft({ ...draft, blocking: event.target.checked });
                        setDirty(true);
                      }}
                    />{" "}
                    Blocking dependency
                  </label>
                  <ChatFormActions>
                    <button
                      type="submit"
                      className="primary"
                      disabled={saving || (id !== "new" && !dirty)}
                    >
                      Save todo
                    </button>
                  </ChatFormActions>
                </form>
                {todo && (
                  <section aria-label="Resolution">
                    <p>
                      Status: <strong>{todo.status}</strong>
                      {todo.status === "done"
                        ? ` · reported by ${todo.resolutionActor?.kind ?? "unknown"}; not independently verified`
                        : ""}
                    </p>
                    {todo.resolutionNote && (
                      <p className="todo-text">{todo.resolutionNote}</p>
                    )}
                    <label className="chat-form-field">
                      Optional non-secret completion note
                      <textarea
                        value={note}
                        maxLength={4000}
                        aria-describedby="todo-privacy"
                        onChange={(event) => setNote(event.target.value)}
                      />
                    </label>
                    {todo.status === "done" && !!note && (
                      <p>Save the completion note before continuing the agent.</p>
                    )}
                    <ChatFormActions>
                      {todo.status === "done" && (
                        <button
                          disabled={saving || dirty || !note}
                          onClick={() => void mutate("save-note")}
                        >
                          Save completion note
                        </button>
                      )}
                      {todo.status !== "open" && (
                        <button
                          disabled={saving || dirty}
                          onClick={() => void mutate("reopen")}
                        >
                          Reopen
                        </button>
                      )}
                      {todo.status === "open" && (
                        <>
                          <button
                            disabled={saving || dirty}
                            onClick={() => void mutate("cancel")}
                          >
                            Cancel todo
                          </button>
                          <button
                            className="primary"
                            disabled={saving || dirty}
                            onClick={() => void mutate("complete")}
                          >
                            Done
                          </button>
                          {canContinue && (
                            <button
                              disabled={saving || dirty}
                              onClick={() => void mutate("complete", true)}
                            >
                              Done &amp; continue — runs agent
                            </button>
                          )}
                        </>
                      )}
                      {todo.status === "done" && canContinue && (
                        <button
                          disabled={saving || dirty || !!note}
                          onClick={() => void mutate("continue")}
                        >
                          {currentDelivery?.state === "needs_retry" ||
                          currentDelivery?.state === "cancelled"
                            ? "Retry continuation — runs agent"
                            : "Continue agent"}
                        </button>
                      )}
                    </ChatFormActions>
                    {todo.goalId && (
                      <p>
                        Goal dependency: Done does not resume it.{" "}
                        <button
                          disabled={dirty || !!note}
                          onClick={() => setReviewGoal(true)}
                        >
                          Review goal
                        </button>{" "}
                        · Use the existing explicit Resume goal action after
                        review.
                      </p>
                    )}
                    <details>
                      <summary>Delete todo</summary>
                      <p>
                        Soft deletion removes this task from lists, not its
                        audit. This is not permanent data erasure.
                      </p>
                      <button
                        disabled={saving}
                        className="danger"
                        onClick={() => void mutate("delete")}
                      >
                        Delete todo
                      </button>
                    </details>
                  </section>
                )}
              </>
            )}
            {delivery && (
              <section aria-label="Continuation">
                <h3>
                  {currentDelivery
                    ? "Continuation"
                    : "Previous completion’s continuation"}{" "}
                  — separate from task status
                </h3>
                <p>
                  {delivery.state === "waiting"
                    ? "Waiting for agent"
                    : delivery.state === "needs_retry"
                      ? "Not started — retry"
                      : delivery.state === "admitted"
                        ? "Already started"
                        : "Cancelled"}
                </p>
                <p>{delivery.reason}</p>
                {detail.run && (
                  <p>
                    Run outcome: {detail.run.status}
                    {detail.run.error ? ` · ${detail.run.error}` : ""}
                  </p>
                )}
                {delivery.state === "admitted" && (
                  <p>
                    External effects may have occurred. This delivery cannot be
                    replayed. Use the agent’s Stop control separately; further
                    work requires a new explicit chat request.{" "}
                    <button
                      disabled={dirty || !!note}
                      onClick={() => {
                        onNavigate();
                        openTodoAgent(delivery.agentId);
                      }}
                    >
                      Open continuation agent
                    </button>
                  </p>
                )}
              </section>
            )}
            {todo && (todo.agentId || (todo.sourceActivityId && todo.sourceAgentId)) && (
              <ChatFormActions>
                {todo.agentId && <button
                  disabled={dirty || !!note}
                  onClick={() => {
                    onNavigate();
                    openTodoAgent(todo.agentId!);
                  }}
                >
                  Open agent
                </button>}
                {todo.sourceActivityId && todo.sourceAgentId && (
                  <button
                    disabled={dirty || !!note}
                    onClick={() => {
                      onNavigate();
                      const origin = todo.sourceAgentId;
                      if (origin) openTodoAgent(origin, todo.sourceActivityId);
                    }}
                  >
                    Source conversation
                  </button>
                )}
              </ChatFormActions>
            )}
            {todo && (
              <details>
                <summary>History and provenance</summary>
                <p>
                  Created by {todo.creator.kind} ·{" "}
                  {new Date(todo.createdAt).toLocaleString()} · revision{" "}
                  {todo.revision}
                </p>
                <p>Todo ID: {todo.id}</p>
                {todo.originGoalId && <p>Original goal: {todo.originGoalId}</p>}
                {todo.originInterventionId && (
                  <p>
                    Original private request: {todo.originInterventionId}. Its
                    own expiry and approval controls still apply.
                  </p>
                )}
                <ol>
                  {detail.history.map((entry, index) => (
                    <li key={`${entry.requestId}:${index}`}>
                      {entry.actor.kind} · {entry.action} · revision{" "}
                      {entry.afterRevision} ·{" "}
                      {new Date(entry.createdAt).toLocaleString()}
                      {entry.changes?.resolutionNote
                        ? ` · ${String(entry.changes.resolutionNote)}`
                        : ""}
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
              page.items[0]?.blocking ? `Blocking: ${page.items[0].title}` : "",
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
  return (
    <ChatFormCard
      icon={<ListTodo size={16} />}
      title={
        event.data.source === "human_todo"
          ? "Human-requested follow-up"
          : "Human todo"
      }
      status={String(
        event.data.status ?? event.data.action ?? "Explicit continuation",
      )}
    >
      <ChatFormActions>
        <button onClick={() => openTodo(String(event.data.todoId))}>
          Open todo
        </button>
      </ChatFormActions>
    </ChatFormCard>
  );
}
