await import("./dom");
import { afterEach, expect, test } from "bun:test";
import {
  ScheduledMessage,
  ScheduleNotice,
  SchedulesPanel,
} from "../src/client/Schedules";
import { AgentDetails } from "../src/client/App";
import { conversationActivity } from "../src/client/conversationActivity";
import { mergeHistory } from "../src/client/history";
import type { ScheduleReceipt } from "../src/shared/schedules";
import type { Activity, AgentRecord } from "../src/shared/types";
const { render, screen, fireEvent, waitFor, cleanup, within, act } =
  await import("@testing-library/react");
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
function fixture(paginated = false) {
  let receipt: ScheduleReceipt = {
    schedule: {
      id: "sch_fixture",
      agentId: "agent",
      title: "Weekday review",
      prompt: "Preserve this exact task\nsecond line",
      revision: 1,
      kind: "cron",
      cron: "30 8 * * 1-5",
      runAt: null,
      timezone: "Europe/London",
      catchUp: "latest",
      maxLatenessSeconds: 86400,
      state: "active",
      reason: null,
      nextRunAt: "2026-10-26T08:30:00.000Z",
      createdAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:00.000Z",
      createdByRunId: null,
      updatedByRunId: null,
      originalRequestId: "request",
      lastDispatchError: null,
      retryAt: null,
    },
    preview: [
      "2026-10-26T08:30:00.000Z",
      "2026-10-27T08:30:00.000Z",
      "2026-10-28T08:30:00.000Z",
    ],
    latest: null,
    runningRunId: null,
    notice: "Pause/cancel only affects unstarted work. Stop is separate.",
  };
  const calls: { path: string; method: string; input: any }[] = [];
  let conflict = false;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET",
      data = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, method, input: data });
    if (url.pathname === "/api/control-session")
      return Response.json({ csrf: "fixture" });
    if (url.pathname.endsWith("/occurrences"))
      return Response.json({
        items: [
          {
            id: "occ_fixture",
            scheduleId: receipt.schedule.id,
            scheduleRevision: 1,
            agentId: "agent",
            scheduledFor: "2026-10-23T07:30:00.000Z",
            snapshot: receipt.schedule,
            state: "failed",
            requestId: "occ",
            runId: "run",
            admittedAt: "2026-10-23T07:30:01.000Z",
            finishedAt: "2026-10-23T07:30:02.000Z",
            wakeReason: "scheduled execution",
            reason: "Fixture provider unavailable",
            attempts: 0,
            retryAt: null,
          },
        ],
        before: null,
      });
    if (method === "GET") {
      const older = {
        ...receipt,
        schedule: {
          ...receipt.schedule,
          id: "sch_older",
          title: "Older cancelled task",
          state: "cancelled",
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      };
      return Response.json(
        url.pathname.endsWith("/schedules")
          ? {
              items: [url.searchParams.has("before") ? older : receipt],
              before:
                paginated && !url.searchParams.has("before")
                  ? "older-cursor"
                  : null,
              activeCount: receipt.schedule.state === "active" ? 1 : 0,
              nextRunAt: receipt.schedule.nextRunAt,
            }
          : url.pathname.endsWith("/sch_older")
            ? older
            : receipt,
      );
    }
    if (url.pathname.endsWith("/preview"))
      return Response.json({ preview: receipt.preview });
    if (conflict)
      return Response.json(
        { error: "Schedule changed. Reload it and use its current revision." },
        { status: 409 },
      );
    receipt = {
      ...receipt,
      schedule: {
        ...receipt.schedule,
        revision: receipt.schedule.revision + 1,
        ...(method === "PATCH"
          ? { prompt: data.prompt }
          : {
              state: url.pathname.endsWith("/pause")
                ? "paused"
                : url.pathname.endsWith("/resume")
                  ? "active"
                  : "cancelled",
            }),
      },
    };
    return Response.json(receipt);
  }) as typeof fetch;
  return {
    calls,
    receipt: () => receipt,
    conflict: () => {
      conflict = true;
    },
  };
}
test("scheduled transcript uses durable metadata, exact task, admission/lateness and schedule controls across replay", async () => {
  fixture();
  const event: Activity = {
    id: 7,
    agentId: "agent",
    runId: "run",
    type: "message",
    createdAt: "2026-10-25T08:32:10Z",
    data: {
      role: "user",
      source: "schedule",
      scheduleId: "sch_fixture",
      occurrenceId: "occ_fixture",
      scheduleRevision: 1,
      scheduledFor: "2026-10-25T08:30:00Z",
      admittedAt: "2026-10-25T08:32:10Z",
      wakeReason: "delayed while busy",
      taskSnapshot: "Exact\n  task",
      text: "Delivered automated envelope\nExact\n  task",
    },
  };
  const page = { events: [event], runs: [], interventions: [], before: null };
  const merged = mergeHistory(page, page).events;
  expect(merged).toHaveLength(1);
  expect(conversationActivity(merged, [])[0]).toMatchObject({
    kind: "event",
    event: { data: { source: "schedule" } },
  });
  render(<ScheduledMessage event={event} />);
  expect(screen.getByRole("heading", { name: "Scheduled task" })).toBeTruthy();
  expect(screen.getByText("130 seconds")).toBeTruthy();
  expect(screen.getByText("Exact task").textContent).toBe("Exact\n  task");
  expect(screen.getByText("Admitted at")).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "View schedule" }));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy(),
  );
});
test("schedules controls show timing, prompt/history and pause/cancel without model, with optimistic revisions", async () => {
  const f = fixture();
  render(
    <SchedulesPanel
      agentId="agent"
      initialId="sch_fixture"
      onClose={() => {}}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy(),
  );
  expect(screen.getAllByText(/Europe\/London/).length).toBeGreaterThan(0);
  expect(
    screen.getAllByText(/Preserve this exact task/)[0]!.textContent,
  ).toContain("second line");
  await waitFor(() =>
    expect(screen.getByText("Fixture provider unavailable")).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy(),
  );
  expect(
    f.calls.find((call) => call.path.endsWith("/pause"))!.input
      .expectedRevision,
  ).toBe(1);
  expect(screen.getByRole("status").textContent).toContain(
    "No run is currently started",
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel schedule" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull(),
  );
  expect(
    f.calls.find((call) => call.path.endsWith("/cancel"))!.input
      .expectedRevision,
  ).toBe(2);
});
test("accessible editor preview and stale revision error retain exact unsaved prompt", async () => {
  const f = fixture();
  render(
    <SchedulesPanel
      agentId="agent"
      initialId="sch_fixture"
      onClose={() => {}}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const prompt = screen.getByLabelText("Stored task") as HTMLTextAreaElement;
  fireEvent.change(prompt, { target: { value: "  changed verbatim\n  " } });
  fireEvent.click(screen.getByRole("button", { name: "Preview times" }));
  await waitFor(() =>
    expect(screen.getByRole("list", { name: "Upcoming times" })).toBeTruthy(),
  );
  f.conflict();
  fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Schedule changed"),
  );
  expect(prompt.value).toBe("  changed verbatim\n  ");
  const update = f.calls.find((call) => call.method === "PATCH")!;
  expect(update.input.prompt).toBe(prompt.value);
  expect(update.input.expectedRevision).toBe(1);
  expect(screen.getByLabelText("Maximum lateness (seconds)")).toBeTruthy();
  expect(screen.getByLabelText("After downtime")).toBeTruthy();
});
test("blocked/expired notices are actionable and agent menu shows active count/next run", async () => {
  fixture();
  const agent: AgentRecord = {
    id: "agent",
    name: "Calendar",
    instructions: "",
    color: "#123456",
    model: "gpt-6-astra",
    effort: "medium",
    projectId: null,
    cwd: "/tmp",
    managedCwd: 1,
    avatarId: "jellyfish",
    status: "idle",
    createdAt: "",
    archivedAt: null,
  };
  render(
    <AgentDetails
      agent={agent}
      projects={[]}
      connected
      running={false}
      archiving={false}
      refreshing={false}
      canCompact={false}
      onFreshSession={() => {}}
      onClose={() => {}}
      onUpload={() => {}}
      onMove={() => {}}
      onArchive={() => {}}
      onSaved={() => {}}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Schedules \(1 active\)/ }),
    ).toBeTruthy(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Schedules \(1 active\)/ }),
  );
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "Schedules" })).toBeTruthy(),
  );
  cleanup();
  render(
    <ScheduleNotice
      event={{
        id: 1,
        agentId: "agent",
        runId: null,
        type: "schedule_blocked",
        data: {
          scheduleId: "sch_fixture",
          title: "Review",
          reason: "Connect provider",
        },
        createdAt: "",
      }}
    />,
  );
  expect(
    screen.getByText(/Check the model connection in Settings/),
  ).toBeTruthy();
  expect(screen.getByRole("link", { name: "View schedule" })).toBeTruthy();
});

