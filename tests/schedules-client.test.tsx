await import("./dom");
import { test, expect, afterEach } from "bun:test";
const { render, screen, fireEvent, waitFor, cleanup } =
  await import("@testing-library/react");
import { AgentSchedules } from "../src/client/AgentSchedules";
import type { ScheduleRecord } from "../src/shared/types";
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
function server(initial: ScheduleRecord[] = []) {
  const schedules = [...initial];
  const calls: { method: string; path: string; body: any }[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path: input, body });
    if (input.includes("control-session"))
      return Response.json({ csrf: "fixture" });
    if (input.endsWith("/schedules/parse")) {
      if (body.cron === "bad")
        return Response.json(
          { error: "Invalid schedule: Use five fields." },
          { status: 400 },
        );
      if (body.text === "tomorrow at 3pm review the PR")
        return Response.json({
          cron: "0 15 14 10 *",
          once: true,
          prompt: "Review the PR",
          summary: "Tomorrow at 3:00 PM",
          nextRuns: [
            "2026-10-14T22:00:00.000Z",
            "2027-10-14T22:00:00.000Z",
            "2028-10-14T22:00:00.000Z",
          ],
        });
      if (body.text === "whenever")
        return Response.json(
          { error: "Couldn't understand that schedule." },
          { status: 422 },
        );
      const nextRuns = [
        "2026-10-14T16:00:00.000Z",
        "2026-10-15T16:00:00.000Z",
        "2026-10-16T16:00:00.000Z",
      ];
      return Response.json(
        body.cron !== undefined
          ? { cron: body.cron, prompt: null, summary: null, nextRuns }
          : {
              cron: "0 9 * * 1-5",
              prompt: "Check my inbox",
              summary: "Weekdays at 9:00",
              nextRuns,
            },
      );
    }
    if (body?.cron === "bad")
      return Response.json(
        { error: "Invalid schedule: Use five fields." },
        { status: 400 },
      );
    const id = input.match(/\/schedules\/([^/]+)$/)?.[1];
    const index = schedules.findIndex((s) => s.id === id);
    if (method === "POST") {
      const record: ScheduleRecord = {
        id: `s${schedules.length + 1}`,
        agentId: "agent",
        enabled: true,
        once: false,
        nextRunAt: "2026-10-14T16:00:00.000Z",
        lastRunAt: null,
        lastError: null,
        createdAt: "2026-10-13T00:00:00.000Z",
        ...body,
      };
      schedules.push(record);
      return Response.json(record, { status: 201 });
    }
    if (method === "PATCH")
      return Response.json(
        (schedules[index] = { ...schedules[index]!, ...body }),
      );
    if (method === "DELETE") {
      schedules.splice(index, 1);
      return Response.json({ ok: true });
    }
    return Response.json({ timeZone: "Europe/London", schedules });
  }) as typeof fetch;
  return calls;
}
const existing: ScheduleRecord = {
  id: "weekly",
  agentId: "agent",
  cron: "0 17 * * fri",
  prompt: "Write the weekly report",
  enabled: true,
  once: false,
  nextRunAt: "2026-10-16T16:00:00.000Z",
  lastRunAt: "2026-10-09T16:00:00.000Z",
  lastError: "Connect a model before sending a message.",
  createdAt: "2026-10-01T00:00:00.000Z",
};

