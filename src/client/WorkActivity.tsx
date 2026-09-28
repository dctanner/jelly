import { useState, type ReactNode } from "react";
import {
  Brain,
  ChevronRight,
  Terminal,
  LoaderCircle,
  AlertCircle,
} from "lucide-react";
import type { Activity, AgentRecord, RunRecord } from "../shared/types";
import { MessageText } from "./MessageText";
import { toolResultForDisplay } from "../shared/tool-images";
import { workDuration, workState } from "./conversationActivity";
const toolLabels: Record<string, string> = {
  read: "Read file",
  write: "Write file",
  edit: "Edit file",
  bash: "Run command",
  powershell: "Run PowerShell",
  grep: "Search files",
  find: "Find files",
  ls: "List files",
  web_search: "Search the web",
  web_fetch: "Read webpage",
  generate_image: "Generate image",
  browser_open: "Open browser",
  browser_screenshot: "Check browser",
  browser_click: "Use browser",
  subagent: "Delegate work",
  request_sudo: "Administrator access",
  request_browser_login: "Browser sign-in",
};

function ToolStep({
  event,
  end,
  settled,
  completed,
}: {
  event: Activity;
  end?: Activity;
  settled: boolean;
  completed: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const name = String(event.data.name ?? "Tool");
  const failed = !!end?.data.isError;
  const pending = !end && !settled;
  const label =
    name === "instance_info"
      ? pending
        ? "Checking workspace"
        : "Workspace checked"
      : (toolLabels[name] ?? name.replaceAll("_", " "));
  const status = end
    ? failed
      ? "Tool failed"
      : "Tool completed"
    : settled
      ? completed
        ? "Result outside loaded activity"
        : "Tool interrupted"
      : "Using tool";
  return (
    <details
      className="work-step"
      onToggle={(e) => setExpanded(e.currentTarget.open)}
    >
      <summary>
        {pending ? (
          <LoaderCircle size={16} className="spin" aria-hidden="true" />
        ) : failed || (settled && !end && !completed) ? (
          <AlertCircle size={16} aria-hidden="true" />
        ) : (
          <Terminal size={16} aria-hidden="true" />
        )}
        <span className="work-step-label">{label}</span>
        <span className="sr-only"> · {status}</span>
        <ChevronRight size={14} className="work-chevron" aria-hidden="true" />
      </summary>
      {expanded && (
        <div className="work-step-details">
          <code>{name}</code>
          {event.type === "tool_started" && (
            <>
              <h4>Input</h4>
              <pre>{JSON.stringify(event.data.args ?? {}, null, 2)}</pre>
            </>
          )}
          {end ? (
            <>
              <h4>{failed ? "Error" : "Result"}</h4>
              <pre>
                {JSON.stringify(toolResultForDisplay(end.data.result), null, 2)}
              </pre>
            </>
          ) : (
            <p className="subtle">{status}</p>
          )}
        </div>
      )}
    </details>
  );
}

export function WorkActivity({
  events,
  run,
  agent,
  stopping,
  renderEvent,
}: {
  events: Activity[];
  run?: RunRecord;
  agent: AgentRecord;
  stopping: boolean;
  renderEvent: (event: Activity) => ReactNode;
}) {
  const { terminal, status, active } = workState(events, run);
  const duration = workDuration(
    run?.startedAt ??
      events.find((event) => event.type === "run_started")?.createdAt,
    run?.endedAt ?? terminal?.createdAt,
  );
  const settledLabel =
    status === "failed"
      ? "Failed after"
      : status === "cancelled"
        ? "Stopped after"
        : status === "interrupted"
          ? "Interrupted after"
          : "Worked for";
  const label = active
    ? `${agent.name} is ${stopping ? "Stopping" : agent.status === "waiting" ? "Waiting for you" : "Working"}`
    : duration
      ? `${settledLabel} ${duration}`
      : status === "failed"
        ? "Work failed"
        : status === "cancelled"
          ? "Stopped"
          : status === "interrupted"
            ? "Interrupted"
            : "Worked";
  const thinking = events.filter(
    (event) =>
      event.type === "thinking" &&
      typeof event.data.text === "string" &&
      event.data.text.trim(),
  );
  const starts = new Set(
    events
      .filter((event) => event.type === "tool_started")
      .map((event) => event.data.toolCallId),
  );
  const ends = new Map(
    events
      .filter((event) => event.type === "tool_completed")
      .map((event) => [event.data.toolCallId, event]),
  );
  const tools = events.filter(
    (event) =>
      event.type === "tool_started" ||
      (event.type === "tool_completed" && !starts.has(event.data.toolCallId)),
  );
  const notes = events.filter(
    (event) =>
      event.type.startsWith("compaction_") ||
      event.type.startsWith("subagent_"),
  );
  return (
    <details
      className={`work-activity${active ? " is-working" : ""}`}
      data-run-id={run?.id ?? events[0]?.runId}
    >
      <summary>
        <span
          role="status"
          className={
            active && !stopping && agent.status !== "waiting"
              ? "work-status-sheen"
              : undefined
          }
        >
          {label}
        </span>
        <ChevronRight size={16} className="work-chevron" aria-hidden="true" />
      </summary>
      <div className="work-activity-items">
        <section className="work-thinking" aria-label="Thinking">
          <div className="work-thinking-heading">
            <Brain size={16} aria-hidden="true" />
            <span>Thinking</span>
          </div>
          {thinking.length ? (
            thinking.map((event) => (
              <MessageText key={event.id} text={String(event.data.text)} />
            ))
          ) : (
            <p className="subtle">
              {active
                ? "Thinking…"
                : "No thinking summary was recorded for this run."}
            </p>
          )}
        </section>
        <div className="work-tools" aria-label="Tool calls">
          {tools.map((event) => (
            <ToolStep
              key={event.id}
              event={event}
              end={ends.get(event.data.toolCallId)}
              settled={!active}
              completed={status === "completed"}
            />
          ))}
        </div>
        {notes.map(renderEvent)}
        {run?.mode === "demo" && <p className="subtle work-demo">Local demo</p>}
      </div>
    </details>
  );
}
