import { useEffect, useState, useRef } from "react";
import { CalendarClock } from "lucide-react";
import cronstrue from "cronstrue";
import type {
  AgentSchedule,
  ScheduleReceipt,
  OccurrencesPage,
  SchedulesPage,
} from "../shared/schedules";
import type { Activity } from "../shared/types";
import { schedulesApi, post } from "./api";
import { requestId } from "./request-id";
import { Modal } from "./Modal";
import { ChatFormCard, ChatFormActions } from "./ChatFormCard";
import "./Schedules.css";

export function scheduleTiming(schedule: AgentSchedule) {
  const timing =
    schedule.kind === "once"
      ? new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "long",
          timeZone: schedule.timezone,
        }).format(new Date(schedule.runAt!))
      : `${cronstrue.toString(schedule.cron!, { use24HourTimeFormat: true })} (${schedule.cron})`;
  return `${timing} · ${schedule.timezone}`;
}
export function ScheduleLink({
  agentId,
  scheduleId,
  children = "View schedule",
}: {
  agentId: string;
  scheduleId?: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <a
        className="schedule-link"
        href={`/agents/${encodeURIComponent(agentId)}?schedule=${encodeURIComponent(scheduleId ?? "")}`}
        onClick={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </a>
      {open && (
        <SchedulesPanel
          agentId={agentId}
          initialId={scheduleId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
export function ScheduledMessage({ event }: { event: Activity }) {
  const data = event.data;
  const late = Math.max(
    0,
    Math.floor(
      (Date.parse(String(data.admittedAt)) -
        Date.parse(String(data.scheduledFor))) /
        1000,
    ),
  );
  return (
    <ChatFormCard
      title="Scheduled task"
      icon={<CalendarClock size={19} />}
      status="Automated user message"
      description="Previously scheduled by you; not a new live message."
    >
      <p className="schedule-prompt">{String(data.taskSnapshot)}</p>
      <dl className="schedule-times">
        <dt>Scheduled for</dt>
        <dd>{String(data.scheduledFor)}</dd>
        <dt>Admitted at</dt>
        <dd>{String(data.admittedAt)}</dd>
        <dt>Lateness</dt>
        <dd>{late} seconds</dd>
      </dl>
      <p className="chat-form-hint">{String(data.wakeReason)}</p>
      <ScheduleLink
        agentId={event.agentId!}
        scheduleId={String(data.scheduleId)}
      />
      <details className="schedule-details">
        <summary>Delivered wake text</summary>
        <pre className="schedule-prompt">{String(data.text)}</pre>
      </details>
    </ChatFormCard>
  );
}
export function ScheduleNotice({ event }: { event: Activity }) {
  const title =
    event.type === "schedule_blocked"
      ? "Schedule blocked"
      : event.type === "schedule_expired"
        ? "Schedule expired"
        : "Schedule updated";
  return (
    <ChatFormCard
      title={title}
      icon={<CalendarClock size={19} />}
      status={String(event.data.title ?? "Scheduled task")}
    >
      <p>{String(event.data.reason ?? `State: ${event.data.state}`)}</p>
      {event.type === "schedule_changed" && event.data.timezone != null && (
        <>
          <p>
            {String(event.data.timing)} · {String(event.data.timezone)}
          </p>
          <p>Next: {String(event.data.nextRunAt ?? "none")}</p>
          <p>
            After downtime:{" "}
            {event.data.catchUp === "none"
              ? "skip missed occurrences"
              : "latest missed occurrence"}
            . Lateness limit: {String(event.data.maxLatenessSeconds)} seconds.
            Jelly must be running; it cannot wake a sleeping host.
          </p>
          <details className="schedule-details">
            <summary>Stored task and upcoming times</summary>
            <p className="schedule-prompt">{String(event.data.storedPrompt)}</p>
            {Array.isArray(event.data.preview) && (
              <ol>
                {event.data.preview.map((time) => (
                  <li key={String(time)}>{String(time)}</li>
                ))}
              </ol>
            )}
          </details>
        </>
      )}
      {event.data.runningRunId ? (
        <p>
          A run already started. Pause/cancel will not abort it; use Stop
          separately.
        </p>
      ) : null}
      {event.type === "schedule_blocked" && (
        <p>
          Check the model connection in Settings, or pause/cancel this schedule.
          Safe delivery retries stop at the lateness deadline.
        </p>
      )}
      {event.type === "schedule_expired" && (
        <p>
          No run was admitted. Create a new schedule if this task is still
          useful.
        </p>
      )}
      <ScheduleLink
        agentId={event.agentId!}
        scheduleId={String(event.data.scheduleId)}
      />
    </ChatFormCard>
  );
}
function ScheduleEditor({
  agentId,
  receipt,
  onDone,
  onBusy,
  onDirty,
}: {
  agentId: string;
  receipt?: ScheduleReceipt;
  onDone: () => void;
  onBusy: (busy: boolean) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const schedule = receipt?.schedule;
  const [title, setTitle] = useState(schedule?.title ?? "");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [kind, setKind] = useState<"once" | "cron">(schedule?.kind ?? "once");
  const [time, setTime] = useState(schedule?.runAt ?? "");
  const [cron, setCron] = useState(schedule?.cron ?? "0 9 * * 1-5");
  const [zone, setZone] = useState(
    schedule?.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone ??
      "",
  );
  const [catchUp, setCatchUp] = useState(schedule?.catchUp ?? "latest");
  const [lateness, setLateness] = useState(
    schedule?.maxLatenessSeconds ?? 86400,
  );
  const [preview, setPreview] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mutation = useRef({ payload: "", id: "" });
  const input = () => ({
    title,
    prompt,
    kind,
    ...(kind === "once" ? { runAt: time } : { cron }),
    timezone: zone,
    catchUp,
    maxLatenessSeconds: lateness,
  });
  const serialized = JSON.stringify(input());
  const baseline = useRef(serialized);
  useEffect(() => {
    onDirty(serialized !== baseline.current);
  }, [serialized, onDirty]);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  async function submit(previewOnly: boolean) {
    setBusy(true);
    setError("");
    try {
      if (previewOnly)
        setPreview((await schedulesApi.preview(agentId, input())).preview);
      else {
        const payload = JSON.stringify(input());
        if (mutation.current.payload !== payload)
          mutation.current = { payload, id: requestId() };
        if (schedule)
          await schedulesApi.change(agentId, schedule.id, "update", {
            ...input(),
            expectedRevision: schedule.revision,
            requestId: mutation.current.id,
          });
        else
          await schedulesApi.create(agentId, {
            ...input(),
            requestId: mutation.current.id,
          });
        onDone();
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ChatFormCard
      title={schedule ? "Edit schedule" : "New schedule"}
      icon={<CalendarClock size={19} />}
      status="No model connection required"
      error={error}
    >
      <form
        className="chat-form-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <fieldset disabled={busy} className="schedule-fields">
          <label className="chat-form-field">
            Title
            <input
              required
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="chat-form-field">
            Stored task
            <textarea
              required
              maxLength={24000}
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <label className="chat-form-field">
            Timing
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as "once" | "cron");
                setPreview([]);
              }}
            >
              <option value="once">Once</option>
              <option value="cron">Repeating cron</option>
            </select>
          </label>
          {kind === "once" ? (
            <label className="chat-form-field">
              Future time with offset
              <input
                required
                placeholder="2026-12-01T09:00:00+00:00"
                value={time}
                onChange={(e) => {
                  setTime(e.target.value);
                  setPreview([]);
                }}
              />
            </label>
          ) : (
            <label className="chat-form-field">
              Five-field cron
              <input
                required
                maxLength={120}
                value={cron}
                onChange={(e) => {
                  setCron(e.target.value);
                  setPreview([]);
                }}
              />
            </label>
          )}
          <label className="chat-form-field">
            IANA timezone
            <input
              required
              maxLength={100}
              value={zone}
              onChange={(e) => {
                setZone(e.target.value);
                setPreview([]);
              }}
            />
          </label>
          <label className="chat-form-field">
            After downtime
            <select
              value={catchUp}
              onChange={(e) => setCatchUp(e.target.value as "latest" | "none")}
            >
              <option value="latest">
                Run latest missed occurrence within lateness limit
              </option>
              <option value="none">Skip missed occurrences</option>
            </select>
          </label>
          <label className="chat-form-field">
            Maximum lateness (seconds)
            <input
              required
              type="number"
              min={60}
              max={86400}
              value={lateness}
              onChange={(e) => setLateness(Number(e.target.value))}
            />
          </label>
          <p className="chat-form-hint">
            Works only while Jelly runs; cannot wake a sleeping host.
            Busy/provider-blocked work expires at this deadline. No automatic
            retry after a run starts. Cron uses day-of-month OR day-of-week; DST
            gaps skip, repeated times run once.
          </p>
          <button
            type="button"
            className="secondary"
            onClick={() => void submit(true)}
          >
            Preview times
          </button>
          {preview.length > 0 && (
            <ol aria-label="Upcoming times">
              {preview.map((time) => (
                <li key={time}>{time}</li>
              ))}
            </ol>
          )}
          <ChatFormActions>
            <button type="button" className="secondary" onClick={onDone}>
              Back
            </button>
            <button type="submit" className="primary">
              {busy ? "Saving…" : "Save schedule"}
            </button>
          </ChatFormActions>
        </fieldset>
      </form>
    </ChatFormCard>
  );
}
export function SchedulesPanel({
  agentId,
  initialId,
  onClose,
}: {
  agentId: string;
  initialId?: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<ScheduleReceipt[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [activeCount, setActiveCount] = useState(0);
  const loadedMore = useRef(false);
  const [selected, setSelected] = useState(initialId ?? "");
  const [editing, setEditing] = useState<ScheduleReceipt | null>(null);
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<OccurrencesPage>({
    items: [],
    before: null,
  });
  const historyPages = useRef<(string | undefined)[]>([undefined]);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [notice, setNotice] = useState("");
  const actionKeys = useRef(new Map<string, string>());
  const current = items.find((item) => item.schedule.id === selected);
  function mergeItems(incoming: ScheduleReceipt[]) {
    setItems((old) =>
      [
        ...new Map(
          [...old, ...incoming].map((item) => [item.schedule.id, item]),
        ).values(),
      ].sort(
        (a, b) =>
          b.schedule.createdAt.localeCompare(a.schedule.createdAt) ||
          b.schedule.id.localeCompare(a.schedule.id),
      ),
    );
  }
  function updatePage(page: SchedulesPage) {
    mergeItems(page.items);
    setActiveCount(page.activeCount);
    if (!loadedMore.current) setBefore(page.before);
  }
  async function load() {
    updatePage(await schedulesApi.list(agentId));
    if (selected) {
      mergeItems([await schedulesApi.get(agentId, selected)]);
      setHistoryRefresh((value) => value + 1);
    }
  }
  useEffect(() => {
    let alive = true;
    const update = () =>
      schedulesApi
        .list(agentId)
        .then((value) => {
          if (alive) updatePage(value);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    const updateSelected = async () => {
      await update();
      if (selected)
        try {
          const receipt = await schedulesApi.get(agentId, selected);
          if (alive) {
            mergeItems([receipt]);
            setHistoryRefresh((value) => value + 1);
          }
        } catch (error) {
          if (alive) setError((error as Error).message);
        }
    };
    void updateSelected();
    const timer = setInterval(updateSelected, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [agentId, selected]);
  useEffect(() => {
    setHistory({ items: [], before: null });
    historyPages.current = [undefined];
  }, [agentId, selected]);
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    const cursors = [...historyPages.current];
    // A newer overlap skip can mask any older occurrence transition in `latest`.
    // Polls and management refreshes reconcile every loaded page, even when
    // latest and runningRunId stay unchanged (e.g. pending -> cancelled/expired).
    void Promise.all(
      cursors.map((before) => schedulesApi.history(agentId, selected, before)),
    )
      .then((pages) => {
        if (alive)
          setHistory((old) => ({
            items: [
              ...new Map(
                [...old.items, ...pages.flatMap((page) => page.items)].map(
                  (item) => [item.id, item],
                ),
              ).values(),
            ].sort(
              (a, b) =>
                b.scheduledFor.localeCompare(a.scheduledFor) ||
                b.id.localeCompare(a.id),
            ),
            before:
              cursors.length === historyPages.current.length
                ? pages.at(-1)!.before
                : old.before,
          }));
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [
    agentId,
    selected,
    current?.latest?.id,
    current?.latest?.state,
    current?.runningRunId,
    historyRefresh,
  ]);
  function mutate(
    item: ScheduleReceipt,
    action: "pause" | "resume" | "cancel",
  ) {
    const payload = `${item.schedule.id}:${item.schedule.revision}:${action}`;
    if (!actionKeys.current.has(payload))
      actionKeys.current.set(payload, requestId());
    return schedulesApi.change(agentId, item.schedule.id, action, {
      expectedRevision: item.schedule.revision,
      requestId: actionKeys.current.get(payload)!,
    });
  }
  async function action(
    item: ScheduleReceipt,
    action: "pause" | "resume" | "cancel",
  ) {
    setBusy(true);
    setError("");
    try {
      const receipt = await mutate(item, action);
      setNotice(
        receipt.runningRunId
          ? "A run already started and continues. Use Stop in the conversation separately."
          : action === "resume"
            ? "Resumed from now; paused-period occurrences will not run."
            : "No run is currently started for this schedule. Unstarted work was cancelled.",
      );
      await load();
      return receipt;
    } catch (error) {
      setError((error as Error).message);
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Schedules"
      onClose={onClose}
      detent="large"
      dismissible={!busy}
      dirty={dirty}
    >
      <div className="schedules-panel">
        <p className="chat-form-hint">
          Schedules run in this conversation. Pause/cancel does not stop a run
          already admitted. Stop cancels unstarted due work, but future cron
          ticks remain enabled.
        </p>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {creating || editing ? (
          <ScheduleEditor
            key={creating ? "new" : selected}
            agentId={agentId}
            receipt={creating ? undefined : editing!}
            onBusy={setBusy}
            onDirty={setDirty}
            onDone={() => {
              setEditing(null);
              setCreating(false);
              setDirty(false);
              void load().catch((e) => setError(e.message));
            }}
          />
        ) : (
          <>
            <ChatFormActions>
              <button
                className="secondary"
                disabled={busy || activeCount === 0}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  setNotice("");
                  const failures: string[] = [];
                  try {
                    const page = await schedulesApi.list(agentId, {
                      state: "active",
                      limit: 100,
                    });
                    let alreadyRunning = false,
                      paused = 0;
                    for (const item of page.items) {
                      try {
                        const receipt = await mutate(item, "pause");
                        alreadyRunning ||= !!receipt.runningRunId;
                        paused++;
                      } catch (error) {
                        failures.push(
                          `${item.schedule.title} (${item.schedule.id}): ${(error as Error).message}`,
                        );
                      }
                    }
                    setNotice(
                      `Paused ${paused} of ${page.items.length} schedules.${alreadyRunning ? " An admitted run continues; use Stop separately." : ""}`,
                    );
                    if (failures.length)
                      setError(`Could not pause: ${failures.join("; ")}`);
                    await load();
                  } catch (error) {
                    setError(
                      [...failures, (error as Error).message].join("; "),
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Pause schedules
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => setCreating(true)}
              >
                New schedule
              </button>
            </ChatFormActions>
            {!items.length && <p>No schedules yet.</p>}
            <ul className="schedule-list">
              {items.map((item) => (
                <li key={item.schedule.id}>
                  <button
                    type="button"
                    className="settings-row"
                    disabled={busy}
                    aria-expanded={selected === item.schedule.id}
                    onClick={() =>
                      setSelected(
                        selected === item.schedule.id ? "" : item.schedule.id,
                      )
                    }
                  >
                    <span>
                      <strong>{item.schedule.title}</strong>
                      <small>{scheduleTiming(item.schedule)}</small>
                      <small>
                        {item.schedule.state} · Next:{" "}
                        {item.schedule.nextRunAt ?? "none"}
                      </small>
                      <small>
                        Latest: {item.latest?.state ?? "not run"}
                        {item.latest?.reason ? ` — ${item.latest.reason}` : ""}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {before && (
              <button
                className="secondary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const page = await schedulesApi.list(agentId, { before });
                    loadedMore.current = true;
                    mergeItems(page.items);
                    setBefore(page.before);
                    setActiveCount(page.activeCount);
                  } catch (error) {
                    setError((error as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Load older schedules
              </button>
            )}
            {current && (
              <ChatFormCard
                title={current.schedule.title}
                icon={<CalendarClock size={19} />}
                status={current.schedule.state}
              >
                <p className="schedule-prompt">{current.schedule.prompt}</p>
                <p>{scheduleTiming(current.schedule)}</p>
                <p>
                  Catch-up: {current.schedule.catchUp}; lateness limit:{" "}
                  {current.schedule.maxLatenessSeconds} seconds.
                </p>
                <p className="chat-form-hint">{current.notice}</p>
                {current.runningRunId && (
                  <>
                    <p>
                      A run already started; it retains its original task
                      snapshot.
                    </p>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setError("");
                        try {
                          await post(
                            `/agents/${encodeURIComponent(agentId)}/stop`,
                            {},
                          );
                          await load();
                          setNotice(
                            "Stopped the agent and unstarted due tasks. Future cron ticks remain enabled; use Pause schedules to disable them.",
                          );
                        } catch (error) {
                          setError((error as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Stop agent
                    </button>
                  </>
                )}
                {current.schedule.lastDispatchError && (
                  <p role="status">
                    Blocked: {current.schedule.lastDispatchError}. Check the
                    model connection in Settings or pause/cancel. Next safe
                    retry: {current.schedule.retryAt}
                  </p>
                )}
                {current.preview.length > 0 && (
                  <ol aria-label="Upcoming times">
                    {current.preview.map((time) => (
                      <li key={time}>{time}</li>
                    ))}
                  </ol>
                )}
                {["active", "paused"].includes(current.schedule.state) && (
                  <ChatFormActions>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => setEditing(current)}
                    >
                      Edit
                    </button>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void action(
                          current,
                          current.schedule.state === "active"
                            ? "pause"
                            : "resume",
                        )
                      }
                    >
                      {current.schedule.state === "active" ? "Pause" : "Resume"}
                    </button>
                    <button
                      className="secondary danger"
                      disabled={busy}
                      onClick={() => void action(current, "cancel")}
                    >
                      Cancel schedule
                    </button>
                  </ChatFormActions>
                )}
                <h4>Execution history</h4>
                <ul className="schedule-history">
                  {history.items.map((item) => (
                    <li key={item.id}>
                      <strong>{item.state}</strong> · {item.scheduledFor}
                      <p>{item.reason ?? item.wakeReason}</p>
                      <details className="schedule-details">
                        <summary>Task snapshot and admission</summary>
                        <p className="schedule-prompt">
                          {item.snapshot.prompt}
                        </p>
                        <p>
                          Revision {item.scheduleRevision} · Admitted:{" "}
                          {item.admittedAt ?? "not admitted"} · Finished:{" "}
                          {item.finishedAt ?? "not finished"}
                        </p>
                        <code>{item.runId}</code>
                      </details>
                    </li>
                  ))}
                </ul>
                {!history.items.length && <p>No occurrences yet.</p>}
                {history.before && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        const page = await schedulesApi.history(
                          agentId,
                          selected,
                          history.before!,
                        );
                        if (!historyPages.current.includes(history.before!))
                          historyPages.current.push(history.before!);
                        setHistory((old) => ({
                          items: [
                            ...new Map(
                              [...old.items, ...page.items].map((item) => [
                                item.id,
                                item,
                              ]),
                            ).values(),
                          ],
                          before: page.before,
                        }));
                      } catch (error) {
                        setError((error as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Load older occurrences
                  </button>
                )}
              </ChatFormCard>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