test("schedules page adds, edits, pauses and deletes schedules with server validation errors", async () => {
  const calls = server();
  render(<AgentSchedules agentId="agent" archived={false} />);
  await screen.findByText("No schedules yet.");

  fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));
  expect(
    screen.getByText(/server's time zone \(Europe\/London\)/),
  ).toBeDefined();
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "0 9 * * 1-5" },
  });
  expect(
    (screen.getByLabelText(/Cron expression/) as HTMLInputElement).value,
  ).toBe("0 9 * * 1-5");
  fireEvent.change(screen.getByLabelText(/Message/), {
    target: { value: "Check my inbox" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
  await screen.findByText("Weekdays at 9:00");
  expect(
    calls.find((c) => c.method === "POST" && !c.path.endsWith("/parse")),
  ).toMatchObject({
    path: "/api/agents/agent/schedules",
    body: { cron: "0 9 * * 1-5", prompt: "Check my inbox" },
  });
  expect(screen.getByText("Check my inbox")).toBeDefined();
  expect(screen.getByText(/^Next: /)).toBeDefined();

  // A custom expression rejected by the server keeps the form open with the error.
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText(/Cron expression/), {
    target: { value: "bad" },
  });
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /Use five fields/,
  );
  fireEvent.change(screen.getByLabelText(/Cron expression/), {
    target: { value: "*/30 * * * *" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
  await screen.findByText("*/30 * * * *");
  expect(calls.filter((c) => c.method === "PATCH").at(-1)).toMatchObject({
    path: "/api/schedules/s1",
    body: { cron: "*/30 * * * *", prompt: "Check my inbox" },
  });

  fireEvent.click(screen.getByRole("checkbox", { name: /Enable schedule/ }));
  await screen.findByText("Paused");
  expect(calls.filter((c) => c.method === "PATCH").at(-1)!.body).toEqual({
    enabled: false,
  });

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await screen.findByText("No schedules yet.");
  expect(calls.at(-2)).toMatchObject({
    method: "DELETE",
    path: "/api/schedules/s1",
  });
});

test("schedules page shows last run, last error and archived pause state", async () => {
  server([existing]);
  const { rerender } = render(
    <AgentSchedules agentId="agent" archived={false} />,
  );
  await screen.findByText("0 17 * * fri");
  expect(screen.getByText("Write the weekly report")).toBeDefined();
  expect(screen.getByText(/Next: .* · Last: /)).toBeDefined();
  expect(
    screen.getByText("Connect a model before sending a message."),
  ).toBeDefined();
  rerender(<AgentSchedules agentId="agent" archived />);
  await waitFor(() =>
    expect(
      screen.getByText(/Paused while the agent is archived/),
    ).toBeDefined(),
  );
});

test("natural language fills the schedule and message for confirmation, and typed cron previews next runs", async () => {
  const calls = server();
  render(<AgentSchedules agentId="agent" archived={false} />);
  await screen.findByText("No schedules yet.");
  fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));
  // The default preset is previewed without any model call.
  await screen.findByText(/^Next: /);
  expect(calls.find((c) => c.path.endsWith("/parse"))!.body).toEqual({
    cron: "0 9 * * *",
  });

  fireEvent.change(screen.getByLabelText(/Describe it/), {
    target: { value: "whenever" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Fill in" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /Couldn't understand/,
  );

  fireEvent.change(screen.getByLabelText(/Describe it/), {
    target: { value: "every weekday at 9am check my inbox" },
  });
  fireEvent.keyDown(screen.getByLabelText(/Describe it/), { key: "Enter" });
  await screen.findByText(/^Weekdays at 9:00 — Next: /);
  expect(
    calls.find((c) => c.body?.text === "every weekday at 9am check my inbox"),
  ).toBeDefined();
  expect(
    (screen.getByLabelText(/Cron expression/) as HTMLInputElement).value,
  ).toBe("0 9 * * 1-5");
  expect((screen.getByLabelText(/^Message/) as HTMLTextAreaElement).value).toBe(
    "Check my inbox",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  // Nothing is saved until the user confirms.
  expect(
    calls.some(
      (c) => c.method === "POST" && c.path === "/api/agents/agent/schedules",
    ),
  ).toBe(false);

  // Editing the cron by hand drops the summary and re-previews; an invalid one shows why.
  fireEvent.change(screen.getByLabelText(/Cron expression/), {
    target: { value: "bad" },
  });
  await screen.findByText("Invalid schedule: Use five fields.");
  fireEvent.change(screen.getByLabelText(/Cron expression/), {
    target: { value: "0 8 * * *" },
  });
  await waitFor(() => expect(screen.getByText(/^Next: /)).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
  await screen.findByText("0 8 * * *");
  expect(
    calls.find(
      (c) => c.method === "POST" && c.path === "/api/agents/agent/schedules",
    )!.body,
  ).toEqual({
    cron: "0 8 * * *",
    prompt: "Check my inbox",
  });
});

test("one-time schedules: natural language sets Run once, preview shows the single run, and the list shows its state", async () => {
  const ran: ScheduleRecord = {
    ...existing,
    id: "done",
    cron: "0 12 13 10 *",
    prompt: "Ship the release notes",
    once: true,
    enabled: false,
    lastError: null,
    nextRunAt: "2026-10-13T19:00:00.000Z",
    lastRunAt: "2026-10-13T19:00:05.000Z",
  };
  const calls = server([ran]);
  render(<AgentSchedules agentId="agent" archived={false} />);
  await screen.findByText("Ship the release notes");
  expect(screen.getByText(/^Once · /)).toBeDefined();
  expect(screen.getByText(/^Ran /)).toBeDefined();
  expect(screen.queryByText(/Last:/)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));
  expect(screen.getByRole("combobox", { name: "Repeat" })).toBeDefined();
  fireEvent.change(screen.getByLabelText(/Describe it/), {
    target: { value: "tomorrow at 3pm review the PR" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Fill in" }));
  await screen.findByText(/^Tomorrow at 3:00 PM — Runs once: /);
  expect(
    (
      screen.getByRole("checkbox", {
        name: "Run once, then pause",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect(screen.queryByRole("combobox", { name: "Repeat" })).toBeNull();
  expect(
    (screen.getByLabelText(/Cron expression/) as HTMLInputElement).value,
  ).toBe("0 15 14 10 *");
  fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
  await screen.findByText("Review the PR");
  expect(
    calls.find(
      (c) => c.method === "POST" && c.path === "/api/agents/agent/schedules",
    )!.body,
  ).toEqual({
    cron: "0 15 14 10 *",
    prompt: "Review the PR",
    once: true,
  });
  expect(screen.getByText("Waiting to run")).toBeDefined();
});
