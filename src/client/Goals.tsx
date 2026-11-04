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
      <p>
        Parent-session continuation tokens: {String(event.data.tokensUsed)} /{" "}
        {String(event.data.tokenBudget)}
      </p>
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
  const [budget, setBudget] = useState("100000");
  const [completion, setCompletion] = useState<{
    goalId: string;
    expectedRevision: number;
    summary: string;
  } | null>(null);
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
      ...(action === "complete" && completion
        ? {
            goalId: completion.goalId,
            expectedRevision: completion.expectedRevision,
          }
        : action === "edit" && editing?.action === "edit"
          ? {
              goalId: editing.goalId,
              expectedRevision: editing.expectedRevision,
            }
          : action !== "create"
            ? { goalId: goal!.id, expectedRevision: goal!.revision }
            : {}),
      ...(["create", "edit"].includes(action)
        ? { objective, tokenBudget: Number(budget) }
        : {}),
      ...(action === "complete" ? { summary: completion?.summary ?? "" } : {}),
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
      setCompletion(null);
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
      dirty={!!editing || !!completion?.summary}
    >
      <div className="goals-panel">
        <p className="chat-form-hint">
          One durable goal per agent. Save first, then Resume to authorize
          autonomous work while Jelly runs. Restart requires explicit resume.
        </p>
        <p className="chat-form-hint">
          Parent-session continuation token budget: uncached input + cache-write
          + output. Excludes delegated children, compaction and nested/CLI work.
          Not a total spend or hard cap; in-flight work can overshoot.
        </p>
        {error && <p role="alert">{error}</p>}
        {!view && <p role="status">Loading goal…</p>}
        {archived && <p>Restore this agent to change its goal.</p>}
        {view && !goal && !editing && (
          <>
            <p>No goal yet.</p>
            <button
              className="primary"
              disabled={archived || !!view.runningRunId}
              onClick={() => {
                setObjective("");
                setEditing({ action: "create" });
              }}
            >
              New goal
            </button>
          </>
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
            <p className="goal-objective">{goal.objective}</p>
            <p>
              Parent-session continuation tokens:{" "}
              {goal.tokensUsed.toLocaleString()} /{" "}
              {goal.tokenBudget.toLocaleString()}
            </p>
            <progress
              aria-label="Parent-session continuation token usage"
              value={Math.min(goal.tokensUsed, goal.tokenBudget)}
              max={goal.tokenBudget}
            />
            {goal.usageUnknown && (
              <p role="status">
                Some parent usage is unknown; this count is a lower bound.
                Review before resuming.
              </p>
            )}
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
                        className="secondary"
                        disabled={
                          goal.state === "active" || !!view?.runningRunId
                        }
                        onClick={() => {
                          setObjective(goal.objective);
                          setBudget(String(goal.tokenBudget));
                          setEditing({
                            action: "edit",
                            goalId: goal.id,
                            expectedRevision: goal.revision,
                          });
                        }}
                      >
                        Edit goal
                      </button>
                      <button
                        className="primary"
                        disabled={
                          goal.state !== "active" &&
                          (!!view?.runningRunId ||
                            goal.tokensUsed >= goal.tokenBudget)
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
                {goal.state !== "completed" && (
                  <>
                    <label className="chat-form-field">
                      Completion evidence
                      <textarea
                        maxLength={16000}
                        value={completion?.summary ?? ""}
                        onChange={(e) =>
                          setCompletion(
                            e.target.value
                              ? {
                                  goalId: completion?.goalId ?? goal.id,
                                  expectedRevision:
                                    completion?.expectedRevision ??
                                    goal.revision,
                                  summary: e.target.value,
                                }
                              : null,
                          )
                        }
                      />
                    </label>
                    {completion &&
                      (completion.goalId !== goal.id ||
                        completion.expectedRevision !== goal.revision) && (
                        <p role="status">
                          The goal changed. Completion evidence still targets
                          its original goal and revision. Clear the evidence to
                          start a new draft.
                        </p>
                      )}
                    <button
                      className="secondary"
                      disabled={!completion?.summary.trim()}
                      onClick={() => void change("complete")}
                    >
                      Complete goal
                    </button>
                  </>
                )}
              </fieldset>
            )}
          </section>
        )}
        {editing && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void change(editing.action);
            }}
          >
            <fieldset className="goal-fields" disabled={busy || archived}>
              {(editing.action === "edit"
                ? goal?.id !== editing.goalId ||
                  goal.revision !== editing.expectedRevision
                : !!goal) && (
                <p role="status">
                  The goal changed while you were editing. This draft still
                  targets its original goal and revision. Cancel edit and reopen
                  to load the current goal.
                </p>
              )}
              <label className="chat-form-field">
                Objective
                <textarea
                  required
                  maxLength={16000}
                  rows={6}
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                />
              </label>
              <label className="chat-form-field">
                Parent-session continuation token budget
                <input
                  required
                  type="number"
                  min={1}
                  max={Number.MAX_SAFE_INTEGER}
                  step={1}
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                />
              </label>
              <ChatFormActions>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setEditing(null)}
                >
                  Cancel edit
                </button>
                <button className="primary" type="submit">
                  Save goal
                </button>
              </ChatFormActions>
            </fieldset>
          </form>
        )}
      </div>
    </Modal>
  );
}
