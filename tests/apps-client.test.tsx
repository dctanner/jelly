await import("./dom");
import { afterEach, expect, test } from "bun:test";
import { EventSource as NodeEventSource } from "eventsource";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppRecord, AppsCapabilities } from "../src/shared/apps";
import { AppsHome, sortApps } from "../src/client/AppsHome";
import { AppViewer } from "../src/client/AppViewer";
import { AppDetails, RemoveApp } from "../src/client/AppDetails";
import { App } from "../src/client/App";
import { readAppsLocation } from "../src/client/apps-navigation";
import { recordAppLaunch } from "../src/client/api";
import { startApp } from "./fixtures/app";
import { browserCookieFetch } from "./fixtures/control-session";
const { render, screen, fireEvent, waitFor, cleanup, act, within } =
  await import("@testing-library/react");
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalOpen = window.open;
let fixture: Awaited<ReturnType<typeof startApp>> | undefined;
let dir: string | undefined;
const capabilities: AppsCapabilities = {
  supported: true,
  presentation: "trusted-iframe",
  registrationOnly: true,
  warnings: [],
};
function app(id: string, values: Partial<AppRecord> = {}): AppRecord {
  return {
    id,
    slug: id,
    name: id,
    url: "http://localhost:3007/dashboard",
    description: "A trusted app",
    iconAssetId: null,
    projectId: null,
    builderAgentId: null,
    sourceDirectory: null,
    starredAt: null,
    lastOpenedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    viewerCorner: "top-left",
    ...values,
  };
}
function mockApps(
  records: AppRecord[],
  options: {
    star?: (id: string, starred: boolean) => Promise<AppRecord>;
    passthrough?: typeof fetch;
  } = {},
) {
  const calls: { path: string; method: string; data: any; headers: Headers }[] =
    [];
  let listCalls = 0;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input), window.location.origin);
    const path = url.pathname;
    if (!path.startsWith("/api/apps") && path !== "/api/control-session") {
      if (options.passthrough) return options.passthrough(input, init);
      throw new Error(`Unexpected fixture request ${url}`);
    }
    const method = init?.method ?? "GET";
    const data = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ path, method, data, headers: new Headers(init?.headers) });
    if (path === "/api/control-session")
      return options.passthrough
        ? options.passthrough(input, init)
        : Response.json({ csrf: "fixture-control-token" });
    if (path === "/api/apps/capabilities") return Response.json(capabilities);
    if (path === "/api/apps") {
      listCalls++;
      const q = url.searchParams.get("q") ?? "";
      const filtered = records.filter((record) =>
        `${record.name} ${record.description}`
          .toLowerCase()
          .includes(q.toLowerCase()),
      );
      const grouped = sortApps(filtered);
      const offset = Number(url.searchParams.get("after") ?? 0);
      const limit = 2;
      return Response.json({
        starred: grouped.starred,
        history: grouped.history.slice(offset, offset + limit),
        after:
          offset + limit < grouped.history.length
            ? String(offset + limit)
            : null,
        capabilities,
      });
    }
    const match = /^\/api\/apps\/([^/]+)(?:\/(.+))?$/.exec(path)!;
    const id = decodeURIComponent(match[1]!);
    const record = records.find((record) => record.id === id);
    if (!record)
      return Response.json({ error: "App not found." }, { status: 404 });
    if (match[2] === "star") {
      if (!new Headers(init?.headers).get("x-jelly-csrf"))
        throw new Error("Missing CSRF");
      try {
        const updated = options.star
          ? await options.star(id, data.starred)
          : {
              ...record,
              starredAt: data.starred
                ? (record.starredAt ?? new Date().toISOString())
                : null,
            };
        Object.assign(record, updated);
        return Response.json(updated);
      } catch (error) {
        return Response.json(
          { error: (error as Error).message },
          { status: 503 },
        );
      }
    }
    if (match[2] === "launch") {
      record.lastOpenedAt = new Date().toISOString();
      return Response.json(record);
    }
    if (match[2] === "icon")
      return Response.json({ ...record, iconAssetId: "new-icon" });
    return Response.json(record);
  }) as typeof fetch;
  return { calls, listCalls: () => listCalls };
}
const homeProps = {
  active: true,
  focusAppId: null,
  revision: 0,
  changedApp: null,
  onLaunch() {},
  onDetails() {},
  onEdit() {},
  onAdd() {},
  onRemove() {},
};
const viewerProps = {
  appId: "viewer",
  navigationId: "client-viewer",
  changedApp: null,
  revision: 0,
  onHome() {},
  onLaunch(_app: AppRecord) {},
  onChanged() {},
  onDetails() {},
  onEdit() {},
  onRemove() {},
};
afterEach(async () => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  window.open = originalOpen;
  localStorage.clear();
  window.location.href = "http://localhost/";
  window.history.replaceState(null, "", "/");
  if (fixture) await fixture.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  fixture = undefined;
  dir = undefined;
});

