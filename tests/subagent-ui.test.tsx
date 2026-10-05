await import("./dom");
import { afterEach, expect, test } from "bun:test";
const { render, screen, fireEvent, waitFor, cleanup, act, within } =
  await import("@testing-library/react");
import { SubagentRoster } from "../src/client/SubagentRoster";
import { conversationActivity } from "../src/client/conversationActivity";
import type { Activity } from "../src/shared/types";
import type {
  SubagentCard,
  SubagentSnapshot,
  SubagentTranscript,
} from "../src/shared/subagents";
import { App } from "../src/client/App";
import { startApp } from "./fixtures/app";
import { EventSource as NodeEventSource } from "eventsource";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
let server: Awaited<ReturnType<typeof startApp>> | undefined;
let directory: string | undefined;
afterEach(async () => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  localStorage.clear();
  if (server) await server.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  server = undefined;
  directory = undefined;
});

const now = Date.now();
const child = (overrides: Partial<SubagentCard> = {}): SubagentCard => ({
  id: "child-1",
  rootId: "root-1",
  childId: "package-child-1",
  workflow: "Website",
  agent: "Worker",
  label: "Backend changes",
  task: "Implement **backend** changes safely.",
  state: "running",
  startedAt: now - 120000,
  lastActivityAt: now - 2000,
  currentTool: "read",
  currentToolStartedAt: now - 1000,
  inspectable: true,
  ...overrides,
});
const snapshot = (children = [child()]): SubagentSnapshot => ({
  version: 1,
  updatedAt: now,
  children,
  omitted: 0,
});
const transcript = (): SubagentTranscript => ({
  entries: [
    {
      id: "thinking-1",
      kind: "thinking",
      role: "assistant",
      text: "Review **interfaces** first.",
    },
    {
      id: "text-1",
      kind: "text",
      role: "assistant",
      text: "Working on **backend**.",
    },
    {
      id: "call-1",
      kind: "toolCall",
      role: "assistant",
      name: "read",
      toolCallId: "tool-1",
      text: '{"path":"src/api.ts"}',
    },
    {
      id: "result-1",
      kind: "toolResult",
      role: "toolResult",
      name: "read",
      toolCallId: "tool-1",
      text: "\u001b[31mfile content\u001b[0m",
    },
  ],
  before: 42,
  truncated: true,
});
function fixtureApi(initial = snapshot()) {
  const fixture = {
    snapshot: initial,
    transcript: transcript(),
    requests: [] as { path: string; signal?: AbortSignal | null }[],
    respond: undefined as ((path: string) => Promise<Response>) | undefined,
  };
  globalThis.fetch = (async (input, options) => {
    const path = String(input);
    if (path === "/api/control-session")
      return Response.json({ csrf: "fixture-csrf" });
    fixture.requests.push({ path, signal: options?.signal });
    if (fixture.respond) return fixture.respond(path);
    return Response.json(
      path.includes("/transcript") ? fixture.transcript : fixture.snapshot,
    );
  }) as typeof fetch;
  return fixture;
}
function pollingClock() {
  let id = 10000;
  const callbacks = new Map<number, () => void>();
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    if (delay !== 3000) return originalSetInterval(callback, delay);
    callbacks.set(++id, callback);
    return id;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id: number) => {
    if (!callbacks.delete(id)) originalClearInterval(id);
  }) as unknown as typeof clearInterval;
  return {
    callbacks,
    tick: async () => {
      await act(async () => {
        for (const callback of [...callbacks.values()]) callback();
      });
    },
  };
}
async function openChild(id = "child-1") {
  const details = document.querySelector<HTMLDetailsElement>(
    `[data-child-id="${id}"]`,
  )!;
  await act(async () => {
    details.open = true;
    fireEvent(details, new window.Event("toggle"));
  });
  return details;
}
async function closeChild(details: HTMLDetailsElement) {
  await act(async () => {
    details.open = false;
    fireEvent(details, new window.Event("toggle"));
  });
}

