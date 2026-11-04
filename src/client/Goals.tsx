import { useEffect, useRef, useState } from "react";
import { Target } from "lucide-react";
import type { GoalAction, GoalView } from "../shared/goals";
import type { Activity } from "../shared/types";
import { goalsApi, post } from "./api";
import { requestId } from "./request-id";
import { Modal } from "./Modal";
import { ChatFormCard, ChatFormActions } from "./ChatFormCard";
import "./Goals.css";

export function GoalsButton({
  agentId,
  archived = false,
}: {
  agentId: string;
  archived?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="icon"
        aria-label="Goals"
        title="Goals"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Target size={20} />
      </button>
      {open && (
        <GoalsPanel
          key={agentId}
          agentId={agentId}
          archived={archived}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
export function GoalExecution({
  event,
  archived = false,
}: {
  event: Activity;
  archived?: boolean;
}) {
  return (
    <ChatFormCard
      title="Goal execution"
      icon={<Target size={19} />}
      status="Authorized goal resume"
      description="Automated goal work in this conversation; not a new live message."
    >
      <p className="goal-objective">{String(event.data.goalObjective)}</p>
      <details>
        <summary>Goal instructions</summary>
        <p className="goal-objective">{String(event.data.text)}</p>
      </details>
      <GoalsButton agentId={event.agentId!} archived={archived} />
    </ChatFormCard>
  );
}
export function GoalNotice({
  event,
  archived = false,
}: {
  event: Activity;
  archived?: boolean;
}) {
  return (
    <ChatFormCard
      title="Goal"
      icon={<Target size={19} />}
      status={String(event.data.state).replaceAll("_", " ")}
    >
      {!!event.data.reason && <p>{String(event.data.reason)}</p>}
      {!!event.data.progress && (
        <p className="goal-objective">{String(event.data.progress)}</p>
      )}
      <GoalsButton agentId={event.agentId!} archived={archived} />
    </ChatFormCard>
  );
}
export function GoalsPanel({
  agentId,
  archived = false,
  onClose,
}: {
  agentId: string;
  archived?: boolean;
  onClose: () => void;
}) {
  const [view, setView] = useState<GoalView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<
    | { action: "create" }
    | { action: "edit"; goalId: string; expectedRevision: number }
    | null
  >(null);
  const [objective, setObjective] = useState("");
  const mutation = useRef({ payload: "", id: "" });
  const generation = useRef(0);
  const alive = useRef(true);
  const writing = useRef(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    let pending = false;
    let reading: Promise<void> | null = null;
    // Serialize reads and invalidate any read spanning a mutation. POST bodies
    // may predate SSE state, while a GET begun after POST may sample pre-commit.
    // Only a fresh post-settlement read can resolve both orderings safely.
    const load = () => {
      pending = true;
      ++generation.current;
      if (!reading && !writing.current) {
        reading = (async () => {
          while (pending && !writing.current && !controller.signal.aborted) {
            pending = false;
            const n = generation.current;
            try {
              const next = await goalsApi.get(agentId, controller.signal);
              if (alive.current && n === generation.current && !writing.current)
                setView(next);
            } catch (e) {
              if (
                alive.current &&
                !controller.signal.aborted &&
                n === generation.current
              )
                setError((e as Error).message);
            }
          }
        })().finally(() => {
          reading = null;
          if (pending && !writing.current && !controller.signal.aborted)
            void load();
        });
      }
      return reading ?? Promise.resolve();
    };
    refresh.current = load;
    void load();
    window.addEventListener("jelly:goals-updated", load);
    return () => {
      alive.current = false;
      generation.current++;
      controller.abort();
      window.removeEventListener("jelly:goals-updated", load);
    };
  }, [agentId]);
  const goal = view?.goal;
  async function change(action: GoalAction) {
    setBusy(true);
    setError("");
    writing.current = true;
    const data = {
      ...(action === "edit" && editing?.action === "edit"
        ? {
            goalId: editing.goalId,
            expectedRevision: editing.expectedRevision,
          }
        : action !== "create"
          ? { goalId: goal!.id, expectedRevision: goal!.revision }
          : {}),
      ...(["create", "edit"].includes(action) ? { objective } : {}),
    };
    const payload = JSON.stringify([action, data]);
    if (mutation.current.payload !== payload)
      mutation.current = { payload, id: requestId() };
    ++generation.current;
    try {
      await goalsApi.change(agentId, action, {
        ...data,
        requestId: mutation.current.id,
      });
      if (!alive.current) return;
      setEditing(null);
    } catch (e) {
      if (!alive.current) return;
      setError((e as Error).message);
    } finally {
      writing.current = false;
      if (alive.current) {
        await refresh.current();
        setBusy(false);
      }
    }
  }
  return (
    <Modal
      title="Goals"
      onClose={onClose}
      detent="large"
      dismissible={!busy}
      dirty={!!editing}
    >
      <div className="goals-panel">
        <p className="chat-form-hint">
          Save your goal, then resume to let the agent work on it.
        </p>
        {error && <p role="alert">{error}</p>}
        {!view && <p role="status">Loading goal…</p>}
        {archived && <p>Restore this agent to change its goal.</p>}
        {view && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (
                editing &&
                !busy &&
                !archived &&
                !view.runningRunId &&
                goal?.state !== "active" &&
                goal?.state !== "completed"
              )
                void change(editing.action);
            }}
          >
            <fieldset className="goal-fields" disabled={busy || archived}>
              {editing &&
                (editing.action === "edit"
                  ? goal?.id !== editing.goalId ||
                    goal.revision !== editing.expectedRevision
                  : !!goal) && (
                  <p role="status">
                    The goal changed while you were editing. This draft still
                    targets its original goal and revision. Cancel edit to load
                    the current goal.
                  </p>
                )}
              <label className="chat-form-field">
                Objective
                <textarea
                  required
                  maxLength={16000}
                  rows={6}
                  placeholder="What should this agent accomplish?"
                  readOnly={
                    !!view.runningRunId ||
                    goal?.state === "active" ||
                    goal?.state === "completed"
                  }
                  value={editing ? objective : (goal?.objective ?? "")}
                  onChange={(e) => {
                    if (
                      view.runningRunId ||
                      goal?.state === "active" ||
                      goal?.state === "completed"
                    )
                      return;
                    if (!editing)
                      setEditing(
                        goal
                          ? {
                              action: "edit",
                              goalId: goal.id,
                              expectedRevision: goal.revision,
                            }
                          : { action: "create" },
                      );
                    setObjective(e.target.value);
                  }}
                />
              </label>
              {(view.runningRunId || goal?.state === "active") && (
                <p className="chat-form-hint">
                  Stop running work before editing the goal.
                </p>
              )}
              {editing && (
                <ChatFormActions>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setEditing(null);
                      setError("");
                    }}
                  >
                    Cancel edit
                  </button>
                  <button
                    className="primary"
                    type="submit"
                    disabled={
                      !objective.trim() ||
                      !!view.runningRunId ||
                      goal?.state === "active" ||
                      goal?.state === "completed"
                    }
                  >
                    Save goal
                  </button>
                </ChatFormActions>
              )}
            </fieldset>
          </form>
        )}
        {view?.runningRunId && (
          <p role="status">
            Work is still running. Pause, complete and clear only prevent new
            goal continuations; admitted tools and children may finish.{" "}
            <button
              className="secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                writing.current = true;
                ++generation.current;
                try {
                  await post(`/agents/${encodeURIComponent(agentId)}/stop`, {});
                } catch (e) {
                  if (alive.current) setError((e as Error).message);
                } finally {
                  writing.current = false;
                  if (alive.current) {
                    await refresh.current();
                    setBusy(false);
                  }
                }
              }}
            >
              Stop agent
            </button>
          </p>
        )}
        {goal && (
          <section aria-label="Current goal">
            <h3>{goal.state.replaceAll("_", " ")}</h3>
            {goal.reason && <p>{goal.reason}</p>}
            {goal.progress && <p className="goal-objective">{goal.progress}</p>}
            {goal.state === "completed" && (
              <p>
                Completion is an operator/model attestation, not independently
                verified.
              </p>
            )}
            {!editing && (
              <fieldset disabled={busy || archived} className="goal-fields">
                <ChatFormActions>
                  {goal.state !== "completed" && (
                    <>
                      <button
                        className="primary"
                        disabled={
                          goal.state !== "active" && !!view?.runningRunId
                        }
                        onClick={() =>
                          void change(
                            goal.state === "active" ? "pause" : "resume",
                          )
                        }
                      >
                        {goal.state === "active" ? "Pause goal" : "Resume goal"}
                      </button>
                    </>
                  )}
                  <button
                    className="secondary"
                    onClick={() => {
                      if (
                        window.confirm(
                          "Clear this goal? Running work is not aborted.",
                        )
                      )
                        void change("clear");
                    }}
                  >
                    Clear goal
                  </button>
                </ChatFormActions>
              </fieldset>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}