test("Apps sorting is starred-first, stable and independent of opening or renaming favorites", () => {
  const old = "2026-01-01T01:00:00.000Z",
    recent = "2026-02-01T01:00:00.000Z";
  const records = [
    app("b", { starredAt: old, lastOpenedAt: recent }),
    app("a", { starredAt: old }),
    app("c", { starredAt: recent }),
    app("new", { createdAt: recent }),
    app("opened", { lastOpenedAt: recent }),
    app("old"),
  ];
  expect(sortApps(records).starred.map((record) => record.id)).toEqual([
    "c",
    "a",
    "b",
  ]);
  expect(sortApps(records).history.map((record) => record.id)).toEqual([
    "new",
    "opened",
    "old",
  ]);
  records[0]!.name = "Renamed";
  expect(sortApps(records).starred.map((record) => record.id)).toEqual([
    "c",
    "a",
    "b",
  ]);
});

test("AppsHome optimistic stars move keyboard focus, roll back with an announcement, and retry without launching", async () => {
  let reject!: (error: Error) => void;
  let attempt = 0,
    launches = 0;
  const record = app("Notes");
  const mock = mockApps([record], {
    star: async (_id, starred) => {
      attempt++;
      if (attempt === 1)
        return new Promise((_resolve, fail) => {
          reject = fail;
        });
      return {
        ...record,
        starredAt: starred ? "2026-02-01T00:00:00.000Z" : null,
      };
    },
  });
  render(<AppsHome {...homeProps} onLaunch={() => launches++} />);
  const star = await screen.findByRole("button", { name: "Star Notes" });
  star.focus();
  fireEvent.click(star);
  const unstar = await screen.findByRole("button", { name: "Unstar Notes" });
  expect(unstar.getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(unstar);
  expect(
    document.querySelector(".apps-starred-grid [data-app-id='Notes']"),
  ).not.toBeNull();
  expect(
    document.querySelector(".apps-history-row[data-app-id='Notes']"),
  ).toBeNull();
  await act(async () => {
    reject(new Error("Save unavailable"));
  });
  const restored = await screen.findByRole("button", { name: "Star Notes" });
  expect(document.activeElement).toBe(restored);
  expect(restored.getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("status").textContent).toContain(
    "Previous state restored",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry star for Notes" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Unstar Notes" })
        .getAttribute("aria-busy"),
    ).toBe("false"),
  );
  expect(document.activeElement?.id).toBe("jelly-app-Notes-star");
  expect(launches).toBe(0);
  expect(
    mock.calls
      .filter((call) => call.path.endsWith("/star"))
      .every((call) => !!call.headers.get("x-jelly-csrf")),
  ).toBe(true);
});