test("SubagentRoster renews an expired control session before retrying inspection", async () => {
  const fixture = fixtureApi();
  let rejected = false;
  fixture.respond = async () => {
    if (!rejected) {
      rejected = true;
      return Response.json(
        { error: "Open Jelly again to establish a control session." },
        { status: 401 },
      );
    }
    return Response.json(fixture.snapshot);
  };
  render(<SubagentRoster agentId="agent" runId="run" active={false} />);
  await screen.findByText("Workflow · Website");
  expect(fixture.requests).toHaveLength(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("SubagentRoster uses the latest contiguous tail cursor after empty or nonoverlapping refreshes", async () => {
  const clock = pollingClock();
  const fixture = fixtureApi();
  fixture.transcript = { entries: [], before: null, truncated: false };
  render(<SubagentRoster agentId="agent" runId="run" active />);
  await screen.findByText("Workflow · Website");
  await openChild();
  await screen.findByText("No transcript activity recorded yet.");
  fixture.transcript = transcript();
  await clock.tick();
  await screen.findByRole("button", { name: "Load earlier activity" });
  fixture.transcript = {
    entries: [
      {
        id: "later-1",
        kind: "text",
        role: "assistant",
        text: "A nonoverlapping latest excerpt",
      },
    ],
    before: 999,
    truncated: true,
  };
  await clock.tick();
  await screen.findByText("A nonoverlapping latest excerpt");
  expect(document.querySelector("[data-entry-id='thinking-1']")).toBeNull();
  fixture.transcript = {
    entries: [
      {
        id: "gap-1",
        kind: "text",
        role: "assistant",
        text: "Previously omitted activity",
      },
    ],
    before: 42,
    truncated: true,
  };
  fireEvent.click(
    screen.getByRole("button", { name: "Load earlier activity" }),
  );
  await screen.findByText("Previously omitted activity");
  expect(fixture.requests.at(-1)!.path).toEndWith("/transcript?before=999");
});

test("SubagentRoster resets a replacement transcript generation even when byte IDs collide", async () => {
  const clock = pollingClock();
  const fixture = fixtureApi();
  fixture.transcript.generation = "attempt-a";
  render(<SubagentRoster agentId="agent" runId="run" active />);
  await screen.findByText("Workflow · Website");
  await openChild();
  await screen.findByText("file content");
  fixture.transcript = {
    generation: "attempt-b",
    entries: [
      {
        id: "thinking-1",
        kind: "thinking",
        role: "assistant",
        text: "New attempt only",
      },
    ],
    before: null,
    truncated: false,
  };
  await clock.tick();
  await screen.findByText("New attempt only");
  expect(screen.queryByText("file content")).toBeNull();
  expect(document.querySelector("[data-entry-id='text-1']")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Load earlier activity" }),
  ).toBeNull();
});

test("SubagentRoster uses authoritative fixture API, native children, lazy bounded transcript and stable IDs", async () => {
  const clock = pollingClock();
  const fixture = fixtureApi(
    snapshot([
      child(),
      child({
        id: "review",
        childId: "review",
        label: "Review changes",
        state: "queued",
        currentTool: undefined,
      }),
      child({
        id: "direct",
        rootId: "direct",
        childId: "direct",
        workflow: undefined,
        label: "Direct launch",
        state: "completed",
      }),
    ]),
  );
  const view = render(
    <SubagentRoster agentId="agent/one" runId="run/one" active />,
  );
  await screen.findByText("Workflow · Website");
  expect(
    screen.getByRole("heading", { name: "Subagents · 1 running · 1 complete" }),
  ).toBeDefined();
  expect(document.querySelectorAll(".subagent-card")).toHaveLength(3);
  expect(document.querySelectorAll(".subagent-group > h4")).toHaveLength(1);
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]!.path).toBe(
    "/api/agents/agent%2Fone/runs/run%2Fone/subagents",
  );
  expect(document.querySelector(".subagent-card > summary")).not.toBeNull();
  expect(document.querySelector(".subagent-transcript")).toBeNull();
  const details = await openChild();
  await screen.findByText("Working on", { exact: false });
  expect(screen.getByText("interfaces", { selector: "strong" })).toBeDefined();
  expect(screen.getByText('{"path":"src/api.ts"}')).toBeDefined();
  expect(screen.getByText("file content")).toBeDefined();
  expect(fixture.requests.at(-1)!.path).toEndWith("/child-1/transcript");
  const thinking = document.querySelector<HTMLDetailsElement>(
    "details[data-entry-id='thinking-1']",
  )!;
  thinking.open = true;
  const transcriptElement = screen.getByRole("region", {
    name: "Subagent transcript",
  });
  transcriptElement.scrollTop = 80;
  Object.defineProperty(transcriptElement, "scrollHeight", {
    configurable: true,
    get: () =>
      transcriptElement.querySelector("[data-entry-id='older-1']") ? 400 : 300,
  });
  fixture.transcript.entries.push({
    id: "text-2",
    kind: "text",
    role: "assistant",
    text: "New activity",
  });
  fixture.snapshot.children[0]!.currentTool = "write";
  await clock.tick();
  await screen.findByText("New activity");
  expect(details.open).toBe(true);
  expect(document.querySelector("details[data-entry-id='thinking-1']")).toBe(
    thinking,
  );
  expect(thinking.open).toBe(true);
  expect(transcriptElement.scrollTop).toBe(80);
  expect(document.querySelectorAll("div[data-entry-id='text-1']")).toHaveLength(
    1,
  );
  fixture.transcript = {
    entries: [
      {
        id: "older-1",
        kind: "text",
        role: "assistant",
        text: "Earlier activity",
      },
    ],
    before: null,
    truncated: false,
  };
  fireEvent.click(
    screen.getByRole("button", { name: "Load earlier activity" }),
  );
  await screen.findByText("Earlier activity");
  expect(transcriptElement.scrollTop).toBe(180);
  expect(fixture.requests.at(-1)!.path).toEndWith("/transcript?before=42");
  expect(
    screen.queryByRole("button", { name: "Load earlier activity" }),
  ).toBeNull();
  expect(
    document
      .querySelector(".subagent-transcript")!
      .textContent!.indexOf("Earlier activity"),
  ).toBeLessThan(
    document
      .querySelector(".subagent-transcript")!
      .textContent!.indexOf("Working on"),
  );
  expect(screen.getByText("New activity")).toBeDefined();
  view.unmount();
  expect(clock.callbacks.size).toBe(0);
});

test("SubagentRoster stops transcript reads on collapse and rejects late replies on collapse or navigation", async () => {
  const clock = pollingClock();
  const fixture = fixtureApi();
  const view = render(<SubagentRoster agentId="a" runId="r" active />);
  await screen.findByText("Workflow · Website");
  let resolve!: (response: Response) => void;
  fixture.respond = (path) =>
    path.includes("/transcript")
      ? new Promise((r) => {
          resolve = r;
        })
      : Promise.resolve(Response.json(fixture.snapshot));
  const details = await openChild();
  const pending = fixture.requests.at(-1)!;
  expect(pending.signal?.aborted).toBe(false);
  await clock.tick(); // pending reads do not overlap
  expect(
    fixture.requests.filter((request) => request.path.includes("transcript")),
  ).toHaveLength(1);
  await closeChild(details);
  expect(pending.signal?.aborted).toBe(true);
  await act(async () => resolve(Response.json(transcript())));
  expect(screen.queryByText("Working on", { exact: false })).toBeNull();
  await clock.tick();
  expect(
    fixture.requests.filter((request) => request.path.includes("transcript")),
  ).toHaveLength(1);
  expect(clock.callbacks.size).toBe(1); // roster remains live
  await openChild();
  const next = fixture.requests.at(-1)!;
  view.unmount();
  expect(next.signal?.aborted).toBe(true);
  expect(clock.callbacks.size).toBe(0);
  await act(async () => resolve(Response.json(transcript())));
  expect(document.querySelector(".subagent-roster")).toBeNull();
});

test("SubagentRoster preserves historical children and does not present stale children as live after parent termination", async () => {
  const clock = pollingClock();
  const fixture = fixtureApi(
    snapshot([
      child(),
      child({
        id: "done",
        state: "completed",
        inspectable: false,
        label: "Saved result",
      }),
    ]),
  );
  fixture.snapshot.omitted = 7;
  fixture.snapshot.error = "Status RPC unavailable";
  fixture.transcript = {
    entries: [],
    before: null,
    truncated: false,
    unavailable: "Recorded artifacts expired",
  };
  const view = render(
    <SubagentRoster
      agentId="a"
      runId="r"
      active={false}
      endedAt={new Date(now).toISOString()}
    />,
  );
  await screen.findByText("Unknown · parent ended");
  expect(
    screen.getByText("7 additional subagents omitted from this snapshot."),
  ).toBeDefined();
  expect(screen.getByText(/Status RPC unavailable/)).toBeDefined();
  expect(document.querySelector(".spin")).toBeNull();
  expect(screen.queryByText("Running", { exact: true })).toBeNull();
  expect(clock.callbacks.size).toBe(0);
  await openChild();
  await screen.findByText("Transcript unavailable: Recorded artifacts expired");
  expect(screen.getByText(/This is not a live status/)).toBeDefined();
  await openChild("done");
  expect(
    screen.getByText("Transcript unavailable: no recorded transcript."),
  ).toBeDefined();
  expect(
    fixture.requests.filter((request) => request.path.includes("transcript")),
  ).toHaveLength(1);
  fixture.snapshot = snapshot([child({ state: "completed", endedAt: now })]);
  view.rerender(
    <SubagentRoster agentId="a" runId="r" active={false} revision={1} />,
  );
  await waitFor(() =>
    expect(Boolean(screen.queryByText("Unknown · parent ended"))).toBe(false),
  );
  expect(
    document.querySelector<HTMLDetailsElement>(".subagent-card")!.open,
  ).toBe(true);
  expect(clock.callbacks.size).toBe(0);
});

test("SubagentRoster bounds older-page fetches and shows absent thinking and quiet activity without claiming deadlock", async () => {
  pollingClock();
  const fixture = fixtureApi(
    snapshot([child({ state: "unknown", lastActivityAt: now - 120000 })]),
  );
  fixture.transcript = {
    entries: [
      { id: "latest", kind: "text", role: "assistant", text: "Latest output" },
    ],
    before: 100,
    truncated: true,
  };
  render(<SubagentRoster agentId="a" runId="r" active />);
  await screen.findByText(/No recent activity/);
  expect(screen.getByText("Unknown")).toBeDefined();
  await openChild();
  await screen.findByText("No thinking summary available.");
  for (let i = 0; i < 5; i++) {
    fixture.transcript = {
      entries: [
        {
          id: `old-${i}`,
          kind: "text",
          role: "assistant",
          text: `Old output ${i}`,
        },
      ],
      before: 99 - i,
      truncated: true,
    };
    fireEvent.click(
      screen.getByRole("button", { name: "Load earlier activity" }),
    );
    await screen.findByText(`Old output ${i}`);
  }
  expect(
    screen
      .getByRole("button", { name: "Load earlier activity" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByText(/inspection limit reached/)).toBeDefined();
  expect(
    fixture.requests.filter((request) => request.path.includes("?before=")),
  ).toHaveLength(5);
});

test("conversationActivity absorbs progress and yields one run entry across multiple parent messages", () => {
  const event = (id: number, type: string, data = {}): Activity => ({
    id,
    agentId: "a",
    runId: "r",
    type,
    data,
    createdAt: new Date(now).toISOString(),
  });
  const events = [
    event(1, "run_started"),
    event(2, "message", { role: "assistant", text: "First answer" }),
    event(3, "subagents_updated", { snapshot: snapshot() }),
    event(4, "message", { role: "assistant", text: "Second answer" }),
    event(5, "subagent_heartbeat"),
    event(6, "run_completed"),
  ];
  const entries = conversationActivity(events, []);
  expect(entries.filter((entry) => entry.kind === "work")).toHaveLength(1);
  expect(
    entries
      .filter((entry) => entry.kind === "event")
      .map((entry) => entry.event.id),
  ).toEqual([2, 4]);
  expect(conversationActivity([{ ...events[2]!, runId: null }], [])).toEqual(
    [],
  );
});

test("App renders one historical roster outside work disclosure and refreshes it from SSE activity", async () => {
  directory = mkdtempSync(join(tmpdir(), "jelly-subagent-ui-"));
  server = await startApp({
    dataDir: directory,
    configDir: join(directory, "config"),
    port: 0,
  });
  const agent = server.store.agents()[0]!;
  const run = server.store.createRun(
    agent.id,
    "subagent-ui",
    "Delegated work",
    "api",
    "model",
  );
  server.service.emit(agent.id, run.id, "message", {
    role: "user",
    text: "Please delegate",
  });
  server.service.emit(agent.id, run.id, "message", {
    role: "assistant",
    text: "First parent reply",
  });
  server.service.emit(agent.id, run.id, "subagents_updated", {
    snapshot: snapshot(),
  });
  server.service.emit(agent.id, run.id, "message", {
    role: "assistant",
    text: "Second parent reply",
  });
  server.service.emit(agent.id, run.id, "extension_notice", {
    text: "Extension needs attention",
    level: "warning",
  });
  server.service.emit(agent.id, run.id, "run_completed", {});
  const origin = `http://127.0.0.1:${server.server.port}`;
  let roster = snapshot([child({ state: "completed" })]);
  let reads = 0;
  globalThis.fetch = (async (input, options) => {
    if (String(input).endsWith("/subagents")) {
      reads++;
      return Response.json(roster);
    }
    return originalFetch(new URL(String(input), origin), options);
  }) as typeof fetch;
  globalThis.EventSource = class extends NodeEventSource {
    constructor(url: string) {
      super(new URL(url, origin), { fetch: originalFetch });
    }
  } as unknown as typeof EventSource;
  render(<App />);
  const rosterElement = await screen.findByRole("region", {
    name: "Subagents",
  });
  expect(document.querySelectorAll(".subagent-roster")).toHaveLength(1);
  expect(rosterElement.closest("details.work-activity")).toBeNull();
  expect(
    document.querySelector<HTMLDetailsElement>("details.work-activity")!.open,
  ).toBe(false);
  expect(screen.getByText("First parent reply")).toBeDefined();
  expect(
    within(screen.getByRole("main")).getByText("Second parent reply"),
  ).toBeDefined();
  expect(document.querySelectorAll(".run-note")).toHaveLength(1);
  expect(
    screen
      .getByText("Extension needs attention")
      .closest(".run-note")!
      .getAttribute("role"),
  ).toBe("alert");
  const before = reads;
  roster = snapshot([
    child({ state: "completed", label: "Historical updated task" }),
  ]);
  await act(async () => {
    server!.service.emit(agent.id, run.id, "subagents_updated", {
      snapshot: { ...roster, children: [] },
    });
  });
  await screen.findByText(/Historical updated task/);
  expect(reads).toBeGreaterThan(before);
  expect(document.querySelectorAll(".subagent-roster")).toHaveLength(1);
  // The SSE payload is only an invalidation; the API roster wins.
  expect(screen.getByText(/Historical updated task/)).toBeDefined();
});

test("SubagentRoster ends polling on settlement and retains expanded final output", async () => {
  const clock = pollingClock();
  const fixture = fixtureApi();
  const view = render(<SubagentRoster agentId="a" runId="r" active />);
  await screen.findByText("Workflow · Website");
  const details = await openChild();
  await screen.findByText("Working on", { exact: false });
  expect(clock.callbacks.size).toBe(2);
  fixture.snapshot = snapshot([child({ state: "completed", endedAt: now })]);
  fixture.transcript = {
    entries: [
      {
        id: "final",
        kind: "text",
        role: "assistant",
        text: "Final result ready",
      },
    ],
    before: null,
    truncated: false,
  };
  view.rerender(
    <SubagentRoster
      agentId="a"
      runId="r"
      active={false}
      endedAt={new Date(now).toISOString()}
    />,
  );
  await screen.findByText("Final result ready");
  await screen.findByText("Completed");
  expect(details.open).toBe(true);
  expect(clock.callbacks.size).toBe(0);
  expect(document.querySelector(".spin")).toBeNull();
  const reads = fixture.requests.length;
  await clock.tick();
  expect(fixture.requests.length).toBe(reads);
});

test("SubagentRoster aborts roster hydration and ignores its late reply after unmount", async () => {
  const clock = pollingClock();
  const fixture = fixtureApi();
  let resolve!: (response: Response) => void;
  fixture.respond = () =>
    new Promise((r) => {
      resolve = r;
    });
  const view = render(<SubagentRoster agentId="a" runId="r" active />);
  await waitFor(() => expect(fixture.requests).toHaveLength(1));
  view.unmount();
  expect(fixture.requests[0]!.signal?.aborted).toBe(true);
  expect(clock.callbacks.size).toBe(0);
  await act(async () => resolve(Response.json(snapshot())));
  expect(document.querySelector(".subagent-roster")).toBeNull();
});
