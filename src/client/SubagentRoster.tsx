import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Brain, ChevronRight, LoaderCircle, Terminal } from "lucide-react";
import {
  subagentIsActive,
  type SubagentCard,
  type SubagentSnapshot,
  type SubagentTranscript,
  type SubagentTranscriptEntry,
} from "../shared/subagents";
import { projectApi } from "./api";
import { MessageText } from "./MessageText";
import "./subagents.css";

const POLL_MS = 3000;
const MAX_ENTRIES = 1000;
const MAX_OLDER_PAGES = 5;

function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Child tool output can contain terminal control sequences, not just Markdown.
function displayText(text: string) {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function TranscriptEntry({ entry }: { entry: SubagentTranscriptEntry }) {
  if (entry.kind === "text")
    return <MessageText text={displayText(entry.text)} />;
  const thinking = entry.kind === "thinking";
  return (
    <details className="work-step subagent-entry" data-entry-id={entry.id}>
      <summary>
        {thinking ? (
          <Brain size={16} aria-hidden="true" />
        ) : (
          <Terminal size={16} aria-hidden="true" />
        )}
        <span>
          {thinking
            ? "Thinking"
            : `${entry.name ?? "Tool"} · ${entry.kind === "toolCall" ? "Input" : entry.isError ? "Error" : "Result"}`}
        </span>
        <ChevronRight size={14} className="work-chevron" aria-hidden="true" />
      </summary>
      <div className="work-step-details">
        {thinking ? (
          <MessageText text={displayText(entry.text)} />
        ) : (
          <pre>{displayText(entry.text)}</pre>
        )}
      </div>
    </details>
  );
}

function ChildTranscript({ path, active }: { path: string; active: boolean }) {
  const [page, setPage] = useState<SubagentTranscript>();
  const pageRef = useRef<SubagentTranscript | undefined>(undefined);
  const [error, setError] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderPages, setOlderPages] = useState(0);
  const limited = (page?.entries.length ?? 0) >= MAX_ENTRIES;
  const pagesRead = useRef(0);
  const transcript = useRef<HTMLElement>(null);
  const previousScroll = useRef<{ height: number; top: number } | undefined>(
    undefined,
  );
  const loadOlder = useRef<((before: number) => void) | undefined>(undefined);
  // All requests belong to this expansion. Closing it aborts both polling and paging.
  useEffect(() => {
    let alive = true;
    let busy = false;
    let olderBusy = false;
    const controllers = new Set<AbortController>();
    const read = async (before?: number) => {
      if (!alive || busy || olderBusy) return;
      const older = before !== undefined;
      if (older && pagesRead.current >= MAX_OLDER_PAGES) return;
      if (older) {
        olderBusy = true;
        setLoadingOlder(true);
      } else busy = true;
      const controller = new AbortController();
      controllers.add(controller);
      try {
        const next = await projectApi<SubagentTranscript>(
          `${path}/transcript${older ? `?before=${before}` : ""}`,
          { signal: controller.signal },
        );
        if (!alive) return;
        if (older) {
          setOlderPages(++pagesRead.current);
          if (transcript.current)
            previousScroll.current = {
              height: transcript.current.scrollHeight,
              top: transcript.current.scrollTop,
            };
        }
        const previous = pageRef.current;
        const previousIds = new Set(previous?.entries.map((entry) => entry.id));
        // A bounded live tail can jump past the entire displayed excerpt. Keep
        // one contiguous excerpt and its cursor, never silently merge a gap.
        const reset =
          previous?.generation !== next.generation ||
          (!older &&
            (!previous?.entries.length ||
              (next.entries.length > 0 &&
                !next.entries.some((entry) => previousIds.has(entry.id)))));
        let merged = next;
        if (!next.unavailable && !reset) {
          // Stable IDs preserve opened disclosures for overlapping refreshes.
          const entries = new Map<string, SubagentTranscriptEntry>();
          const combined = older
            ? [...next.entries, ...(previous?.entries ?? [])]
            : [...(previous?.entries ?? []), ...next.entries];
          for (const entry of combined) entries.set(entry.id, entry);
          const all = [...entries.values()];
          merged = {
            ...next,
            entries: all.slice(-MAX_ENTRIES),
            before: older || !previous ? next.before : previous.before,
            truncated:
              next.truncated ||
              !!previous?.truncated ||
              all.length > MAX_ENTRIES,
          };
        }
        if (reset) {
          previousScroll.current = undefined;
          pagesRead.current = 0;
          setOlderPages(0);
        }
        pageRef.current = merged;
        setPage(merged);
        setError("");
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        controllers.delete(controller);
        if (older) olderBusy = false;
        else busy = false;
        if (alive) setLoadingOlder(false);
      }
    };
    loadOlder.current = (before) => void read(before);
    void read();
    const timer = active ? setInterval(() => void read(), POLL_MS) : undefined;
    return () => {
      alive = false;
      clearInterval(timer);
      for (const controller of controllers) controller.abort();
      loadOlder.current = undefined;
    };
  }, [path, active]);

  useLayoutEffect(() => {
    const element = transcript.current;
    const previous = previousScroll.current;
    if (element && previous)
      element.scrollTop = previous.top + element.scrollHeight - previous.height;
    previousScroll.current = undefined;
  }, [page]);

  return (
    <section
      ref={transcript}
      className="subagent-transcript"
      aria-label="Subagent transcript"
      tabIndex={0}
    >
      {error && <p role="alert">Could not load transcript: {error}</p>}
      {!page && !error && (
        <p className="subtle" role="status">
          Loading transcript…
        </p>
      )}
      {page?.unavailable ? (
        <p className="subtle">Transcript unavailable: {page.unavailable}</p>
      ) : (
        page && (
          <>
            {page.before !== null && (
              <button
                type="button"
                className="secondary"
                disabled={
                  loadingOlder || olderPages >= MAX_OLDER_PAGES || limited
                }
                onClick={() =>
                  page.before !== null && loadOlder.current?.(page.before)
                }
              >
                {loadingOlder ? "Loading earlier…" : "Load earlier activity"}
              </button>
            )}
            {(page.truncated || limited || olderPages >= MAX_OLDER_PAGES) && (
              <p className="subtle">
                Showing a bounded transcript excerpt
                {limited || olderPages >= MAX_OLDER_PAGES
                  ? "; inspection limit reached"
                  : ""}
                .
              </p>
            )}
            {!page.entries.some((entry) => entry.kind === "thinking") && (
              <p className="subtle">No thinking summary available.</p>
            )}
            {!page.entries.length && (
              <p className="subtle">No transcript activity recorded yet.</p>
            )}
            {page.entries.map((entry) => (
              <div
                key={`${page.generation ?? ""}:${entry.id}`}
                data-entry-id={entry.id}
              >
                <TranscriptEntry entry={entry} />
              </div>
            ))}
          </>
        )
      )}
    </section>
  );
}