test("AppsHome pagination, search grouping and empty sections stay lightweight", async () => {
  mockApps([
    app("Star", { starredAt: "2026-02-01T00:00:00.000Z" }),
    app("First", { createdAt: "2026-03-01T00:00:00.000Z" }),
    app("Second"),
    app("Third"),
  ]);
  render(<AppsHome {...homeProps} />);
  await screen.findByRole("button", { name: "Open First" });
  expect(screen.queryByRole("button", { name: "Open Third" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load more apps" }));
  await screen.findByRole("button", { name: "Open Third" });
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "Star" },
  });
  await waitFor(() =>
    expect(!!screen.queryByRole("button", { name: "Open First" })).toBe(false),
  );
  expect(screen.getByRole("heading", { name: "Starred" })).toBeDefined();
  expect(screen.queryByRole("heading", { name: "History" })).toBeNull();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "nothing" },
  });
  await screen.findByText("No apps match your search.");
});

test("AppsHome launch updates reorder History but never favorite order, and deterministic home focuses by ID", async () => {
  const first = app("first", { createdAt: "2026-02-01T00:00:00.000Z" }),
    last = app("last");
  mockApps([first, last]);
  const ui = render(<AppsHome {...homeProps} />);
  await screen.findByRole("button", { name: "Open last" });
  ui.rerender(
    <AppsHome
      {...homeProps}
      focusAppId="last"
      changedApp={{ ...last, lastOpenedAt: "2026-03-01T00:00:00.000Z" }}
    />,
  );
  await waitFor(() =>
    expect(
      document
        .querySelector(".apps-history-list li")
        ?.getAttribute("data-app-id"),
    ).toBe("last"),
  );
  expect(document.activeElement?.id).toBe("jelly-app-last-launch");
});

