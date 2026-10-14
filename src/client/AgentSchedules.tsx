import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import type { ScheduleRecord } from "../shared/types";

const PRESETS = [
  { cron: "*/15 * * * *", label: "Every 15 minutes" },
  { cron: "0 * * * *", label: "Every hour" },
  { cron: "0 9 * * *", label: "Every day at 9:00" },
  { cron: "0 9 * * 1-5", label: "Weekdays at 9:00" },
  { cron: "0 9 * * 1", label: "Mondays at 9:00" },
];
type Suggestion = {
  cron: string;
  once: boolean;
  prompt: string | null;
  summary: string | null;
  nextRuns: string[];
};
const describe = (cron: string) =>
  PRESETS.find((p) => p.cron === cron)?.label ?? cron;
const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";

export function AgentSchedules({
  agentId,
  archived,
  disabled = false,
  onDirty,
}: {
  agentId: string;
  archived: boolean;
  disabled?: boolean;
  onDirty?: (dirty: boolean) => void;
}) {
  const [schedules, setSchedules] = useState<ScheduleRecord[] | null>(null);
  const [timeZone, setTimeZone] = useState("");
  const [editing, setEditing] = useState<ScheduleRecord | "new" | null>(null);
  const [cron, setCron] = useState(PRESETS[2]!.cron);
  const [prompt, setPrompt] = useState("");
  const [once, setOnce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [description, setDescription] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState("");
  const [suggested, setSuggested] = useState<{
    cron: string;
    summary: string | null;
  } | null>(null);
  const [preview, setPreview] = useState<{
    cron: string;
    nextRuns?: string[];
    error?: string;
  } | null>(null);
  const load = useCallback(async () => {
    try {
      const result = await api<{
        timeZone: string;
        schedules: ScheduleRecord[];
      }>(`/agents/${agentId}/schedules`);
      setSchedules(result.schedules);
      setTimeZone(result.timeZone);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [agentId]);
  useEffect(() => {
    void load();
  }, [load]);
  const dirty =
    editing !== null &&
    (editing === "new"
      ? prompt.trim() !== ""
      : cron !== editing.cron ||
        prompt !== editing.prompt ||
        once !== editing.once);
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);
  function edit(schedule: ScheduleRecord | "new") {
    setEditing(schedule);
    setCron(schedule === "new" ? PRESETS[2]!.cron : schedule.cron);
    setPrompt(schedule === "new" ? "" : schedule.prompt);
    setOnce(schedule === "new" ? false : schedule.once);
    setError("");
    setDescription("");
    setParseError("");
    setSuggested(null);
  }
  // Confirm any expression, typed or suggested, against the server's clock.
  useEffect(() => {
    if (!editing) return;
    let current = true;
    const timer = setTimeout(() => {
      api<Suggestion>(`/agents/${agentId}/schedules/parse`, {
        method: "POST",
        body: JSON.stringify({ cron }),
      })
        .then(
          (result) =>
            current && setPreview({ cron, nextRuns: result.nextRuns }),
        )
        .catch(
          (e) => current && setPreview({ cron, error: (e as Error).message }),
        );
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [agentId, cron, editing]);
  async function understand() {
    if (!description.trim() || parsing) return;
    setParsing(true);
    setParseError("");
    try {
      const result = await api<Suggestion>(
        `/agents/${agentId}/schedules/parse`,
        {
          method: "POST",
          body: JSON.stringify({ text: description }),
        },
      );
      setCron(result.cron);
      setSuggested({ cron: result.cron, summary: result.summary });
      setOnce(result.once);
      setPreview({ cron: result.cron, nextRuns: result.nextRuns });
      if (result.prompt && !prompt.trim()) setPrompt(result.prompt);
    } catch (e) {
      setParseError((e as Error).message);
    } finally {
      setParsing(false);
    }
  }
  async function mutate(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = JSON.stringify({ cron, prompt, once });
    const saved = await mutate(() =>
      editing === "new" || !editing
        ? api(`/agents/${agentId}/schedules`, { method: "POST", body })
        : api(`/schedules/${editing.id}`, { method: "PATCH", body }),
    );
    if (saved) setEditing(null);
  }
  if (editing)
    return (
      <form onSubmit={submit}>
        <fieldset className="profile-fields" disabled={disabled || busy}>
          <div className="schedule-describe">
            <label>
              Describe it
              <input
                value={description}
                maxLength={1000}
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void understand();
                  }
                }}
                placeholder="e.g. every weekday at 9am, check my inbox"
                aria-describedby="schedule-describe-hint"
              />
            </label>
            <button
              type="button"
              className="secondary"
              disabled={parsing || !description.trim()}
              onClick={() => void understand()}
            >
              {parsing ? "Reading…" : "Fill in"}
            </button>
          </div>
          <small id="schedule-describe-hint" className="schedule-hint">
            Uses this agent's model once, outside its conversation. Check the
            result below before saving.
          </small>
          {parseError && (
            <p role="alert" className="error-text">
              {parseError}
            </p>
          )}
          <label className="schedule-toggle">
            <input
              type="checkbox"
              checked={once}
              onChange={(e) => setOnce(e.target.checked)}
            />
            <span>Run once, then pause</span>
          </label>
          {!once && (
            <label>
              Repeat
              <select
                value={PRESETS.some((p) => p.cron === cron) ? cron : ""}
                onChange={(e) => e.target.value && setCron(e.target.value)}
              >
                {PRESETS.map((p) => (
                  <option key={p.cron} value={p.cron}>
                    {p.label}
                  </option>
                ))}
                <option value="">Custom</option>
              </select>
            </label>
          )}
          <label>
            Cron expression
            <input
              required
              maxLength={100}
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="minute hour day month weekday"
              autoCapitalize="none"
              spellCheck={false}
            />
            <small>
              Five fields, e.g. <code>30 8 * * 1-5</code>, or{" "}
              <code>@hourly</code>/<code>@daily</code>. Times use the server's
              time zone{timeZone ? ` (${timeZone})` : ""}.
            </small>
          </label>
          {preview?.cron === cron && (
            <p
              className={preview.error ? "error-text" : "schedule-preview"}
              role="status"
            >
              {preview.error ??
                [
                  suggested?.cron === cron ? suggested.summary : null,
                  once
                    ? `Runs once: ${when(preview.nextRuns![0]!)}`
                    : `Next: ${preview.nextRuns!.map(when).join(" · ")}`,
                ]
                  .filter(Boolean)
                  .join(" — ")}
            </p>
          )}
          <label>
            Message
            <textarea
              required
              rows={5}
              maxLength={24000}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Check my inbox for new bug reports. Reply to each sender with what you found."
            />
            <small>
              Sent to this agent as if you typed it. If the agent is busy, it
              waits in the queue.
            </small>
          </label>
        </fieldset>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <button className="primary wide" disabled={disabled || busy}>
          {busy ? "Saving…" : "Save schedule"}
        </button>
        <button
          type="button"
          className="secondary wide"
          disabled={busy}
          onClick={() => setEditing(null)}
        >
          Cancel
        </button>
      </form>
    );
  return (
    <div className="agent-schedules">
      <p className="subtle">
        Send this agent a message on a schedule — for example, to check an
        MCP-connected inbox, or once at a set time. Schedules run only while
        Jelly is running; missed times are skipped.
      </p>
      {schedules === null && !error && <p role="status">Loading…</p>}
      {schedules?.length === 0 && <p className="subtle">No schedules yet.</p>}
      {!!schedules?.length && (
        <div className="settings-group">
          {schedules.map((s) => (
            <div className="schedule-item" key={s.id}>
              <label className="schedule-toggle">
                <input
                  type="checkbox"
                  aria-label={`Enable schedule: ${s.once ? `once ${when(s.nextRunAt)}` : describe(s.cron)}`}
                  checked={s.enabled}
                  disabled={disabled || busy}
                  onChange={(e) =>
                    void mutate(() =>
                      api(`/schedules/${s.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ enabled: e.target.checked }),
                      }),
                    )
                  }
                />
                <span>
                  <strong>
                    {s.once ? (
                      `Once · ${when(s.nextRunAt)}`
                    ) : describe(s.cron) === s.cron ? (
                      <code>{s.cron}</code>
                    ) : (
                      describe(s.cron)
                    )}
                  </strong>
                  <small className="schedule-prompt">{s.prompt}</small>
                  <small>
                    {archived
                      ? "Paused while the agent is archived"
                      : s.enabled
                        ? s.once
                          ? "Waiting to run"
                          : `Next: ${when(s.nextRunAt)}`
                        : s.once && s.lastRunAt
                          ? `Ran ${when(s.lastRunAt)}`
                          : "Paused"}
                    {!s.once && s.lastRunAt && ` · Last: ${when(s.lastRunAt)}`}
                  </small>
                  {s.lastError && (
                    <small className="error-text">{s.lastError}</small>
                  )}
                </span>
              </label>
              <div className="schedule-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled || busy}
                  onClick={() => edit(s)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled || busy}
                  onClick={() =>
                    void mutate(() =>
                      api(`/schedules/${s.id}`, { method: "DELETE" }),
                    )
                  }
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <button
        type="button"
        className="primary wide"
        disabled={disabled || busy}
        onClick={() => edit("new")}
      >
        Add schedule
      </button>
    </div>
  );
}
