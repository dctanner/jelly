await import("./dom");
import { afterEach, expect, test } from "bun:test";
import { HumanTodos, AgentNeedsYou } from "../src/client/HumanTodos";
import { readAppsLocation } from "../src/client/apps-navigation";
import { agentNotificationText } from "../src/client/browser-notifications";
import type {
  HumanTodo,
  HumanTodoDetail,
  HumanTodosPage,
} from "../src/shared/human-todos";
import type { AgentRecord, Snapshot } from "../src/shared/types";
const { render, screen, fireEvent, waitFor, cleanup, act } =
  await import("@testing-library/react");
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});
const agent: AgentRecord = {
  id: "agent",
  name: "Requester",
  color: "#fff",
  instructions: "",
  avatarId: "jellyfish",
  status: "idle",
  createdAt: "2026-01-01",
  archivedAt: null,
  projectId: null,
  cwd: "/tmp",
  managedCwd: 1,
  model: "gpt-6-astra",
  effort: "medium",
};
function task(id = "todo"): HumanTodo {
  return {
    id,
    agentId: agent.id,
    title: "Upload agreement",
    instructions: "Use uploads",
    reason: "Finish filing",
    criteria: "Signed document",
    blocking: true,
    status: "open",
    revision: 1,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    resolvedAt: null,
    deletedAt: null,
    resolutionNote: "",
    resolutionActor: null,
    completionId: null,
    creator: { kind: "human" },
    sourceAgentId: null,
    requestId: "create",
    sourceActivityId: null,
    goalId: null,
    originGoalId: null,
    interventionId: null,
    originInterventionId: null,
  };
}
function fixture() {
  let todo = task(),
    fail = false,
    pages = false;
  const calls: { path: string; method: string; input: any }[] = [];
  let delayed: ((value: Response) => void) | null = null,
    delayNext = false,
    delayMutationNext = false,
    releaseMutation: (() => void) | null = null;
  const detail = (): HumanTodoDetail => ({
    todo: structuredClone(todo),
    agent,
    delivery: null,
    run: null,
    history: [],
  });
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const path = String(url),
      method = init?.method ?? "GET";
    if (path.endsWith("/control-session"))
      return Response.json({ csrf: "fixture" });
    if (method === "GET") {
      if (path.includes("/human-todos?")) {
        const params = new URL(path, "http://localhost").searchParams;
        const page: HumanTodosPage = {
          items: params.get("after")
            ? [{ ...task("second"), title: "Second action" }]
            : [todo],
          after: pages && !params.get("after") ? "next" : null,
          counts: { total: 1, agents: { agent: 1 } },
          handoffs: [],
          agents: [agent],
        };
        if (params.get("q") === "missing") page.items = [];
        return Response.json(page);
      }
      if (delayNext) {
        delayNext = false;
        return new Promise<Response>((resolve) => {
          delayed = resolve;
        });
      }
      return Response.json(detail());
    }
    const input = JSON.parse(String(init?.body));
    calls.push({ path, method, input });
    if (fail || (path !== "/api/human-todos" && input.expectedRevision !== todo.revision))
      return Response.json(
        { error: "Todo changed. Your draft has not been saved." },
        { status: 409 },
      );
    if (path.endsWith("/complete"))
      todo = {
        ...todo,
        status: "done",
        revision: todo.revision + 1,
        completionId: "completion",
        resolutionActor: { kind: "human" },
        resolutionNote: input.resolutionNote ?? "",
      };
    else todo = { ...todo, ...input, revision: todo.revision + 1 };
    const response = Response.json(detail());
    if (delayMutationNext) {
      delayMutationNext = false;
      return new Promise<Response>(resolve => { releaseMutation = () => resolve(response); });
    }
    return response;
  }) as typeof fetch;
  return {
    calls,
    detail,
    todo: () => todo,
    update: (input: Partial<HumanTodo>) => {
      todo = { ...todo, ...input };
    },
    fail: () => {
      fail = true;
    },
    paginate: () => {
      pages = true;
    },
    delay: () => {
      delayNext = true;
    },
    release: (value: HumanTodoDetail) => { delayed?.(Response.json(value)); delayed = null; },
    hasDelayedRead: () => !!delayed,
    delayMutation: () => { delayMutationNext = true; },
    releaseMutation: () => releaseMutation?.(),
  };
}
function invalidation() {
  window.dispatchEvent(new window.CustomEvent("jelly:todos-updated"));
}
test("global/direct destination routing, empty/search state and accessible Done never requests continuation", async () => {
  const f = fixture();
  window.history.replaceState({}, "", "/todos/todo");
  expect(readAppsLocation()).toMatchObject({
    destination: "todos",
    todoId: "todo",
    explicit: true,
  });
  render(<HumanTodos snapshot={null} active />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Done: Upload agreement" }),
  );
  await waitFor(() => expect(f.calls).toHaveLength(1));
  expect(f.calls[0]?.input.continueAgent).toBeUndefined();
  fireEvent.change(screen.getByLabelText("Search"), {
    target: { value: "missing" },
  });
  await screen.findByText("Nothing needs you right now.");
  expect(screen.getByRole("button", { name: "Add todo" })).toBeTruthy();
});
test("pinned stale drafts survive live invalidation/conflicts with stable retry IDs; fresh reads win over delayed bodies", async () => {
  const f = fixture();
  render(<HumanTodos snapshot={null} active agentId="agent" />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Edit or manage Upload agreement",
    }),
  );
  const title = (await screen.findByLabelText(
    "Action title",
  )) as HTMLInputElement;
  fireEvent.change(title, { target: { value: "My unsaved edit" } });
  f.update({ title: "New agent edit", revision: 2 });
  act(invalidation);
  await screen.findByText(/draft is retained at revision 1/);
  expect(title.value).toBe("My unsaved edit");
  fireEvent.click(screen.getByRole("button", { name: "Save todo" }));
  await screen.findByRole("alert");
  expect(f.calls[0]?.input.expectedRevision).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Save todo" }));
  await waitFor(() => expect(f.calls).toHaveLength(2));
  expect(f.calls[1]?.input.requestId).toBe(f.calls[0]?.input.requestId);
  expect(title.value).toBe("My unsaved edit");
  fireEvent.click(
    screen.getByRole("button", { name: "Discard draft and load latest" }),
  );
  await waitFor(() => expect(title.value).toBe("New agent edit"));
  f.delay();
  await act(async () => {
    invalidation();
    await Bun.sleep(5);
  });
  const stale = f.detail();
  f.update({ title: "Latest saved", revision: 3 });
  act(invalidation);
  await screen.findByText(/saved revision is 3/);
  await act(async () => f.release(stale));
  expect(screen.getByText(/saved revision is 3/)).toBeTruthy();
});
test("pagination survives SSE/reconnect and destination toggles; per-agent strip preserves runtime status", async () => {
  const f = fixture();
  f.paginate();
  const component = render(
    <HumanTodos snapshot={null} active agentId="agent" />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  await screen.findByText("Second action");
  act(invalidation);
  await waitFor(() => expect(screen.getByText("Second action")).toBeTruthy());
  component.rerender(
    <HumanTodos snapshot={null} active={false} agentId="agent" />,
  );
  component.rerender(<HumanTodos snapshot={null} active agentId="agent" />);
  await screen.findByText("Second action");
  component.unmount();
  render(
    <AgentNeedsYou
      snapshot={
        {
          humanTodoCounts: { total: 1, agents: { agent: 1 } },
        } as unknown as Snapshot
      }
      agentId="agent"
      active
    />,
  );
  expect(
    await screen.findByRole("button", { name: /Needs you · 1/ }),
  ).toBeTruthy();
  expect(agent.status).toBe("idle");
});
test("goal-linked Done exposes Review goal, never ordinary continuation; notification text remains content-light", async () => {
  const f = fixture();
  f.update({ goalId: "goal", originGoalId: "goal" });
  render(<HumanTodos snapshot={null} active agentId="agent" />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Edit or manage Upload agreement",
    }),
  );
  expect(await screen.findByRole("button", { name: "Done" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Done & continue/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Review goal" })).toBeTruthy();
  const notification = agentNotificationText(agent, {
    id: 1,
    agentId: agent.id,
    type: "human_todo_attention",
    todoId: "todo",
  });
  expect(notification.title).toContain(agent.name);
  expect(JSON.stringify(notification)).not.toContain("agreement");
});

test("browser Back/destination unmount preserves the pinned todo draft and note until explicit discard", async () => {
  fixture();
  const snapshot = {
    instance: { id: "draft-preservation", name: "Fixture" },
    agents: [agent],
    projects: [],
  } as unknown as Snapshot;
  const ui = render(<HumanTodos snapshot={snapshot} active todoId="todo" />);
  fireEvent.change(await screen.findByLabelText("Action title"), {
    target: { value: "Unsent todo edit" },
  });
  fireEvent.change(
    screen.getByLabelText("Optional non-secret completion note"),
    { target: { value: "Unsent note" } },
  );
  ui.rerender(<HumanTodos snapshot={snapshot} active={false} />);
  ui.rerender(<HumanTodos snapshot={snapshot} active todoId="todo" />);
  expect(
    ((await screen.findByLabelText("Action title")) as HTMLInputElement).value,
  ).toBe("Unsent todo edit");
  expect(
    (
      screen.getByLabelText(
        "Optional non-secret completion note",
      ) as HTMLTextAreaElement
    ).value,
  ).toBe("Unsent note");
});

const isolatedSnapshot = () => ({ instance: { id: crypto.randomUUID() }, agents: [agent], projects: [] }) as unknown as Snapshot;
test.each([
  ["Done", false], ["Done", true],
  ["Done & continue — runs agent", false], ["Done & continue — runs agent", true],
  ["Continue agent", false], ["Continue agent", true],
  ["Delete todo", false], ["Delete todo", true],
  ["Cancel todo", false], ["Reopen", false],
] as const)("%s uses the reviewed revision (note-only draft: %s)", async (action, withNote) => {
  const f = fixture();
  if (["Continue agent", "Reopen"].includes(action)) f.update({ status: "done", completionId: "completion" });
  render(<HumanTodos snapshot={isolatedSnapshot()} active todoId="todo" />);
  const title = await screen.findByLabelText("Action title") as HTMLInputElement;
  if (withNote) fireEvent.change(screen.getByLabelText("Optional non-secret completion note"), { target: { value: "Reviewed old instructions" } });
  f.update({ instructions: "New unreviewed requirements", revision: 2 });
  act(invalidation);
  await screen.findByText(/saved revision is 2/);
  if (action === "Continue agent" && withNote) {
    expect((screen.getByRole("button", { name: action }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save completion note" }));
  } else {
    if (action === "Delete todo") fireEvent.click(screen.getByText("Delete todo", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: action }));
  }
  await screen.findByRole("alert");
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.input.expectedRevision).toBe(1);
  expect(f.todo().revision).toBe(2);
  expect(title.value).toBe("Upload agreement");
  if (withNote) expect((screen.getByLabelText("Optional non-secret completion note") as HTMLTextAreaElement).value).toBe("Reviewed old instructions");
});

test.each(["create", "edit"])("%s locks inputs through delayed mutation and saved-state refresh", async (mode) => {
  const f = fixture();
  render(<HumanTodos snapshot={isolatedSnapshot()} active {...(mode === "edit" ? { todoId: "todo" } : {})} />);
  if (mode === "create") fireEvent.click(screen.getByRole("button", { name: "Add todo" }));
  const title = await screen.findByLabelText("Action title") as HTMLInputElement;
  fireEvent.change(title, { target: { value: "Submitted draft" } });
  if (mode === "edit") fireEvent.change(screen.getByLabelText("Optional non-secret completion note"), { target: { value: "Keep this pending note" } });
  f.delayMutation();
  fireEvent.click(screen.getByRole("button", { name: "Save todo" }));
  await waitFor(() => expect(f.calls).toHaveLength(1));
  expect(title.closest("fieldset")?.disabled).toBe(true);
  expect((screen.getByLabelText("Linked agent") as HTMLSelectElement).closest("fieldset")?.disabled).toBe(true);
  if (mode === "edit") {
    f.delay();
    await act(async () => { f.releaseMutation(); await Bun.sleep(5); });
    await waitFor(() => expect(f.hasDelayedRead()).toBe(true));
    expect(title.closest("fieldset")?.disabled).toBe(true);
    // SSE must not invalidate the authoritative refresh or unlock editing early.
    act(invalidation);
    await act(async () => f.release(f.detail()));
    await waitFor(() => expect(title.closest("fieldset")?.disabled).toBe(false));
    expect(title.value).toBe("Submitted draft");
    expect((screen.getByLabelText("Optional non-secret completion note") as HTMLTextAreaElement).value).toBe("Keep this pending note");
  } else {
    await act(async () => f.releaseMutation());
    await waitFor(() => expect(screen.queryByLabelText("Action title")).toBeNull());
  }
});

test("Done task notes require revision-checked persistence before Continue", async () => {
  const f = fixture();
  f.update({ status: "done", completionId: "completion", resolutionActor: { kind: "human" } });
  render(<HumanTodos snapshot={isolatedSnapshot()} active todoId="todo" />);
  fireEvent.change(await screen.findByLabelText("Optional non-secret completion note"), { target: { value: "Saved signed.pdf" } });
  expect((screen.getByRole("button", { name: "Continue agent" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save completion note" }));
  await screen.findByText("Saved signed.pdf", { selector: "p" });
  await waitFor(() => expect((screen.getByRole("button", { name: "Continue agent" }) as HTMLButtonElement).disabled).toBe(false));
  expect(f.calls[0]).toMatchObject({ method: "PATCH", input: { resolutionNote: "Saved signed.pdf", expectedRevision: 1 } });
  fireEvent.click(screen.getByRole("button", { name: "Continue agent" }));
  await waitFor(() => expect(f.calls).toHaveLength(2));
  expect(f.calls[1]).toMatchObject({ path: "/api/human-todos/todo/continue", input: { expectedRevision: 2 } });
  expect(f.todo().resolutionNote).toBe("Saved signed.pdf");
});

test("unassignment preserves independent historical source navigation without an extra Todos history entry", async () => {
  const f = fixture();
  f.update({ agentId: null, sourceAgentId: "original", sourceActivityId: 42 });
  window.history.replaceState({}, "", "/todos/todo");
  render(<HumanTodos snapshot={isolatedSnapshot()} active todoId="todo" />);
  await screen.findByLabelText("Action title");
  expect(screen.queryByRole("button", { name: "Open agent" })).toBeNull();
  const before = window.history.length;
  fireEvent.click(screen.getByRole("button", { name: "Source conversation" }));
  expect(window.location.pathname + window.location.search).toBe("/agents/original?activity=42");
  expect(window.history.length).toBe(before + 1);
});