test("AppsHome offers registration, not a build flow, in both empty and populated states", async () => {
  let registrations = 0;
  mockApps([]);
  const ui = render(<AppsHome {...homeProps} onAdd={() => registrations++} />);
  await screen.findByText("Add a trusted app to get started.");
  expect(screen.queryByRole("button", { name: /build/i })).toBeNull();
  expect(screen.queryByText(/Ask Jelly to build/i)).toBeNull();
  expect(screen.getAllByRole("button", { name: "Add app" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Add app" }));
  expect(registrations).toBe(1);
  mockApps([app("Existing")]);
  ui.rerender(<AppsHome {...homeProps} revision={1} onAdd={() => registrations++} />);
  await screen.findByRole("button", { name: "Open Existing" });
  expect(screen.queryByRole("button", { name: /build/i })).toBeNull();
  expect(screen.queryByText(/Ask Jelly to build/i)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add app" }));
  expect(registrations).toBe(2);
});

test("Apps/Agents switching preserves the mounted selected project, draft and chat DOM; Edit with agent prepares an unsent draft", async () => {
  dir = mkdtempSync(join(tmpdir(), "jelly-apps-client-"));
  fixture = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
  });
  const project = fixture.service.saveProject(null, {
    name: "App project",
    defaultCwd: dir,
  });
  const agent = fixture.store.agents()[0]!;
  fixture.service.moveAgent(agent.id, project.id);
  const origin = fixture.server.url.origin;
  const passthrough = browserCookieFetch(origin, originalFetch);
  mockApps([app("Example", { projectId: project.id, builderAgentId: agent.id })], { passthrough });
  globalThis.EventSource = class extends NodeEventSource {
    constructor(url: string) {
      super(new URL(url, origin), { fetch: passthrough });
    }
  } as unknown as typeof EventSource;
  window.history.replaceState(null, "", `/agents/${agent.id}`);
  render(<App />);
  const input = await screen.findByRole("textbox", {
    name: `Message ${agent.name}`,
  });
  fireEvent.change(input, { target: { value: "My existing unsent draft" } });
  const chat = document.querySelector(".conversation")!;
  Object.defineProperty(chat, "scrollHeight", {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(chat, "clientHeight", {
    configurable: true,
    value: 300,
  });
  chat.scrollTop = 42;
  const beforeRuns = fixture.store.runs(agent.id).length;
  fireEvent.click(screen.getByRole("link", { name: "Apps" }));
  await screen.findByRole("button", { name: "Open Example" });
  expect(document.querySelector(".agents-layer")?.hasAttribute("inert")).toBe(
    true,
  );
  expect(document.querySelector(".conversation")).toBe(chat);
  expect((input as HTMLTextAreaElement).value).toBe("My existing unsent draft");
  fixture.service.emit(agent.id, null, "message", {
    role: "assistant",
    text: "Work completed while Apps was open",
  });
  await waitFor(() =>
    expect(
      !!document.querySelector(".agents-layer .agent-indicator.unread"),
    ).toBe(true),
  );
  expect(
    JSON.parse(
      localStorage.getItem(`jelly.read.${fixture.store.instance().id}`) ?? "{}",
    )[agent.id],
  ).toBeUndefined();
  fireEvent.click(screen.getByRole("link", { name: "Agents" }));
  await screen.findByRole("textbox", { name: `Message ${agent.name}` });
  expect(chat.scrollTop).toBe(42);
  expect(
    document.querySelector(".inbox-stack")?.classList.contains("in-project"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Jump to bottom" }));
  await waitFor(() =>
    expect(
      !!document.querySelector(".agents-layer .agent-indicator.unread"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("link", { name: "Apps" }));
  expect(screen.queryByRole("button", { name: "Build an app" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Options for Example" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit with agent" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit Example with agent" });
  expect((within(dialog).getByLabelText("Project") as HTMLSelectElement).value).toBe(project.id);
  expect((within(dialog).getByLabelText("Agent") as HTMLSelectElement).value).toBe(agent.id);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Prepare draft" }),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: `Message ${agent.name}`,
        }) as HTMLTextAreaElement
      ).value,
    ).toContain("My existing unsent draft\n\nI'd like to edit the app “Example”"),
  );
  expect(fixture.store.runs(agent.id)).toHaveLength(beforeRuns);
  const count = fixture.store.agents().length;
  fireEvent.click(screen.getByRole("link", { name: "Apps" }));
  fireEvent.click(screen.getByRole("button", { name: "Options for Example" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit with agent" }));
  const createDialog = await screen.findByRole("dialog", {
    name: "Edit Example with agent",
  });
  fireEvent.change(within(createDialog).getByLabelText("Agent"), {
    target: { value: "" },
  });
  fireEvent.click(
    within(createDialog).getByRole("button", { name: "Prepare draft" }),
  );
  await waitFor(() => expect(fixture!.store.agents().length).toBe(count + 1));
  const created = fixture.store.agents().find((item) => item.id !== agent.id)!;
  expect(created.projectId).toBe(project.id);
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message New Agent",
        }) as HTMLTextAreaElement
      ).value,
    ).toContain("I'd like to edit the app “Example”"),
  );
  expect(fixture.store.runs(created.id)).toHaveLength(0);
}, 15000);

test("Apps navigation does not expose a legacy managed Computer panel", async () => {
  dir = mkdtempSync(join(tmpdir(), "jelly-apps-chrome-only-"));
  fixture = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
  const origin = fixture.server.url.origin;
  const agent = fixture.store.agents()[0]!;
  const passthrough = browserCookieFetch(origin, originalFetch);
  mockApps([app("Private-safe")], { passthrough });
  globalThis.EventSource = class extends NodeEventSource {
    constructor(url: string) { super(new URL(url, origin), { fetch: passthrough }); }
  } as unknown as typeof EventSource;
  window.history.replaceState(null, "", `/agents/${agent.id}`);
  render(<App />);
  await screen.findByRole("textbox", { name: `Message ${agent.name}` });
  expect(screen.queryByRole("button", { name: /^Computer$/ })).toBeNull();
  act(() => {
    window.history.pushState({ jellyDestination: "apps" }, "", "/apps");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  });
  await screen.findByRole("button", { name: "Open Private-safe" });
  expect(window.location.pathname).toBe("/apps");
  expect(screen.queryByRole("dialog", { name: "Agent computer" })).toBeNull();
}, 15000);

test("AppViewer uses the direct canonical URL without bridge or alternate launch and keeps Back reachable", async () => {
  mockApps([app("viewer")]);
  render(<AppViewer {...viewerProps} />);
  const frame = await waitFor(() => {
    const frame = document.querySelector("iframe")!;
    expect(frame).toBeTruthy();
    return frame;
  });
  expect(frame.getAttribute("src")).toBe("http://localhost:3007/dashboard");
  expect(frame.getAttribute("sandbox")).toBe(
    "allow-scripts allow-forms allow-same-origin allow-downloads",
  );
  fireEvent.load(frame);
  expect(screen.getByRole("button", { name: "Back to Apps" })).toBeTruthy();
  expect(screen.queryByText("Open in new tab")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Options for viewer" }));
  expect(screen.queryByRole("menuitem", { name: "Embedding help / retry" })).toBeNull();
  fireEvent.error(frame);
  expect(document.querySelector(".viewer-guidance")).toBeNull();
  expect(screen.queryByText(/App not appearing/)).toBeNull();
  expect(screen.queryByRole("group", { name: "Back to Apps position" })).toBeNull();
  expect(screen.getByRole("navigation", { name: "App navigation" })).toBeTruthy();
  expect(document.querySelector(".viewer-home-pill")).toBeNull();
});
test("AppViewer bottom tabs load every page, deduplicate stars, stay ordered and only launch a different selected app", async () => {
  const records = [
    app("viewer", { name: "Notes" }),
    app("star", { name: "Archive", starredAt: "2026-02-01T00:00:00.000Z" }),
    app("third", { name: "Tasks" }),
    app("fourth", { name: "Weather" }),
  ];
  const mock = mockApps(records);
  const launches: string[] = [];
  let back = 0;
  const props = {
    ...viewerProps,
    navigationId: "tabs-test",
    onLaunch: (record: AppRecord) => launches.push(record.id),
    onHome: () => back++,
  };
  const ui = render(<AppViewer {...props} />);
  const nav = within(screen.getByRole("navigation", { name: "App navigation" }));
  await nav.findByRole("link", { name: "Weather" });
  expect(mock.listCalls()).toBe(2);
  expect(nav.getAllByRole("link").map(link => link.textContent)).toEqual([
    "Archive", "Notes", "Tasks", "Weather",
  ]);
  const selected = nav.getByRole("link", { name: "Notes" });
  expect(selected.getAttribute("aria-current")).toBe("page");
  const frame = document.querySelector("iframe");
  fireEvent.click(selected);
  expect(launches).toEqual([]);
  expect(document.querySelector("iframe")).toBe(frame);
  fireEvent.click(nav.getByRole("link", { name: "Tasks" }), { ctrlKey: true });
  expect(launches).toEqual([]);
  const tasks = nav.getByRole("link", { name: "Tasks" });
  tasks.focus();
  fireEvent.click(tasks);
  expect(launches).toEqual(["third"]);
  ui.rerender(<AppViewer {...props} appId="third" navigationId="tabs-next" />);
  await waitFor(() => expect(tasks.getAttribute("aria-current")).toBe("page"));
  expect(document.activeElement).toBe(tasks);
  expect(nav.getAllByRole("link").map(link => link.textContent)).toEqual([
    "Archive", "Notes", "Tasks", "Weather",
  ]);
  expect(mock.calls.filter(call => call.path.endsWith("/launch"))).toHaveLength(2);
  fireEvent.click(nav.getByRole("button", { name: "Back to Apps" }));
  expect(back).toBe(1);
});

test("AppViewer retains a fetched registration missed by moving history pages, but drops it on registry refresh", async () => {
  const records = [app("viewer", { name: "Notes" }), app("third", { name: "Tasks" })];
  mockApps(records);
  const fetchApps = globalThis.fetch;
  let finishPage!: () => void;
  let firstPage = true;
  globalThis.fetch = (async (input, init) => {
    if (new URL(String(input), window.location.origin).pathname === "/api/apps") {
      // The opened app moved ahead of the cursor after launch recording. Hold
      // the page so the independent registration GET completes first.
      if (firstPage) {
        firstPage = false;
        await new Promise<void>(resolve => { finishPage = resolve; });
      }
      return Response.json({ starred: [], history: [records[1]], after: null, capabilities });
    }
    return fetchApps(input, init);
  }) as typeof fetch;
  const ui = render(<AppViewer {...viewerProps} navigationId="moving-page" />);
  const nav = within(screen.getByRole("navigation", { name: "App navigation" }));
  await waitFor(() => expect(document.querySelector("iframe")?.title).toBe("Notes"));
  await act(async () => finishPage());
  await nav.findByRole("link", { name: "Tasks" });
  ui.rerender(<AppViewer {...viewerProps} appId="third" navigationId="moving-next" />);
  await waitFor(() => expect(document.querySelector("iframe")?.title).toBe("Tasks"));
  expect(nav.getAllByRole("link").map(link => link.textContent)).toEqual(["Notes", "Tasks"]);
  ui.rerender(<AppViewer {...viewerProps} appId="third" navigationId="moving-next" revision={1} />);
  await waitFor(() => expect(nav.queryByRole("link", { name: "Notes" })).toBeNull());
  expect(nav.getByRole("link", { name: "Tasks" }).getAttribute("aria-current")).toBe("page");
});

test("AppViewer keeps the current app and Back usable when tab loading fails, and retries without recording another visit", async () => {
  const mock = mockApps([app("viewer"), app("other")]);
  const fetchApps = globalThis.fetch;
  let fail = true;
  globalThis.fetch = (async (input, init) => {
    if (new URL(String(input), window.location.origin).pathname === "/api/apps" && fail)
      return Response.json({ error: "Registry unavailable" }, { status: 503 });
    return fetchApps(input, init);
  }) as typeof fetch;
  render(<AppViewer {...viewerProps} navigationId="tabs-failed" />);
  await screen.findByText(/Could not load app tabs/);
  await screen.findByRole("link", { name: "viewer" });
  expect(document.querySelector("iframe")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Back to Apps" })).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry app tabs" }));
  await screen.findByRole("link", { name: "other" });
  expect(screen.queryByText(/Could not load app tabs/)).toBeNull();
  expect(mock.calls.filter(call => call.path.endsWith("/launch"))).toHaveLength(1);
});

test("AppViewer mixed content and missing registration show honest retry guidance without a fallback", async () => {
  window.location.href = "https://localhost/apps/viewer";
  mockApps([app("viewer")]);
  render(<AppViewer {...viewerProps} navigationId="mixed-test" />);
  await screen.findByText(/HTTPS Jelly cannot embed this HTTP app/);
  expect(document.querySelector("iframe")).toBeNull();
  expect(screen.queryByText("Open in new tab")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Edit registration" }),
  ).toBeTruthy();
  cleanup();
  render(
    <AppViewer {...viewerProps} appId="missing" navigationId="missing-test" />,
  );
  await screen.findByText("App not found.");
  expect(screen.getByRole("button", { name: "Back to Apps" })).toBeTruthy();
});
test("RemoveApp unregisters metadata only, never offers uninstall", async () => {
  const f = mockApps([app("remove")]);
  render(
    <RemoveApp app={app("remove")} onClose={() => {}} onRemoved={() => {}} />,
  );
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove from Apps" }));
  await waitFor(() =>
    expect(f.calls.some((call) => call.path.endsWith("/remove"))).toBe(true),
  );
  expect(f.calls.find((call) => call.path.endsWith("/remove"))!.data).toEqual(
    {},
  );
});
