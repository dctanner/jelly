await import("./dom");
import { afterEach, expect, test } from "bun:test";
import { GoalsPanel, GoalsButton, GoalNotice } from "../src/client/Goals";
import { conversationActivity } from "../src/client/conversationActivity";
import type { GoalView } from "../src/shared/goals";
import type { Activity } from "../src/shared/types";
const { render, screen, fireEvent, waitFor, cleanup, act } =
  await import("@testing-library/react");
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
function fixture() {
  let view: GoalView = { goal: null, runningRunId: null };
  let fail = false;
  const calls: { action: string; input: any }[] = [];
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/control-session"))
      return Response.json({ csrf: "fixture" });
    if (!init?.method || init.method === "GET") return Response.json(view);
    const action = path.split("/").at(-1)!,
      input = JSON.parse(String(init.body));
    calls.push({ action, input });
    if (fail)
      return Response.json(
        { error: "Goal changed. Reload and use the current revision." },
        { status: 409 },
      );
    if (action === "create" && view.goal)
      return Response.json(
        { error: "Clear the current goal before creating another." },
        { status: 409 },
      );
    if (action !== "create") {
      if (!view.goal || input.goalId !== view.goal.id)
        return Response.json(
          { error: "Goal not found for this agent." },
          { status: 404 },
        );
      if (input.expectedRevision !== view.goal.revision)
        return Response.json(
          { error: "Goal changed. Reload and use the current revision." },
          { status: 409 },
        );
    }
    if (action === "create")
      view.goal = {
        id: "goal",
        agentId: "agent",
        objective: input.objective,
        compactions: 0,
        revision: 1,
        epoch: 0,
        state: "paused",
        progress: "",
        reason: "Saved",
        continuations: 0,
        createdAt: "",
        updatedAt: "",
      };
    else if (action === "clear") view.goal = null;
    else if (view.goal)
      view.goal = {
        ...view.goal,
        revision: view.goal.revision + 1,
        state:
          action === "resume"
            ? "active"
            : action === "complete"
              ? "completed"
              : "paused",
        ...(action === "edit" ? { objective: input.objective } : {}),
      };
    return Response.json(view);
  }) as typeof fetch;
  return {
    calls,
    view: () => view,
    fail: () => {
      fail = true;
    },
  };
}
async function create() {
  fireEvent.change(await screen.findByLabelText("Objective"), {
    target: { value: "Verify full fixture scope" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save goal" }));
  await screen.findByRole("button", { name: "Resume goal" });
}
test("single inline goal textarea supports create/edit/pause/resume without editor buttons or budget controls", async () => {
  const f = fixture();
  render(<GoalsButton agentId="agent" />);
  fireEvent.click(screen.getByRole("button", { name: "Goals" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  await create();
  expect(f.calls[0]!.input).not.toHaveProperty("tokenBudget");
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(screen.queryByText(/token budget/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Resume goal" }));
  fireEvent.click(await screen.findByRole("button", { name: "Pause goal" }));
  await screen.findByRole("button", { name: "Resume goal" });
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "New goal" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit goal" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Objective"), {
    target: { value: "Edited exact scope" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save goal" }));
  await screen.findByRole("button", { name: "Resume goal" });
  expect(
    (screen.getByLabelText("Objective") as HTMLTextAreaElement).value,
  ).toBe("Edited exact scope");
  expect(f.calls.map((c) => c.action)).toEqual([
    "create",
    "resume",
    "pause",
    "edit",
  ]);
});
test("409 retains editor and stable retry key; SSE invalidation refreshes progress without dropping the draft", async () => {
  const f = fixture();
  render(<GoalsPanel agentId="agent" onClose={() => {}} />);
  await create();
  fireEvent.change(screen.getByLabelText("Objective"), {
    target: { value: "Unsaved draft" },
  });
  f.fail();
  fireEvent.click(screen.getByRole("button", { name: "Save goal" }));
  await screen.findByRole("alert");
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Save goal" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save goal" }));
  await waitFor(() =>
    expect(f.calls.filter((c) => c.action === "edit")).toHaveLength(2),
  );
  const edits = f.calls.filter((c) => c.action === "edit");
  expect(edits[0]!.input.requestId).toBe(edits[1]!.input.requestId);
  f.view().goal!.progress = "New progress";
  await act(async () => {
    window.dispatchEvent(new window.CustomEvent("jelly:goals-updated"));
  });
  await screen.findByText("New progress");
  expect(
    (screen.getByLabelText("Objective") as HTMLTextAreaElement).value,
  ).toBe("Unsaved draft");
});
test("goal changes remain visible outside generic work grouping; archived controls are disabled", async () => {
  fixture();
  const event: Activity = {
    id: 1,
    agentId: "agent",
    runId: "run",
    type: "goal_changed",
    data: {
      state: "blocked",
      reason: "Fixture blocker",
      tokensUsed: 20,
      tokenBudget: 100,
    },
    createdAt: "",
  };
  expect(
    conversationActivity([event], []).some(
      (e) => e.kind === "event" && e.event === event,
    ),
  ).toBe(true);
  render(<GoalNotice event={event} />);
  expect(screen.getByText("Fixture blocker")).toBeTruthy();
  cleanup();
  render(<GoalsPanel agentId="agent" archived onClose={() => {}} />);
  expect(
    (await screen.findByLabelText("Objective")).closest("fieldset")!.disabled,
  ).toBe(true);
});
test("late read after navigating to another agent cannot overwrite the new goal panel", async () => {
  fixture();
  const base = globalThis.fetch;
  let release!: (response: Response) => void;
  globalThis.fetch = ((url: any, init?: RequestInit) =>
    String(url).includes("/agents/old/")
      ? new Promise<Response>((r) => {
          release = r;
        })
      : base(url, init)) as typeof fetch;
  const result = render(
    <GoalsPanel key="old" agentId="old" onClose={() => {}} />,
  );
  await waitFor(() => expect(release).toBeDefined());
  result.rerender(<GoalsPanel key="new" agentId="new" onClose={() => {}} />);
  await screen.findByLabelText("Objective");
  await act(async () => {
    release(
      Response.json({
        goal: { objective: "Stale objective" },
        runningRunId: null,
      }),
    );
  });
  expect(
    (screen.getByLabelText("Objective") as HTMLTextAreaElement).value,
  ).toBe("");
});

async function refreshGoalView() {
  await act(async () => {
    window.dispatchEvent(new window.CustomEvent("jelly:goals-updated"));
  });
}
test("concurrent edits never silently rebase a draft; conflicts and retries preserve its base revision", async () => {
  const f = fixture();
  render(<GoalsPanel agentId="agent" onClose={() => {}} />);
  await create();
  fireEvent.change(screen.getByLabelText("Objective"), {
    target: { value: "My original draft" },
  });
  f.view().goal = {
    ...f.view().goal!,
    revision: 2,
    objective: "New objective from another tab",
  };
  await refreshGoalView();
  await screen.findByText(
    /This draft still targets its original goal and revision/,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    fireEvent.click(screen.getByRole("button", { name: "Save goal" }));
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Save goal" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  }
  const edits = f.calls.filter((c) => c.action === "edit");
  expect(edits).toHaveLength(2);
  expect(edits[0]!.input).toMatchObject({
    goalId: "goal",
    expectedRevision: 1,
    objective: "My original draft",
  });
  expect(edits[1]!.input).toEqual(edits[0]!.input);
  expect(f.view().goal).toMatchObject({
    revision: 2,
    objective: "New objective from another tab",
  });
  expect(
    (screen.getByLabelText("Objective") as HTMLTextAreaElement).value,
  ).toBe("My original draft");
  fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
  expect(
    (screen.getByLabelText("Objective") as HTMLTextAreaElement).value,
  ).toBe("New objective from another tab");
  fireEvent.change(screen.getByLabelText("Objective"), {
    target: { value: "Revised latest scope" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save goal" }));
  await screen.findByRole("button", { name: "Resume goal" });
  expect(f.calls.at(-1)!.input.expectedRevision).toBe(2);
});

test.each([false, true])(
  "clearing an edited goal never retargets its draft (replacement=%j)",
  async (replacement) => {
    const f = fixture();
    render(<GoalsPanel agentId="agent" onClose={() => {}} />);
    await create();
    const original = f.view().goal!;
    fireEvent.change(screen.getByLabelText("Objective"), {
      target: { value: "Original unsaved draft" },
    });
    f.view().goal = replacement
      ? { ...original, id: "replacement", objective: "Replacement goal" }
      : null;
    await refreshGoalView();
    await screen.findByText(
      /This draft still targets its original goal and revision/,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save goal" }));
    await screen.findByRole("alert");
    expect(f.calls.at(-1)).toMatchObject({
      action: "edit",
      input: { goalId: original.id, expectedRevision: original.revision },
    });
    expect(f.calls.filter((c) => c.action === "create")).toHaveLength(1);
    expect(f.view().goal?.id ?? null).toBe(replacement ? "replacement" : null);
    expect(
      (screen.getByLabelText("Objective") as HTMLTextAreaElement).value,
    ).toBe("Original unsaved draft");
  },
);

test("a create draft remains create when another tab creates a goal", async () => {
  const f = fixture();
  render(<GoalsPanel agentId="agent" onClose={() => {}} />);
  await create();
  const other = f.view().goal!;
  f.view().goal = null;
  await refreshGoalView();
  fireEvent.change(await screen.findByLabelText("Objective"), {
    target: { value: "New draft" },
  });
  f.view().goal = { ...other, id: "other-tab" };
  await refreshGoalView();
  await screen.findByText(
    /This draft still targets its original goal and revision/,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save goal" }));
  await screen.findByRole("alert");
  expect(f.calls.at(-1)!.action).toBe("create");
  expect(f.view().goal?.id).toBe("other-tab");
});

test("pristine textarea follows live changes and stays read-only during work or after completion", async () => {
  const f = fixture();
  render(<GoalsPanel agentId="agent" onClose={() => {}} />);
  const textarea = (await screen.findByLabelText(
    "Objective",
  )) as HTMLTextAreaElement;
  expect(textarea.value).toBe("");
  expect(screen.queryByRole("button", { name: "New goal" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save goal" })).toBeNull();
  await create();
  f.view().goal = {
    ...f.view().goal!,
    objective: "Updated remotely",
    revision: 2,
  };
  await refreshGoalView();
  await waitFor(() => expect(textarea.value).toBe("Updated remotely"));
  expect(textarea.readOnly).toBe(false);
  for (const state of ["active", "completed"] as const) {
    f.view().goal!.state = state;
    await refreshGoalView();
    await waitFor(() => expect(textarea.readOnly).toBe(true));
    fireEvent.change(textarea, { target: { value: "Disallowed edit" } });
    expect(screen.queryByRole("button", { name: "Save goal" })).toBeNull();
  }
  f.view().goal!.state = "paused";
  f.view().runningRunId = "still-running";
  await refreshGoalView();
  expect(textarea.readOnly).toBe(true);
  f.view().runningRunId = null;
  f.view().goal = null;
  await refreshGoalView();
  await waitFor(() => expect(textarea.value).toBe(""));
  expect(textarea.readOnly).toBe(false);
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
});

test.each(["resume", "conflict", "stop"])(
  "%s uses one read ordering across SSE and mutation settlement, never a delayed mutation snapshot",
  async (action) => {
    const f = fixture();
    render(<GoalsPanel agentId="agent" onClose={() => {}} />);
    await create();
    const initial = { ...f.view().goal! };
    if (action === "stop") {
      f.view().runningRunId = "running";
      await refreshGoalView();
      await screen.findByRole("button", { name: "Stop agent" });
    }
    const base = globalThis.fetch;
    let release!: (response: Response) => void;
    let reads = 0;
    globalThis.fetch = ((url: any, init?: RequestInit) => {
      if (init?.method === "POST")
        return new Promise<Response>((r) => {
          release = r;
        });
      reads++;
      return base(url, init);
    }) as typeof fetch;
    fireEvent.click(
      screen.getByRole("button", {
        name: action === "stop" ? "Stop agent" : "Resume goal",
      }),
    );
    await waitFor(() => expect(release).toBeDefined());
    // An invalidation after POST may still sample pre-commit. Defer it instead.
    await refreshGoalView();
    expect(reads).toBe(0);
    f.view().goal = {
      ...initial,
      state: "completed",
      revision: initial.revision + 2,
    };
    f.view().runningRunId = null;
    await act(async () =>
      release(
        action === "conflict"
          ? Response.json({ error: "Revision conflict" }, { status: 409 })
          : Response.json({
              goal: {
                ...initial,
                state: "active",
                revision: initial.revision + 1,
              },
              runningRunId: "old-run",
            }),
      ),
    );
    await screen.findByRole("heading", { name: "completed" });
    expect(screen.queryByRole("heading", { name: "active" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop agent" })).toBeNull();
    expect(reads).toBe(1);
  },
);

test.each(["before", "after"])(
  "a pre-commit GET arriving %s POST cannot hide the committed mutation",
  async (ordering) => {
    const f = fixture();
    render(<GoalsPanel agentId="agent" onClose={() => {}} />);
    await create();
    const old = structuredClone(f.view());
    const base = globalThis.fetch;
    let readRelease!: (response: Response) => void;
    let postRelease!: (response: Response) => void;
    let reads = 0;
    globalThis.fetch = ((url: any, init?: RequestInit) => {
      if (init?.method === "POST")
        return new Promise<Response>((r) => {
          postRelease = r;
        });
      if (++reads === 1)
        return new Promise<Response>((r) => {
          readRelease = r;
        });
      return base(url, init);
    }) as typeof fetch;
    await refreshGoalView();
    await waitFor(() => expect(readRelease).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Resume goal" }));
    await waitFor(() => expect(postRelease).toBeDefined());
    // This later GET intent would also sample old state if sent before commit.
    await refreshGoalView();
    if (ordering === "before")
      await act(async () => readRelease(Response.json(old)));
    f.view().goal = {
      ...old.goal!,
      state: "active",
      revision: old.goal!.revision + 1,
    };
    await act(async () => postRelease(Response.json(f.view())));
    if (ordering === "after")
      await act(async () => readRelease(Response.json(old)));
    await screen.findByRole("heading", { name: "active" });
    expect(reads).toBe(2);
  },
);