test("retained terminal schedules load through bounded list pagination without hiding current active controls", async () => {
  fixture(true);
  render(<SchedulesPanel agentId="agent" onClose={() => {}} />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Load older schedules" }),
    ).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Load older schedules" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Older cancelled task/ }),
    ).toBeTruthy(),
  );
  expect(
    screen.queryByRole("button", { name: "Load older schedules" }),
  ).toBeNull();
  expect(
    (
      screen.getByRole("button", {
        name: "Pause schedules",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: /Older cancelled task/ }));
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Older cancelled task" }),
    ).toBeTruthy(),
  );
  expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
});

test("bulk pause retains busy state and reports the first conflict after later success", async () => {
  const f = fixture();
  const first = structuredClone(f.receipt());
  const second = structuredClone(first);
  second.schedule.id = "sch_second";
  second.schedule.title = "Second task";
  const baseFetch = globalThis.fetch;
  let finishSecond!: () => void;
  const held = new Promise<void>((resolve) => {
    finishSecond = resolve;
  });
  let secondStarted = false;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/schedules"))
      return Response.json({
        items: [first, second],
        before: null,
        activeCount: [first, second].filter(
          (item) => item.schedule.state === "active",
        ).length,
        nextRunAt: first.schedule.nextRunAt,
      });
    if (url.pathname.endsWith("/sch_fixture/pause"))
      return Response.json(
        { error: "Schedule changed; reload." },
        { status: 409 },
      );
    if (url.pathname.endsWith("/sch_second/pause")) {
      secondStarted = true;
      await held;
      second.schedule.state = "paused";
      second.schedule.revision++;
      return Response.json(second);
    }
    return baseFetch(input, init);
  }) as typeof fetch;
  render(<SchedulesPanel agentId="agent" onClose={() => {}} />);
  const pause = await screen.findByRole("button", { name: "Pause schedules" });
  await waitFor(() =>
    expect((pause as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(pause);
  try {
    await waitFor(() => expect(secondStarted).toBe(true));
    expect((pause as HTMLButtonElement).disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "New schedule",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  } finally {
    finishSecond();
  }
  await waitFor(() =>
    expect((pause as HTMLButtonElement).disabled).toBe(false),
  );
  expect(screen.getByRole("alert").textContent).toContain("Weekday review");
  expect(screen.getByRole("alert").textContent).toContain("Schedule changed");
  expect(screen.getByRole("status").textContent).toContain(
    "Paused 1 of 2 schedules",
  );
  expect(first.schedule.state).toBe("active");
  expect(second.schedule.state).toBe("paused");
});

test.each([
  ["running", "completed", false],
  ["pending", "cancelled", true],
  ["pending", "expired", false],
] as const)("history reconciles older %s → %s behind an overlap skip (mutation=%j) without losing pages", async (initialState, terminalState, mutate) => {
  const f = fixture();
  const receipt = f.receipt();
  const occurrence = (id: string, time: string, state: string) => ({
    id,
    scheduleId: receipt.schedule.id,
    scheduleRevision: 1,
    agentId: "agent",
    scheduledFor: time,
    snapshot: receipt.schedule,
    state,
    requestId: id,
    runId: state === "running" ? "run-older" : null,
    admittedAt: state === "running" ? time : null,
    finishedAt: null,
    wakeReason: "scheduled execution",
    reason: null,
    reasonCode: null,
    delays: [],
    attempts: 0,
    retryAt: null,
  });
  const skipped = occurrence(
    "occ_newer",
    "2026-10-25T08:30:00.000Z",
    "skipped",
  );
  const running = occurrence(
    "occ_running",
    "2026-10-24T08:30:00.000Z",
    initialState,
  );
  const old = occurrence("occ_old", "2026-10-23T08:30:00.000Z", "failed");
  receipt.latest = skipped as any;
  receipt.runningRunId = initialState === "running" ? "run-older" : null;
  const baseFetch = globalThis.fetch;
  let historyCalls = 0;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/occurrences")) {
      historyCalls++;
      return Response.json(
        url.searchParams.has("before")
          ? { items: [running, old], before: "even-older" }
          : { items: [skipped], before: "older" },
      );
    }
    return baseFetch(input, init);
  }) as typeof fetch;
  // Advance only the panel's poll; no wall-clock sleeps or global fake timers.
  const originalInterval = globalThis.setInterval;
  let refresh!: () => Promise<void>;
  globalThis.setInterval = ((handler: any, timeout: number, ...args: any[]) => {
    if (timeout === 5000) refresh = handler;
    return originalInterval(
      handler,
      timeout === 5000 ? 60000 : timeout,
      ...args,
    );
  }) as typeof setInterval;
  try {
    render(
      <SchedulesPanel
        agentId="agent"
        initialId={receipt.schedule.id}
        onClose={() => {}}
      />,
    );
    await screen.findByText("skipped", {
      selector: ".schedule-history strong",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Load older occurrences" }),
    );
    await screen.findByText(initialState, {
      selector: ".schedule-history strong",
    });
    await screen.findByText("failed", { selector: ".schedule-history strong" });
    const before = historyCalls;
    receipt.runningRunId = null;
    running.state = terminalState;
    if (mutate) {
      fireEvent.click(screen.getByRole("button", { name: /^Pause$/ }));
    } else {
      await act(async () => {
        await refresh();
      });
    }
    await waitFor(() => expect(historyCalls).toBeGreaterThan(before));
    await screen.findByText(terminalState, {
      selector: ".schedule-history strong",
    });
    expect(
      screen.queryByText(initialState, { selector: ".schedule-history strong" }),
    ).toBeNull();
    expect(
      screen.getByText("failed", { selector: ".schedule-history strong" }),
    ).toBeTruthy();
    expect(
      screen.getByText("skipped", { selector: ".schedule-history strong" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Load older occurrences" }),
    ).toBeTruthy();
  } finally {
    globalThis.setInterval = originalInterval;
  }
});