function ChildCard({
  child,
  path,
  parentActive,
  parentEndedAt,
  now,
}: {
  child: SubagentCard;
  path: string;
  parentActive: boolean;
  parentEndedAt?: number;
  now: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const unsettled = subagentIsActive(child.state);
  const active = parentActive && unsettled;
  const stale = unsettled && !parentActive;
  const status = stale
    ? "Unknown · parent ended"
    : child.state[0]!.toUpperCase() + child.state.slice(1);
  const elapsedEnd = child.endedAt ?? (active ? now : parentEndedAt);
  const age =
    child.lastActivityAt === undefined ? undefined : now - child.lastActivityAt;
  return (
    <details
      className="subagent-card"
      data-child-id={child.id}
      onToggle={(event) => {
        if (event.target === event.currentTarget)
          setExpanded(event.currentTarget.open);
      }}
    >
      <summary>
        <ChevronRight size={16} className="work-chevron" aria-hidden="true" />
        <span className="subagent-card-content">
          <span className="subagent-label">
            <strong>{child.agent}</strong> ·{" "}
            {child.label || child.task || "Delegated task"}
          </span>
          <span className="subagent-meta">
            {active && child.state === "running" && (
              <LoaderCircle size={14} className="spin" aria-hidden="true" />
            )}
            <span>{status}</span>
            {child.startedAt !== undefined && elapsedEnd !== undefined && (
              <span> · {duration(elapsedEnd - child.startedAt)} elapsed</span>
            )}
            {child.currentTool && (
              <span>
                {" "}
                · {active ? "Using" : "Last tool"}: {child.currentTool}
                {active && child.currentToolStartedAt !== undefined
                  ? ` (${duration(now - child.currentToolStartedAt)})`
                  : ""}
              </span>
            )}
            <span>
              {" "}
              ·{" "}
              {age === undefined
                ? "Activity time unknown"
                : age > 60000
                  ? `No recent activity · last activity ${duration(age)} ago`
                  : `Last activity ${duration(age)} ago`}
            </span>
          </span>
          {child.attention && (
            <span className="subagent-attention">
              Needs attention: {child.attention}
            </span>
          )}
        </span>
      </summary>
      {expanded && (
        <div className="subagent-details">
          <h4>Task</h4>
          <MessageText text={displayText(child.task ?? child.label)} />
          {child.error && (
            <p className="error-text">{displayText(child.error)}</p>
          )}
          {stale && (
            <p className="subtle">
              The parent run ended without a final child status. This is not a
              live status.
            </p>
          )}
          {child.inspectable ? (
            <ChildTranscript
              path={`${path}/${encodeURIComponent(child.id)}`}
              active={active}
            />
          ) : (
            <p className="subtle">
              Transcript unavailable: no recorded transcript.
            </p>
          )}
        </div>
      )}
    </details>
  );
}

/** One instance per conversation work entry, outside its generic disclosure. */
export function SubagentRoster({
  agentId,
  runId,
  active,
  endedAt,
  revision,
}: {
  agentId: string;
  runId: string;
  active: boolean;
  endedAt?: string | null;
  revision?: number;
}) {
  const [snapshot, setSnapshot] = useState<SubagentSnapshot>();
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const refresh = useRef<(() => void) | undefined>(undefined);
  const path = `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/subagents`;
  useEffect(() => {
    let alive = true;
    let busy = false;
    let again = false;
    const controller = new AbortController();
    const load = async () => {
      if (!alive) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        const next = await projectApi<SubagentSnapshot>(path, {
          signal: controller.signal,
        });
        if (!alive) return;
        setSnapshot(next);
        setError("");
        setNow(Date.now());
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        busy = false;
        if (alive && again) {
          again = false;
          void load();
        }
      }
    };
    refresh.current = () => void load();
    void load();
    const timer = active
      ? setInterval(() => {
          setNow(Date.now());
          void load();
        }, POLL_MS)
      : undefined;
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
      refresh.current = undefined;
    };
  }, [path, active]);
  useEffect(() => {
    if (revision) refresh.current?.();
  }, [revision]);

  if (
    !snapshot?.children.length &&
    !snapshot?.omitted &&
    !snapshot?.error &&
    !error
  )
    return null;
  const groups = new Map<
    string,
    { label?: string; children: SubagentCard[] }
  >();
  for (const child of snapshot?.children ?? []) {
    const key = child.workflow ? `workflow:${child.rootId}` : "direct";
    if (!groups.has(key))
      groups.set(key, { label: child.workflow, children: [] });
    groups.get(key)!.children.push(child);
  }
  const children = snapshot?.children ?? [];
  const running = active
    ? children.filter((child) => child.state === "running").length
    : 0;
  const completed = children.filter(
    (child) => child.state === "completed",
  ).length;
  return (
    <section
      className="subagent-roster"
      aria-label="Subagents"
      data-subagent-run-id={runId}
    >
      <h3>
        Subagents{running > 0 ? ` · ${running} running` : ""}
        {completed > 0 ? ` · ${completed} complete` : ""}
      </h3>
      {(error || snapshot?.error) && (
        <p role="status" className="subtle">
          Subagent status unavailable: {error || snapshot?.error}. Saved status
          may be out of date.
        </p>
      )}
      {Boolean(snapshot?.omitted) && (
        <p className="subtle">
          {snapshot!.omitted} additional subagents omitted from this snapshot.
        </p>
      )}
      {[...groups].map(([key, group]) => (
        <div key={key} className="subagent-group">
          {group.label && <h4>Workflow · {group.label}</h4>}
          {group.children.map((child) => (
            <ChildCard
              key={child.id}
              child={child}
              path={path}
              parentActive={active}
              parentEndedAt={endedAt ? Date.parse(endedAt) : undefined}
              now={now}
            />
          ))}
        </div>
      ))}
    </section>
  );
}
