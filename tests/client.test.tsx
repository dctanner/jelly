await import("./dom");
import { afterEach, expect, test } from "bun:test";
const { render, screen, fireEvent, waitFor, cleanup, within, act } =
  await import("@testing-library/react");
import { EventSource as NodeEventSource } from "eventsource";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { App } from "../src/client/App";
import { startApp } from "./fixtures/app";
import { registerWorkspaceTools } from "../src/client/webmcp";
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
let app: Awaited<ReturnType<typeof startApp>> | undefined;
let dir: string | undefined;
afterEach(async () => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  localStorage.clear();
  delete (document as any).modelContext;
  if (app) await app.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  app = undefined;
  dir = undefined;
});
async function setup(extra: Partial<Parameters<typeof startApp>[0]> = {}) {
  dir = mkdtempSync(join(tmpdir(), "jelly-client-"));
  app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
    fixtureDelayMs: 5,
    ...extra,
  });
  app.service.setMode("api");
  const origin = `http://127.0.0.1:${app.server.port}`;
  let cookie = "";
  globalThis.fetch = (async (input: any, init: any) => {
    const response = await originalFetch(
      typeof input === "string" && input.startsWith("/")
        ? origin + input
        : input,
      { ...init, headers: { ...init?.headers, ...(cookie ? { cookie } : {}) } },
    );
    if (response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    return response;
  }) as typeof fetch;
  globalThis.EventSource = class extends NodeEventSource {
    constructor(url: string) {
      super(new URL(url, origin), { fetch: originalFetch });
    }
  } as unknown as typeof EventSource;
  return app;
}
test("React client connects, creates an agent, sends through Pi, renders tool completion and restores history on remount", async () => {
  const app = await setup({ fixtureDelayMs: 300 });
  let ui = render(<App />);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Create agent" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
  const dialog = screen.getByRole("dialog", { name: "Create an agent" });
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "Scout" },
  });
  expect(screen.queryByLabelText("Role")).toBeNull();
  fireEvent.change(within(dialog).getByLabelText("Instructions"), {
    target: { value: "Explain your sources." },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Choose avatar" }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "crab" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Create agent" }));
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "Meet Scout." })).toBeDefined(),
  );
  await waitFor(() => expect(screen.getByText("Ready")).toBeDefined());
  const textarea = screen.getByRole("textbox", { name: "Message Scout" });
  fireEvent.change(textarea, { target: { value: "Check the workspace" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => {
    const status = screen
      .getByText("Scout is Working")
      .closest('[role="status"]')!;
    expect(status.textContent).toBe("Scout is Working");
    expect(
      screen
        .getByTitle("Scout · running")
        .querySelector("img")
        ?.getAttribute("src"),
    ).toMatch(/-crab-working\.png$/);
    expect(
      document.querySelector("main > header img.avatar")?.getAttribute("src"),
    ).toMatch(/-crab-working\.png$/);
  });
  await waitFor(
    () =>
      expect(
        within(screen.getByRole("main")).getByText(
          /This is a deterministic test fixture/,
        ),
      ).toBeDefined(),
    { timeout: 3000 },
  );
  expect(screen.getByText("Workspace checked")).toBeDefined();
  expect(screen.queryByText("Local demo")).toBeNull();
  expect(screen.getByText(/^Worked for /)).toBeDefined();
  expect(document.querySelectorAll(".work-activity")).toHaveLength(1);
  expect(document.querySelectorAll(".tool-group, .working")).toHaveLength(0);
  await waitFor(() => {
    expect(document.querySelectorAll('img[src$="-working.png"]')).toHaveLength(
      0,
    );
    expect(
      document.querySelector("main > header img.avatar")?.getAttribute("src"),
    ).toMatch(/-crab\.png$/);
  });
  expect(app.store.agents()).toHaveLength(2);
  const scout = app.store.agents().find((a) => a.name === "Scout")!;
  expect(app.store.runs(scout.id)[0]?.status).toBe("completed");
  ui.unmount();
  ui = render(<App />);
  await waitFor(() =>
    expect(screen.getByText("Check the workspace")).toBeDefined(),
  );
  expect(screen.getByRole("textbox", { name: "Message Scout" })).toBeDefined();
}, 8000);
test("floating agent identity keeps profile and workspace actions accessible", async () => {
  const app = await setup();
  const project = app.service.saveProject(null, {
    name: "Website",
    defaultCwd: dir!,
  });
  app.service.moveAgent(app.store.agents()[0]!.id, project.id);
  render(<App />);
  await waitFor(() => expect(screen.getByText("Ready")).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Jelly details" }));
  const details = screen.getByRole("dialog", { name: "Jelly" });
  expect(within(details).getAllByText("Website").length).toBeGreaterThan(0);
  expect(
    within(screen.getByRole("main")).queryByRole("button", {
      name: "All agents",
    }),
  ).toBeNull();
  for (const name of [
    "Computer",
    "Edit agent profile",
    "Move to project",
    "Archive agent",
  ])
    expect(
      within(details).getByRole("button", { name }).hasAttribute("disabled"),
    ).toBe(false);
  fireEvent.click(
    within(details).getByRole("button", { name: "Edit agent profile" }),
  );
  const profile = screen.getByRole("dialog", { name: "Agent profile" });
  expect(
    (within(profile).getByLabelText("Name") as HTMLInputElement).value,
  ).toBe("Jelly");
});

test("appearance can switch between light, dark and system and survives a client reload", async () => {
  await setup();
  const themeColor = document.createElement("meta");
  themeColor.name = "theme-color";
  document.head.append(themeColor);
  let ui = render(<App />);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Connection and appearance" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Connection and appearance" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Theme" }));
  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(themeColor.content).toBe("#111113");
  expect(localStorage.getItem("jelly.theme")).toBe("dark");
  fireEvent.click(screen.getByRole("radio", { name: "Light" }));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(themeColor.content).toBe("#ffffff");
  expect(localStorage.getItem("jelly.theme")).toBe("light");
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  ui.unmount();
  ui = render(<App />);
  expect(document.documentElement.dataset.theme).toBe("light");
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Connection and appearance" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Connection and appearance" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Theme" }));
  fireEvent.click(screen.getByRole("radio", { name: "System" }));
  expect(localStorage.getItem("jelly.theme")).toBe("system");
  expect(document.documentElement.dataset.theme).toBe(
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
  );
  expect(themeColor.content).toBe(
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "#111113"
      : "#ffffff",
  );
  themeColor.remove();
});
test("optional WebMCP contracts use real agent persistence and reject invalid input", async () => {
  const app = await setup();
  const tools = new Map<string, any>();
  const signals: AbortSignal[] = [];
  (document as any).modelContext = {
    registerTool: (tool: any, options: any) => {
      tools.set(tool.name, tool);
      signals.push(options.signal);
    },
  };
  const unregister = registerWorkspaceTools({
    read: async () => app.service.snapshot(),
    create: async (input) => app.service.createAgent(input),
  });
  expect([...tools.keys()]).toEqual([
    "read_jelly_workspace",
    "create_jelly_agent",
  ]);
  expect(tools.get("read_jelly_workspace").annotations.readOnlyHint).toBe(true);
  const result = await tools
    .get("create_jelly_agent")
    .execute({ name: "MCP Scout" });
  expect(app.store.agent(result.id)?.name).toBe("MCP Scout");
  expect(
    (await tools.get("read_jelly_workspace").execute({})).agents,
  ).toHaveLength(2);
  await expect(
    tools.get("create_jelly_agent").execute({ name: "" }),
  ).rejects.toThrow();
  expect(app.store.agents()).toHaveLength(2);
  unregister();
  expect(signals.every((s) => s.aborted)).toBe(true);
});
test("sudo approval card submits privately, clears its input, and reflects the completed request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-card-"));
  let submitted = "";
  const server = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
    fixtureDelayMs: 1,
    sudoExecutor: async (_command, password) => {
      if (!password.length)
        return {
          exitCode: 1,
          stdout: "",
          stderr: "sudo: a password is required",
          cancelled: false,
          timedOut: false,
        };
      submitted = password.toString();
      return {
        exitCode: 0,
        stdout: "0",
        stderr: "",
        cancelled: false,
        timedOut: false,
      };
    },
  });
  const origin = server.server.url.origin;
  let cookie = "";
  globalThis.fetch = (async (input: any, init: any) => {
    const response = await originalFetch(
      typeof input === "string" && input.startsWith("/")
        ? origin + input
        : input,
      { ...init, headers: { ...init?.headers, ...(cookie ? { cookie } : {}) } },
    );
    if (response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    return response;
  }) as typeof fetch;
  const { InterventionCard } = await import("../src/client/InterventionCard");
  try {
    server.service.setMode("api");
    const id = server.store.agents()[0]!.id;
    server.service.start(id, crypto.randomUUID(), "/fixture sudo");
    await waitFor(() => expect(server.store.interventions()).toHaveLength(1));
    const item = server.store.interventions()[0]!;
    let changed = false;
    render(
      <InterventionCard
        item={item}
        onComputer={() => {}}
        onChange={() => {
          changed = true;
        }}
      />,
    );
    const field = screen.getByLabelText("Sudo password") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "card-test-secret" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Authenticate and run" }),
    );
    expect(field.value).toBe("");
    expect(screen.queryByText("Administrator password required")).toBeNull();
    expect(screen.queryByLabelText("Sudo password")).toBeNull();
    await waitFor(() => expect(changed).toBe(true));
    expect(
      screen.getByText("Sudo completed").closest(".tool-event"),
    ).not.toBeNull();
    await server.service.settled();
    expect(submitted).toBe("card-test-secret");
    expect(JSON.stringify(server.service.snapshot())).not.toContain(
      "card-test-secret",
    );
    expect(localStorage.getItem("card-test-secret")).toBeNull();
  } finally {
    cleanup();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Connection settings accept an API key privately and complete ChatGPT sign-in in the UI", async () => {
  const app = await setup({
    chatgptLogin: async (callbacks) => {
      callbacks.onAuth({
        url: "https://auth.openai.com/oauth/authorize?state=ui-state",
      });
      await callbacks.onManualCodeInput!();
      return {
        access: "ui-access",
        refresh: "ui-refresh",
        expires: Date.now() + 3600000,
      };
    },
  });
  render(<App />);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Connection and appearance" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Connection and appearance" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "OpenAI API" }));
  const key = screen.getByLabelText("OpenAI API key") as HTMLInputElement;
  expect(key.type).toBe("password");
  fireEvent.change(key, { target: { value: "sk-ui-test-private-123456789" } });
  fireEvent.click(screen.getByRole("button", { name: "Save API key" }));
  expect(key.value).toBe("");
  await waitFor(() => expect(screen.getByText(/API key saved/)).toBeDefined());
  expect(app.service.snapshot().config.activeMode).toBe("api");
  expect(JSON.stringify(app.service.snapshot())).not.toContain(
    "sk-ui-test-private-123456789",
  );
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: "ChatGPT" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Connect ChatGPT" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect ChatGPT" }));
  const link = await screen.findByRole(
    "link",
    { name: "Continue to ChatGPT" },
    { timeout: 3000 },
  );
  expect(link.getAttribute("href")).toContain("https://auth.openai.com/");
  fireEvent.click(screen.getByText("Sign-in tab didn’t return?"));
  const callback = screen.getByLabelText("Callback URL") as HTMLInputElement;
  fireEvent.change(callback, {
    target: {
      value: "http://localhost:1455/auth/callback?code=ui-code&state=ui-state",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Complete sign-in" }));
  expect(callback.value).toBe("");
  await waitFor(
    () => expect(screen.getByText("ChatGPT connected.")).toBeDefined(),
    { timeout: 3000 },
  );
  expect(app.service.snapshot().config.activeMode).toBe("chatgpt");
  expect(JSON.stringify(app.service.snapshot())).not.toContain("ui-access");
});
test("grouped settings use checkmarked model and effort choices and persist on Done", async () => {
  const app = await setup();
  let ui = render(<App />);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Connection and appearance" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Connection and appearance" }),
  );
  expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(
    (screen.getByRole("radio", { name: "GPT-6 Astra" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "GPT-6 Sol" }));
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: "Reasoning effort" }));
  expect(
    (screen.getByRole("radio", { name: "Medium" }) as HTMLInputElement).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Max" }));
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(!!screen.queryByRole("dialog")).toBe(false));
  expect(app.service.snapshot().config).toMatchObject({
    selectedModel: "gpt-6-sol",
    effort: "max",
  });
  ui.unmount();
  ui = render(<App />);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Connection and appearance" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Connection and appearance" }),
  );
  expect(screen.getByRole("button", { name: "Model" }).textContent).toContain(
    "GPT-6 Sol",
  );
  expect(
    screen.getByRole("button", { name: "Reasoning effort" }).textContent,
  ).toContain("Max");
});

test("project navigation retains per-agent drafts, empty scopes clear chat, and switches keep one event stream", async () => {
  const app = await setup();
  const website = app.service.saveProject(null, {
    name: "Website",
    defaultCwd: dir!,
  });
  const empty = app.service.saveProject(null, {
    name: "Empty project",
    defaultCwd: dir!,
  });
  const a = app.service.createAgent({
    name: "Milo",

    instructions: "",
    color: "#a4c8e8",
    projectId: website.id,
  });
  const Stream = globalThis.EventSource;
  let streams = 0;
  globalThis.EventSource = class extends Stream {
    constructor(url: string) {
      super(url);
      streams++;
    }
  } as typeof EventSource;
  render(<App />);
  await waitFor(() => expect(screen.getByText("Ready")).toBeDefined());
  fireEvent.change(screen.getByRole("textbox", { name: "Message Jelly" }), {
    target: { value: "Keep my Jelly draft" },
  });
  fireEvent.click(screen.getAllByRole("button", { name: "All agents" })[0]!);
  let switcher = screen.getByRole("dialog", { name: "Switch project" });
  fireEvent.click(within(switcher).getByRole("button", { name: /Website/ }));
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "Meet Milo." })).toBeDefined(),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Message Milo" }), {
    target: { value: "Keep my Milo draft" },
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Website" })[0]!);
  switcher = screen.getByRole("dialog", { name: "Switch project" });
  fireEvent.click(
    within(switcher).getByRole("button", { name: /Empty project/ }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "A fresh space for your ideas." }),
    ).toBeDefined(),
  );
  expect(
    screen
      .getByRole("textbox", { name: "Message agent" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.queryByRole("heading", { name: "Meet Milo." })).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Empty project" })[0]!);
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Switch project" })).getByRole(
      "button",
      { name: /Website/ },
    ),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message Milo",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Keep my Milo draft"),
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Website" })[0]!);
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Switch project" })).getByRole(
      "button",
      { name: /Ungrouped/ },
    ),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message Jelly",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Keep my Jelly draft"),
  );
  expect(streams).toBe(1);
  expect(app.store.agent(a.id)!.cwd).toBe(dir!);
  expect(empty.id).toBeTruthy();
});

test("remote membership and project deletion reconcile current scope without sending or stopping work", async () => {
  const app = await setup();
  const p = app.service.saveProject(null, {
    name: "Research",
    defaultCwd: dir!,
  });
  const a = app.service.createAgent({
    name: "Fin",

    instructions: "",
    color: "#a4c8e8",
    projectId: p.id,
  });
  render(<App />);
  await waitFor(() => expect(screen.getByText("Ready")).toBeDefined());
  fireEvent.click(screen.getAllByRole("button", { name: "All agents" })[0]!);
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Switch project" })).getByRole(
      "button",
      { name: /Research/ },
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "Meet Fin." })).toBeDefined(),
  );
  app.service.moveAgent(a.id, null);
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "A fresh space for your ideas." }),
    ).toBeDefined(),
  );
  expect(screen.queryByRole("textbox", { name: "Message Fin" })).toBeNull();
  app.service.deleteProject(p.id);
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: "All agents" }).length,
    ).toBeGreaterThan(0),
  );
  expect(app.store.runs(a.id)).toEqual([]);
});

test("project create form confirms a server folder and new agent inherits it with a chosen avatar", async () => {
  const app = await setup();
  const { ProjectForm } = await import("../src/client/Projects");
  let saved: any;
  const ui = render(
    <ProjectForm
      instance="Test server"
      count={0}
      onClose={() => {}}
      onDeleted={() => {}}
      onSaved={(p) => {
        saved = p;
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText("Project name"), {
    target: { value: "Test project" },
  });
  expect(
    screen
      .getByRole("button", { name: "Create project" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Use this folder" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(screen.getByText(/Test server/)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
  expect(
    (screen.getByLabelText("Project name") as HTMLInputElement).value,
  ).toBe("Test project");
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await waitFor(() => expect(saved?.name).toBe("Test project"));
  ui.unmount();
  render(<App />);
  await waitFor(() => expect(screen.getByText("Ready")).toBeDefined());
  fireEvent.click(screen.getAllByRole("button", { name: "All agents" })[0]!);
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Switch project" })).getByRole(
      "button",
      { name: /Test project/ },
    ),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "A fresh space for your ideas." }),
    ).toBeDefined(),
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Create agent" })[0]!);
  const form = screen.getByRole("dialog", { name: "Create an agent" });
  fireEvent.change(within(form).getByLabelText("Name"), {
    target: { value: "Pearl" },
  });
  expect(screen.queryByLabelText("Role")).toBeNull();
  fireEvent.click(within(form).getByRole("button", { name: "Choose avatar" }));
  fireEvent.click(within(form).getByRole("button", { name: "sea turtle" }));
  fireEvent.click(within(form).getByRole("button", { name: "Create agent" }));
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "Meet Pearl." })).toBeDefined(),
  );
  const a = app.store.agents().find((a) => a.name === "Pearl")!;
  expect(a.cwd).toBe(saved.defaultCwd);
  expect(a.projectId).toBe(saved.id);
  expect(a.avatarId).toBe("sea-turtle");
});

test("late history from a rapid A to B to A switch cannot replace the selected chat or its draft", async () => {
  const app = await setup();
  const b = app.service.createAgent({
    name: "Pearl",

    instructions: "",
    color: "#a4c8e8",
  });
  render(<App />);
  await waitFor(() => expect(screen.getByText("Ready")).toBeDefined());
  fireEvent.change(screen.getByRole("textbox", { name: "Message Jelly" }), {
    target: { value: "Still my draft" },
  });
  const fetchBefore = globalThis.fetch;
  let release = () => {},
    started = false;
  const gate = new Promise<void>((r) => (release = r));
  globalThis.fetch = (async (input: any, init: any) => {
    const result = await fetchBefore(input, init);
    if (typeof input === "string" && input.includes(`/state?agentId=${b.id}`)) {
      started = true;
      await gate;
    }
    return result;
  }) as typeof fetch;
  fireEvent.click(screen.getByTitle("Pearl · idle"));
  await waitFor(() => expect(started).toBe(true));
  fireEvent.click(screen.getByTitle("Jelly · idle"));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message Jelly",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Still my draft"),
  );
  release();
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByRole("textbox", { name: "Message Pearl" })).toBeNull();
  expect(
    (
      screen.getByRole("textbox", {
        name: "Message Jelly",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("Still my draft");
});

test("assistant formatting renders code and safe links without interpreting model HTML", async () => {
  const { MessageText } = await import("../src/client/MessageText");
  const view = render(
    <MessageText
      text={
        "## Hello\n\n**Readable** and `literal`\n\n- One\n- Two\n\n```html\n<script>alert(1)</script>\n```\n\n[Docs](https://example.com/docs)\n\n[Bad](javascript:alert(1))"
      }
    />,
  );
  expect(screen.getByRole("heading", { name: "Hello" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Docs" }).getAttribute("rel")).toBe(
    "noopener noreferrer",
  );
  expect(view.container.querySelectorAll("script")).toHaveLength(0);
  expect(view.container.querySelectorAll("a")).toHaveLength(1);
  expect(view.container.querySelector("pre")?.textContent).toContain(
    "<script>alert(1)</script>",
  );
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
});

test("consecutive tools group without duplicate results or crossing messages and runs", async () => {
  const { groupActivity } = await import("../src/client/activityGroups");
  const event = (
    id: number,
    type: string,
    toolCallId = "",
    runId = "run-1",
  ) => ({
    id,
    type,
    runId,
    agentId: "agent",
    data: { toolCallId },
    createdAt: new Date().toISOString(),
  });
  const groups = groupActivity([
    event(1, "tool_started", "a"),
    event(2, "tool_completed", "a"),
    event(3, "tool_started", "b"),
    event(4, "tool_completed", "b"),
    event(5, "message"),
    event(6, "tool_started", "c"),
    event(7, "tool_completed", "orphan"),
    event(8, "tool_started", "d", "run-2"),
  ]);
  expect(groups.map((group) => group.map((item) => item.id))).toEqual([
    [1, 3],
    [5],
    [6, 7],
    [8],
  ]);
});

test("tool groups span turn, subagent and compaction events but preserve message and run boundaries", async () => {
  const { groupActivity, isToolActivity } =
    await import("../src/client/activityGroups");
  const event = (id: number, type: string, toolCallId = "") => ({
    id,
    type,
    runId: "run",
    agentId: "agent",
    data: { toolCallId },
    createdAt: new Date().toISOString(),
  });
  const groups = groupActivity([
    event(1, "message"),
    event(2, "tool_started", "a"),
    event(3, "tool_completed", "a"),
    event(4, "turn_completed"),
    event(5, "subagent_started"),
    event(6, "tool_started", "b"),
    event(7, "compaction_completed"),
    event(8, "tool_completed", "b"),
    event(9, "tool_started", "c"),
    event(10, "message"),
    event(11, "tool_started", "d"),
    event(12, "run_failed"),
  ]);
  expect(groups.map((group) => group.map((item) => item.id))).toEqual([
    [1],
    [2, 4, 5, 6, 7, 9],
    [10],
    [11],
    [12],
  ]);
  expect(groups.map((group) => group.filter(isToolActivity).length)).toEqual([
    0, 3, 0, 1, 0,
  ]);
});

test("copy text uses modern clipboard and falls back on HTTP or permission failure", async () => {
  const { copyText } = await import("../src/client/clipboard");
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const exec = Object.getOwnPropertyDescriptor(document, "execCommand");
  const copied: string[] = [];
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    });
    await copyText("modern");
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: (command: string) => {
        expect(command).toBe("copy");
        copied.push((document.activeElement as HTMLTextAreaElement).value);
        return true;
      },
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    await copyText("http fallback");
    expect(document.activeElement).toBe(input);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Denied");
        },
      },
    });
    await copyText("permission fallback");
    expect(copied).toEqual(["modern", "http fallback", "permission fallback"]);
    expect(document.querySelector("textarea")).toBeNull();
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
    await expect(copyText("blocked")).rejects.toThrow(
      "Clipboard access denied",
    );
  } finally {
    input.remove();
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else delete (navigator as any).clipboard;
    if (exec) Object.defineProperty(document, "execCommand", exec);
    else delete (document as any).execCommand;
  }
});

test("chat model menu persists choices without changing connection mode and dismisses with Escape", async () => {
  const app = await setup();
  render(<App />);
  const trigger = await screen.findByRole("button", {
    name: "Model and effort",
  });
  await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
  expect(document.querySelector(".mode-note")).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
  fireEvent.click(trigger);
  const model = screen.getByRole("combobox", {
    name: "Model",
  }) as HTMLSelectElement;
  expect(model.value).toBe("gpt-6-astra");
  fireEvent.change(model, { target: { value: "gpt-6-sol" } });
  await waitFor(() => {
    expect(model.value).toBe("gpt-6-sol");
    expect(model.disabled).toBe(false);
  });
  const effort = screen.getByRole("combobox", {
    name: "Reasoning effort",
  }) as HTMLSelectElement;
  fireEvent.change(effort, { target: { value: "high" } });
  await waitFor(() => {
    expect(effort.value).toBe("high");
    expect(effort.disabled).toBe(false);
  });
  expect(app.service.snapshot().config).toMatchObject({
    selectedModel: "gpt-6-sol",
    effort: "high",
    mode: "api",
  });
  fireEvent.keyDown(effort, { key: "Escape" });
  expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

test("composer expands, caps at the available page height, and shrinks when text is removed", async () => {
  await setup();
  render(<App />);
  const input = (await screen.findByRole("textbox", {
    name: /Message Jelly/,
  })) as HTMLTextAreaElement;
  const main = input.closest("main")!;
  Object.defineProperty(main, "clientHeight", {
    configurable: true,
    value: 800,
  });
  let contentHeight = 240;
  Object.defineProperty(input, "scrollHeight", {
    configurable: true,
    get: () => contentHeight,
  });
  fireEvent.change(input, { target: { value: "one\ntwo\nthree" } });
  expect(input.style.height).toBe("240px");
  expect(input.style.overflowY).toBe("hidden");
  contentHeight = 1200;
  fireEvent.change(input, { target: { value: "line\n".repeat(80) } });
  expect(parseFloat(input.style.height)).toBeLessThanOrEqual(800);
  expect(input.style.overflowY).toBe("auto");
  contentHeight = 44;
  fireEvent.change(input, { target: { value: "" } });
  expect(input.style.height).toBe("44px");
  expect(input.style.overflowY).toBe("hidden");
});

test("settings shows read-only MCP status and refreshes agent configuration changes", async () => {
  const app = await setup();
  render(<App />);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Connection and appearance" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Connection and appearance" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "MCP connections" }));
  const fieldset = await screen.findByRole("group", {
    name: "MCP connections",
  });
  await waitFor(() =>
    expect(
      within(fieldset).getByText("No MCP servers connected."),
    ).toBeTruthy(),
  );
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    app.service.harness.mcps.configPath,
    JSON.stringify({
      imports: [],
      mcpServers: { offline: { command: "/nonexistent/jelly-mcp-command" } },
    }),
  );
  fireEvent.click(
    within(fieldset).getByRole("button", { name: "Refresh MCP connections" }),
  );
  await waitFor(() =>
    expect(within(fieldset).getByText("offline")).toBeTruthy(),
  );
  expect(within(fieldset).getByText("Unavailable")).toBeTruthy();
  expect(within(fieldset).queryAllByRole("textbox")).toHaveLength(0);
  expect(within(fieldset).getAllByRole("button")).toHaveLength(1);
});

test("agent menu uploads multiple files to a chosen host folder and appends only names to the draft", async () => {
  const app = await setup();
  const destination = join(dir!, "chosen folder");
  mkdirSync(destination);
  const agent = app.store.agents()[0]!;
  render(<App />);
  await waitFor(() => expect(screen.getByText("Ready")).toBeDefined());
  const draft = screen.getByRole("textbox", {
    name: "Message Jelly",
  }) as HTMLTextAreaElement;
  fireEvent.change(draft, { target: { value: "Please review" } });
  expect(document.querySelector('.composer input[type="file"]')).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Upload file" })
      .hasAttribute("disabled"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Agent options" }));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Jelly" })).getByRole("button", {
      name: "Upload file",
    }),
  );
  const dialog = screen.getByRole("dialog", { name: "Upload file" });
  expect(
    (within(dialog).getByLabelText("Destination folder") as HTMLInputElement)
      .value,
  ).toBe(agent.cwd);
  fireEvent.change(within(dialog).getByLabelText("Destination folder"), {
    target: { value: dir! },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Browse host folders" }),
  );
  const picker = screen.getByRole("dialog", { name: "Choose a folder" });
  fireEvent.click(
    await within(picker).findByRole("button", { name: "chosen folder" }),
  );
  await waitFor(() =>
    expect(
      within(picker)
        .getByRole("button", { name: "Use this folder" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    within(picker).getByRole("button", { name: "Use this folder" }),
  );
  expect(
    (within(dialog).getByLabelText("Destination folder") as HTMLInputElement)
      .value,
  ).toBe(destination);
  const binary = new Uint8Array([0, 255, 128, 4]);
  fireEvent.change(within(dialog).getByLabelText("Files"), {
    target: {
      files: [
        new File([binary], "résumé.bin"),
        new File(["hello"], "notes.txt"),
      ],
    },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Upload" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Upload file" })?.textContent ??
        "closed",
    ).toBe("closed"),
  );
  expect(draft.value).toBe("Please review résumé.bin notes.txt");
  expect(readFileSync(join(destination, "résumé.bin"))).toEqual(
    Buffer.from(binary),
  );
  expect(readFileSync(join(destination, "notes.txt"), "utf8")).toBe("hello");
  expect(app.store.runs(agent.id)).toHaveLength(0);
});

test("composer upload button opens the shared modal and partial failures retry only failed files", async () => {
  const app = await setup();
  const agent = app.store.agents()[0]!;
  mkdirSync(agent.cwd, { recursive: true });
  writeFileSync(join(agent.cwd, "existing.txt"), "original");
  const retryFolder = join(dir!, "retry");
  mkdirSync(retryFolder);
  render(<App />);
  await waitFor(() => expect(screen.getByText("Ready")).toBeDefined());
  const draft = screen.getByRole("textbox", {
    name: "Message Jelly",
  }) as HTMLTextAreaElement;
  fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
  const dialog = screen.getByRole("dialog", { name: "Upload file" });
  fireEvent.change(within(dialog).getByLabelText("Files"), {
    target: {
      files: [
        new File(["new"], "existing.txt"),
        new File(["good"], "success.txt"),
      ],
    },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Upload" }));
  await waitFor(() =>
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "already exists",
    ),
  );
  expect(draft.value).toBe("success.txt");
  expect(readFileSync(join(agent.cwd, "existing.txt"), "utf8")).toBe(
    "original",
  );
  fireEvent.change(draft, { target: { value: "Review success.txt and" } });
  fireEvent.change(within(dialog).getByLabelText("Destination folder"), {
    target: { value: retryFolder },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Retry failed uploads" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Upload file" })?.textContent ??
        "closed",
    ).toBe("closed"),
  );
  expect(draft.value).toBe("Review success.txt and existing.txt");
  expect(readFileSync(join(retryFolder, "existing.txt"), "utf8")).toBe("new");
});

test("busy composer defaults to Queued, can promote a sent message, and resets Steer after sending", async () => {
  const app = await setup({ fixtureDelayMs: 800 });
  const id = app.store.agents()[0]!.id;
  let ui = render(<App />);
  await waitFor(() => expect(screen.getByText("Ready")).toBeDefined());
  app.service.start(id, "ui-first", "Keep working");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Queue message" })).toBeDefined(),
  );
  const textarea = screen.getByRole("textbox", { name: "Message Jelly" });
  expect(
    (screen.getByLabelText("Message delivery") as HTMLSelectElement).value,
  ).toBe("queue");
  fireEvent.change(textarea, { target: { value: "Do this later" } });
  fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Steer now" })).toBeDefined(),
  );
  expect(app.store.pendingMessages(id)[0]?.mode).toBe("queue");
  expect(screen.getByRole("button", { name: "Stop agent" })).toBeDefined();
  ui.unmount();
  ui = render(<App />);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Steer now" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Steer now" }));
  await waitFor(() =>
    expect(app.store.pendingMessages(id)[0]?.mode).toBe("steer"),
  );
  expect(screen.queryByRole("button", { name: "Steer now" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Message delivery"), {
    target: { value: "steer" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Message Jelly" }), {
    target: { value: "One more correction" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Steer agent" }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message Jelly",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe(""),
  );
  expect(
    (screen.getByLabelText("Message delivery") as HTMLSelectElement).value,
  ).toBe("queue");
  await act(async () => {
    await app.service.settled();
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeDefined(),
  );
  expect(app.store.runs(id)).toHaveLength(1);
  expect(
    app.store.history(id).filter((message) => message.role === "user"),
  ).toHaveLength(3);
  ui.unmount();
});

test("settled sudo requests render compact tool rows, not password cards", async () => {
  const { InterventionCard } = await import("../src/client/InterventionCard");
  const item = {
    id: "sudo-test",
    agentId: "agent",
    runId: "run",
    kind: "sudo" as const,
    status: "pending" as const,
    payload: {
      executable: "/usr/bin/id",
      args: ["-u"],
      cwd: "/tmp",
      reason: "Check identity",
    },
    result: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
  };
  for (const status of [
    "executing",
    "completed",
    "failed",
    "denied",
    "cancelled",
    "expired",
    "interrupted",
  ] as const) {
    const ui = render(
      <InterventionCard
        item={{ ...item, status }}
        onComputer={() => {}}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByText("Administrator password required")).toBeNull();
    expect(screen.queryByLabelText("Sudo password")).toBeNull();
    expect(
      screen.getByText(`Sudo ${status}`).closest("details")?.className,
    ).toBe("tool-event");
    ui.rerender(
      <InterventionCard
        item={{ ...item, status }}
        hasInlineTool
        onComputer={() => {}}
        onChange={() => {}}
      />,
    );
    expect(ui.container.textContent).toBe("");
    ui.unmount();
  }
});

test("dismissed sudo cards disappear from chat without duplicating the inline tool call", async () => {
  const app = await setup({
    sudoExecutor: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "sudo: a password is required",
      cancelled: false,
      timedOut: false,
    }),
  });
  render(<App />);
  await screen.findByRole("textbox", { name: /Message Jelly/ });
  const id = app.store.agents()[0]!.id;
  app.service.start(id, crypto.randomUUID(), "/fixture sudo");
  await screen.findByText("Administrator password required");
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(screen.queryByText("Administrator password required")).toBeNull();
  await waitFor(() =>
    expect(app.store.interventions()[0]?.status).toBe("denied"),
  );
  await app.service.settled();
  await waitFor(() =>
    expect(screen.queryByText("Administrator password required")).toBeNull(),
  );
  const tool = screen.getByText("Administrator access");
  expect(!!tool.closest(".timeline")).toBe(true);
  expect(!!tool.closest(".work-step")).toBe(true);
});

test("failed sudo submission restores an empty password form for retry", async () => {
  const { InterventionCard } = await import("../src/client/InterventionCard");
  globalThis.fetch = (async (input: any) => {
    if (String(input).endsWith("/control-session"))
      return Response.json({ csrf: "test" });
    return Response.json(
      { error: "Could not submit request." },
      { status: 400 },
    );
  }) as typeof fetch;
  render(
    <InterventionCard
      item={{
        id: "retry",
        agentId: "agent",
        runId: "run",
        kind: "sudo",
        status: "pending",
        payload: {
          executable: "/usr/bin/id",
          args: [],
          cwd: "/tmp",
          reason: "Test",
        },
        result: null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
      }}
      hasInlineTool
      onComputer={() => {}}
      onChange={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("Sudo password"), {
    target: { value: "test-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Authenticate and run" }));
  expect(screen.queryByLabelText("Sudo password")).toBeNull();
  await screen.findByText("Could not submit request.");
  expect(
    (screen.getByLabelText("Sudo password") as HTMLInputElement).value,
  ).toBe("");
  expect(
    screen
      .getByRole("button", { name: "Authenticate and run" })
      .hasAttribute("disabled"),
  ).toBe(false);
  expect(document.body.textContent).not.toContain("test-secret");
});

test("mobile chat follows keyboard viewport height and panning, then restores full-screen layout", async () => {
  const originalViewport = Object.getOwnPropertyDescriptor(
    window,
    "visualViewport",
  );
  const originalMatchMedia = window.matchMedia;
  const viewport = Object.assign(new window.EventTarget(), {
    height: window.innerHeight,
    offsetTop: 0,
    scale: 1,
  });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  window.matchMedia = ((query: string) => {
    const media = originalMatchMedia.call(window, query);
    if (query === "(max-width: 767px)")
      Object.defineProperty(media, "matches", { value: true });
    return media;
  }) as typeof window.matchMedia;
  try {
    await setup();
    const ui = render(<App />);
    const input = await screen.findByRole("textbox", { name: /Message Jelly/ });
    const root = ui.container.querySelector(".app") as HTMLElement;
    const chat = ui.container.querySelector(".conversation") as HTMLDivElement;
    let contentHeight = 1600;
    Object.defineProperty(chat, "scrollHeight", {
      configurable: true,
      get: () => contentHeight,
    });
    Object.defineProperty(chat, "clientHeight", {
      configurable: true,
      get: () =>
        parseFloat(root.style.getPropertyValue("--keyboard-viewport-height")) ||
        window.innerHeight,
    });
    chat.scrollTo = ((options: ScrollToOptions) => {
      expect(options.behavior).toBe("instant");
      chat.scrollTop = Math.max(
        0,
        Math.min(options.top ?? 0, chat.scrollHeight - chat.clientHeight),
      );
    }) as typeof chat.scrollTo;
    chat.scrollTop = chat.scrollHeight - chat.clientHeight;
    expect(root.dataset.keyboardOpen).toBeUndefined();
    act(() => input.focus());
    // Keyboard resize events don't necessarily resize the layout viewport on iOS.
    act(() => {
      viewport.height = 320;
      viewport.dispatchEvent(new window.Event("resize"));
    });
    expect(root.dataset.keyboardOpen).toBe("true");
    expect(root.style.getPropertyValue("--keyboard-viewport-height")).toBe(
      "320px",
    );
    expect(chat.scrollTop).toBe(contentHeight - 320);
    // Composer resizing can adjust scroll padding after the viewport event.
    contentHeight += 100;
    await waitFor(() => expect(chat.scrollTop).toBe(contentHeight - 320));
    act(() => {
      viewport.offsetTop = 64;
      viewport.dispatchEvent(new window.Event("scroll"));
    });
    expect(root.style.getPropertyValue("--keyboard-viewport-top")).toBe("64px");
    act(() => input.blur());
    expect(root.dataset.keyboardOpen).toBe("true");
    act(() => {
      viewport.height = window.innerHeight;
      viewport.offsetTop = 0;
      viewport.dispatchEvent(new window.Event("resize"));
    });
    expect(root.dataset.keyboardOpen).toBeUndefined();
    expect(root.style.getPropertyValue("--keyboard-viewport-height")).toBe("");
    expect(chat.scrollTop).toBe(contentHeight - window.innerHeight);
    // Explicitly scrolling up cancels any pending bottom correction, and the
    // next keyboard resize must preserve the reader's position.
    fireEvent.touchMove(chat);
    chat.scrollTop = 100;
    // Pinch zoom must not be mistaken for a keyboard.
    act(() => {
      input.focus();
      viewport.height = 320;
      viewport.scale = 2;
      viewport.dispatchEvent(new window.Event("resize"));
    });
    expect(root.dataset.keyboardOpen).toBeUndefined();
    act(() => {
      viewport.scale = 1;
      viewport.dispatchEvent(new window.Event("resize"));
    });
    expect(root.dataset.keyboardOpen).toBe("true");
    expect(chat.scrollTop).toBe(100);
    ui.unmount();
    expect(root.dataset.keyboardOpen).toBeUndefined();
    viewport.dispatchEvent(new window.Event("resize"));
    expect(root.style.getPropertyValue("--keyboard-viewport-height")).toBe("");
  } finally {
    cleanup();
    window.matchMedia = originalMatchMedia;
    if (originalViewport)
      Object.defineProperty(window, "visualViewport", originalViewport);
    else delete (window as any).visualViewport;
  }
});

test("browser login cards collapse after opening or settling, without duplicating tool history", async () => {
  const { InterventionCard } = await import("../src/client/InterventionCard");
  const item = {
    id: "browser-test",
    agentId: "agent",
    runId: "run",
    kind: "browser_login" as const,
    status: "pending" as const,
    payload: { url: "https://example.com", reason: "Sign in privately" },
    result: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
  };
  let opened = 0;
  const onComputer = () => {
    opened++;
  };
  const onChange = () => {};
  const ui = render(
    <InterventionCard
      item={item}
      onComputer={onComputer}
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
  expect(opened).toBe(1);
  expect(screen.queryByText("Sign in through the browser")).toBeNull();
  expect(
    screen.getByText("Browser login in progress").closest(".tool-event"),
  ).not.toBeNull();
  ui.rerender(
    <InterventionCard
      item={item}
      hasInlineTool
      onComputer={onComputer}
      onChange={onChange}
    />,
  );
  expect(ui.container.textContent).toBe("");
  ui.unmount();
  for (const status of [
    "completed",
    "denied",
    "cancelled",
    "expired",
    "interrupted",
    "failed",
  ] as const) {
    const settled = render(
      <InterventionCard
        item={{ ...item, status }}
        onComputer={onComputer}
        onChange={onChange}
      />,
    );
    expect(screen.queryByText("Sign in through the browser")).toBeNull();
    expect(
      screen.getByText(`Browser login ${status}`).closest(".tool-event"),
    ).not.toBeNull();
    settled.rerender(
      <InterventionCard
        item={{ ...item, status }}
        hasInlineTool
        onComputer={onComputer}
        onChange={onChange}
      />,
    );
    expect(settled.container.textContent).toBe("");
    settled.unmount();
  }
});

test("browser login dismissal hides immediately and failed dismissal restores the card", async () => {
  const { InterventionCard } = await import("../src/client/InterventionCard");
  let fail = true;
  globalThis.fetch = (async (input: any) => {
    if (String(input).endsWith("/control-session"))
      return Response.json({ csrf: "test" });
    return fail
      ? Response.json({ error: "Dismissal failed." }, { status: 400 })
      : Response.json({ ok: true });
  }) as typeof fetch;
  let changed = false;
  const ui = render(
    <InterventionCard
      item={{
        id: "browser-deny",
        agentId: "agent",
        runId: "run",
        kind: "browser_login",
        status: "pending",
        payload: { url: "https://example.com", reason: "Sign in" },
        result: null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
      }}
      hasInlineTool
      onComputer={() => {}}
      onChange={() => {
        changed = true;
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(screen.queryByText("Sign in through the browser")).toBeNull();
  await screen.findByText("Dismissal failed.");
  expect(screen.getByText("Sign in through the browser")).toBeDefined();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(ui.container.textContent).toBe("");
  await waitFor(() => expect(changed).toBe(true));
  expect(ui.container.textContent).toBe("");
});

test("agent list shows only unread and attention dots, never ready or working dots", async () => {
  const app = await setup();
  for (const status of [
    "running",
    "waiting",
    "error",
    "interrupted",
  ] as const) {
    const agent = app.service.createAgent({
      name: `Status-${status}`,
      instructions: "Test agent",
      color: "#3478f6",
    });
    app.store.setStatus(agent.id, status);
  }
  render(<App />);
  const ready = await screen.findByTitle("Jelly · idle");
  expect(ready.querySelector(".status-dot")).toBeNull();
  expect(
    screen.getByTitle("Status-running · running").querySelector(".status-dot"),
  ).toBeNull();
  for (const status of ["waiting", "error", "interrupted"] as const) {
    const row = screen.getByTitle(`Status-${status} · ${status}`);
    expect(
      within(row).getByRole("img", { name: "Needs attention" }),
    ).toBeDefined();
    expect(row.querySelector(".agent-indicator.attention")).not.toBeNull();
  }
  expect(
    document.querySelector(".header-status .status-dot.idle"),
  ).not.toBeNull();
});

test("unread agent dots track assistant messages and persist read receipts across reloads", async () => {
  const app = await setup();
  const jelly = app.store.agents()[0]!;
  const other = app.service.createAgent({
    name: "Other",
    instructions: "Test",
    color: "#3478f6",
  });
  localStorage.setItem("jelly.agent", jelly.id);
  let ui = render(<App />);
  await screen.findByTitle("Other · idle");
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Create agent" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  app.service.emit(other.id, null, "message", {
    role: "assistant",
    text: "New reply",
  });
  await waitFor(() =>
    expect(
      within(screen.getByTitle("Other · idle")).getByRole("img", {
        name: "Unread messages",
      }),
    ).toBeDefined(),
  );
  // User messages and tool activity do not mark an agent unread.
  app.service.emit(jelly.id, null, "message", { role: "user", text: "Hello" });
  await screen.findByText("Hello");
  expect(
    screen.getByTitle("Jelly · idle").querySelector(".agent-indicator"),
  ).toBeNull();
  fireEvent.click(screen.getByTitle("Other · idle"));
  await within(screen.getByRole("main")).findByText("New reply");
  await waitFor(() =>
    expect(screen.queryByRole("img", { name: "Unread messages" })).toBeNull(),
  );
  fireEvent.click(screen.getByTitle("Jelly · idle"));
  await screen.findByRole("textbox", { name: "Message Jelly" });
  ui.unmount();
  ui = render(<App />);
  await screen.findByTitle("Other · idle");
  expect(screen.queryByRole("img", { name: "Unread messages" })).toBeNull();
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Create agent" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  app.service.emit(other.id, null, "message", {
    role: "assistant",
    text: "Another reply",
  });
  await waitFor(() =>
    expect(
      within(screen.getByTitle("Other · idle")).getByRole("img", {
        name: "Unread messages",
      }),
    ).toBeDefined(),
  );
});

test("mobile list and hidden tabs do not silently mark messages read", async () => {
  const originalMatchMedia = window.matchMedia;
  const originalVisibility = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState",
  );
  window.matchMedia = ((query: string) => {
    const media = originalMatchMedia.call(window, query);
    if (query === "(max-width:767px)")
      Object.defineProperty(media, "matches", { value: true });
    return media;
  }) as typeof window.matchMedia;
  try {
    const app = await setup();
    const jelly = app.store.agents()[0]!;
    app.service.emit(jelly.id, null, "message", {
      role: "assistant",
      text: "Waiting to be read",
    });
    render(<App />);
    const row = await screen.findByTitle("Jelly · idle");
    await waitFor(() =>
      expect(
        within(row).getByRole("img", { name: "Unread messages" }),
      ).toBeDefined(),
    );
    fireEvent.click(row);
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "Unread messages" })).toBeNull(),
    );
    act(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new window.Event("visibilitychange"));
    });
    app.service.emit(jelly.id, null, "message", {
      role: "assistant",
      text: "While hidden",
    });
    await waitFor(() =>
      expect(row.querySelector(".agent-indicator.unread")).not.toBeNull(),
    );
    act(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new window.Event("visibilitychange"));
    });
    await waitFor(() =>
      expect(row.querySelector(".agent-indicator")).toBeNull(),
    );
  } finally {
    cleanup();
    window.matchMedia = originalMatchMedia;
    if (originalVisibility)
      Object.defineProperty(document, "visibilityState", originalVisibility);
    else delete (document as any).visibilityState;
  }
});

test("settings cancellation protects unsaved choices and never persists discarded changes", async () => {
  const app = await setup();
  render(<App />);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Connection and appearance" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Connection and appearance" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("radio", { name: "GPT-6 Sol" }));
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("alertdialog", { name: "Discard changes?" }),
  ).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole("button", { name: "Model" }).textContent).toContain(
    "GPT-6 Sol",
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  await waitFor(() => expect(!!screen.queryByRole("dialog")).toBe(false));
  expect(app.service.snapshot().config.selectedModel).toBe("gpt-6-astra");
});

test("agent details uses one sheet for workspace and profile, guarding profile edits", async () => {
  const app = await setup();
  render(<App />);
  await screen.findByRole("button", { name: "Jelly details" });
  fireEvent.click(screen.getByRole("button", { name: "Jelly details" }));
  const original = screen.getByRole("dialog", { name: "Jelly" });
  expect(original.getAttribute("data-detent")).toBe("medium");
  expect(original.querySelector(".directory-path")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand sheet" }));
  expect(original.getAttribute("data-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
  expect(screen.getByRole("dialog", { name: "Workspace" })).toBe(original);
  expect(screen.getByText(app.store.agents()[0]!.cwd)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit agent profile" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Edit agent profile" }));
  expect(screen.getByRole("dialog", { name: "Agent profile" })).toBe(original);
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Unsaved name" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
    "Unsaved name",
  );
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByRole("dialog", { name: "Jelly" })).toBe(original);
  expect(app.store.agents()[0]!.name).toBe("Jelly");
});

test("inbox previews are bounded assistant replies and message chrome omits names and times", async () => {
  const app = await setup();
  const agent = app.store.agents()[0]!;
  app.service.emit(agent.id, null, "message", {
    role: "assistant",
    text: "Earlier reply",
  });
  const last = app.service.emit(agent.id, null, "message", {
    role: "assistant",
    text: "Latest reply ".repeat(50),
  });
  app.service.emit(agent.id, null, "message", {
    role: "user",
    text: "A user message",
  });
  app.service.emit(agent.id, null, "message", {
    role: "assistant",
    text: "  ",
  });
  expect(app.service.snapshot().agentPreviews?.[agent.id]).toEqual({
    text: "Latest reply ".repeat(50).slice(0, 220),
    createdAt: last.createdAt,
  });
  render(<App />);
  const row = await screen.findByTitle("Jelly · idle");
  expect(row.querySelector(".agent-preview")?.textContent).toContain(
    "Latest reply",
  );
  expect(row.querySelector("time")?.getAttribute("datetime")).toBe(
    last.createdAt,
  );
  await screen.findByText("A user message");
  expect(document.querySelector(".timeline .message-author")).toBeNull();
  expect(document.querySelector(".timeline time")).toBeNull();
  expect(
    document.querySelectorAll(".timeline .from-agent .bubble"),
  ).toHaveLength(3);
});

test("mobile back swipe can cancel or complete without using Safari's extreme edge", async () => {
  const { useChatNavigation } = await import("../src/client/useChatNavigation");
  const { useRef } = await import("react");
  let wentBack = 0;
  function Fixture() {
    const root = useRef<HTMLDivElement>(null);
    useChatNavigation(root, true, false, () => {
      wentBack++;
    });
    return (
      <div ref={root} data-testid="swipe">
        <div>Conversation</div>
      </div>
    );
  }
  render(<Fixture />);
  const root = screen.getByTestId("swipe");
  Object.defineProperty(root, "clientWidth", {
    configurable: true,
    value: 393,
  });
  fireEvent.touchStart(root, { touches: [{ clientX: 40, clientY: 300 }] });
  fireEvent.touchMove(root, { touches: [{ clientX: 180, clientY: 305 }] });
  expect(root.dataset.swiping).toBe("true");
  fireEvent.touchCancel(root);
  expect(root.dataset.swiping).toBeUndefined();
  expect(wentBack).toBe(0);
  fireEvent.touchStart(root, { touches: [{ clientX: 4, clientY: 300 }] });
  fireEvent.touchMove(root, { touches: [{ clientX: 210, clientY: 305 }] });
  fireEvent.touchEnd(root);
  expect(wentBack).toBe(0);
  fireEvent.touchStart(root, { touches: [{ clientX: 40, clientY: 300 }] });
  fireEvent.touchMove(root, { touches: [{ clientX: 220, clientY: 305 }] });
  fireEvent.touchEnd(root);
  expect(wentBack).toBe(1);
  expect(root.style.getPropertyValue("--back-progress")).toBe("");
});

test("touch focus stays quiet while keyboard navigation retains focus indicators", async () => {
  const { useInputModality } = await import("../src/client/useInputModality");
  const { useRef } = await import("react");
  function Fixture() {
    const root = useRef<HTMLDivElement>(null);
    useInputModality(root);
    return <div ref={root} data-testid="modality"><button>Back</button></div>;
  }
  const ui = render(<Fixture />);
  const root = screen.getByTestId("modality");
  expect(root.dataset.inputModality).toBe("pointer");
  act(() => screen.getByRole("button", { name: "Back" }).focus());
  expect(root.dataset.inputModality).toBe("pointer");
  fireEvent.keyDown(document, { key: "Tab" });
  expect(root.dataset.inputModality).toBe("keyboard");
  fireEvent.pointerDown(screen.getByRole("button", { name: "Back" }), { pointerType: "touch" });
  expect(root.dataset.inputModality).toBe("pointer");
  fireEvent.keyDown(document, { key: "a" });
  expect(root.dataset.inputModality).toBe("pointer");
  fireEvent.keyDown(document, { key: "ArrowDown" });
  expect(root.dataset.inputModality).toBe("keyboard");
  ui.unmount();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(root.dataset.inputModality).toBeUndefined();
});

test("new agent has one Cancel action, without a duplicate close button", async () => {
  await setup();
  render(<App />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Create agent" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
  const form = screen.getByRole("dialog", { name: "Create an agent" });
  expect(within(form).getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
  expect(within(form).queryByRole("button", { name: "Close dialog" })).toBeNull();
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Unsaved agent" } });
  fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("alertdialog", { name: "Discard changes?" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  await waitFor(() => expect(!!screen.queryByRole("dialog")).toBe(false));
});

test("assistant copy control is revealed on touch and can be hidden again", async () => {
  const app = await setup();
  app.service.emit(app.store.agents()[0]!.id, null, "message", { role: "assistant", text: "A compact assistant reply." });
  render(<App />);
  const reply = await screen.findByRole("article", { name: "Assistant reply" });
  const bubble = reply.querySelector(".bubble")!;
  expect(reply.classList.contains("copy-visible")).toBe(false);
  fireEvent.pointerDown(bubble, { pointerType: "touch" });
  expect(reply.classList.contains("copy-visible")).toBe(true);
  expect(within(reply).getByRole("button", { name: "Copy response" })).toBeDefined();
  fireEvent.pointerDown(bubble, { pointerType: "touch" });
  expect(reply.classList.contains("copy-visible")).toBe(false);
});

test("generated images render outside collapsed tool groups and survive remount", async () => {
  const app = await setup();
  const agent = app.store.agents()[0]!;
  const images = [{ id: "01234567-1234-1234-1234-0123456789ab", url: "/api/images/01234567-1234-1234-1234-0123456789ab.png", mimeType: "image/png", alt: "A friendly crab" }];
  app.store.event(agent.id, null, "message", { role: "user", text: "Draw a crab" });
  app.store.event(agent.id, null, "tool_started", { toolCallId: "image-1", name: "generate_image", args: { prompt: "A friendly crab" } });
  app.store.event(agent.id, null, "image_generated", { images });
  app.store.event(agent.id, null, "tool_completed", { toolCallId: "image-1", name: "generate_image", result: { images } });
  let ui = render(<App />);
  let image = await screen.findByRole("img", { name: "A friendly crab" });
  expect(image.getAttribute("src")).toBe(images[0]!.url);
  expect(image.closest("details")).toBeNull();
  expect(screen.getByRole("link", { name: "Download image" }).getAttribute("href")).toBe(images[0]!.url);
  fireEvent.error(image);
  expect(screen.getByRole("alert").textContent).toContain("Could not load the image");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("img", { name: "A friendly crab" });
  ui.unmount();
  ui = render(<App />);
  image = await screen.findByRole("img", { name: "A friendly crab" });
  expect(image.closest("details")).toBeNull();
});

test("message image embedding accepts only local generated PNG URLs", async () => {
  await setup();
  const { MessageText } = await import("../src/client/MessageText");
  const url = "/api/images/01234567-1234-1234-1234-0123456789ab.png";
  render(<MessageText text={`A picture:\n![Crab](${url})\n\n![Tracking](https://evil.example/pixel.png)\n![Script](data:image/svg+xml,bad)\n![Escape](/api/images/../../auth.json)\n\n\`\`\`md\n![Not an image](${url})\n\`\`\``} />);
  await screen.findByRole("img", { name: "Crab" });
  expect(screen.getAllByRole("img")).toHaveLength(1);
  expect(screen.queryByRole("img", { name: "Tracking" })).toBeNull();
  expect(screen.queryByRole("img", { name: "Not an image" })).toBeNull();
});

test("copy icon copies the reply and displays accessible success and failure feedback", async () => {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const exec = Object.getOwnPropertyDescriptor(document, "execCommand");
  const copied: string[] = [];
  let fail = false;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: async (text: string) => {
      if (fail) throw new Error("Clipboard denied");
      copied.push(text);
    },
  } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
  try {
    const app = await setup();
    app.service.emit(app.store.agents()[0]!.id, null, "message", { role: "assistant", text: "Copy this reply." });
    render(<App />);
    const reply = await screen.findByRole("article", { name: "Assistant reply" });
    const button = within(reply).getByRole("button", { name: "Copy response" });
    expect(button.querySelector("svg.lucide-copy")?.getAttribute("width")).toBe("16");
    expect(button.textContent).toBe("");
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("title")).toBe("Copied"));
    expect(copied).toEqual(["Copy this reply."]);
    expect(button.querySelector("svg.lucide-check")).not.toBeNull();
    expect(within(button).getByRole("status").textContent).toBe("Copied");
    fail = true;
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("title")).toBe("Copy unavailable"));
    expect(button.querySelector("svg.lucide-circle-alert, svg.lucide-alert-circle")).not.toBeNull();
    expect(within(button).getByRole("status").textContent).toBe("Copy unavailable");
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else delete (navigator as any).clipboard;
    if (exec) Object.defineProperty(document, "execCommand", exec);
    else delete (document as any).execCommand;
  }
});

test("work disclosure shows thinking before tools, keeps results collapsed, and survives completion", async () => {
  const { WorkActivity } = await import("../src/client/WorkActivity");
  const app = await setup();
  const agent = app.store.agents()[0]!;
  const run = { ...app.store.createRun(agent.id, "work-ui", "Inspect layout", "api", "model"), startedAt: "2026-01-01T12:00:00Z" };
  const event = (id: number, type: string, data: Record<string, unknown> = {}) => ({ id, type, data, runId: run.id, agentId: agent.id, createdAt: run.startedAt });
  const events = [
    event(1, "run_started"),
    event(2, "tool_started", { name: "read", toolCallId: "read", args: { path: "README.md" } }),
    event(3, "tool_completed", { name: "read", toolCallId: "read", result: "Raw tool output" }),
    event(4, "thinking", { text: "Inspect the layout before making a change." }),
  ];
  const props = { agent, run, events, stopping: false, renderEvent: () => null };
  const ui = render(<WorkActivity {...props} />);
  const work = document.querySelector<HTMLDetailsElement>(".work-activity")!;
  expect(work.open).toBe(false);
  expect(screen.getByText(`${agent.name} is Working`).classList.contains("work-status-sheen")).toBe(true);
  expect(work.hasAttribute("open")).toBe(false);
  fireEvent.click(work.querySelector("summary")!);
  await waitFor(() => expect(work.open).toBe(true));
  const thinking = screen.getByRole("region", { name: "Thinking" });
  expect(within(thinking).getByText("Inspect the layout before making a change.")).toBeDefined();
  expect(work.querySelector(".work-activity-items")!.firstElementChild).toBe(thinking);
  expect(screen.queryByText(/Raw tool output/)).toBeNull();
  const tool = work.querySelector<HTMLDetailsElement>(".work-step")!;
  expect(tool.open).toBe(false);
  ui.rerender(<WorkActivity {...props} run={{ ...run, status: "completed", endedAt: "2026-01-01T12:00:30Z" }} />);
  expect(screen.getByText("Worked for 30s").classList.contains("work-status-sheen")).toBe(false);
  expect(work.open).toBe(true);
  expect(tool.open).toBe(false);
  fireEvent.click(tool.querySelector("summary")!);
  await waitFor(() => expect(!!screen.queryByText(/Raw tool output/)).toBe(true));
  expect(screen.getByText("Input")).toBeDefined();
  expect(screen.getByText("Result")).toBeDefined();
  ui.rerender(<WorkActivity {...props} agent={{ ...agent, status: "waiting" }} />);
  expect(screen.getByText(`${agent.name} is Waiting for you`).classList.contains("work-status-sheen")).toBe(false);
  ui.rerender(<WorkActivity {...props} stopping />);
  expect(screen.getByText(`${agent.name} is Stopping`).classList.contains("work-status-sheen")).toBe(false);
});

test("conversation groups each run once without hiding messages, images or errors", async () => {
  const { conversationActivity, workDuration } = await import("../src/client/conversationActivity");
  const app = await setup();
  const agent = app.store.agents()[0]!;
  const run = app.store.createRun(agent.id, "group-work", "One task", "api", "model");
  const second = { ...run, id: "second", status: "completed" as const };
  const event = (id: number, type: string, data: Record<string, unknown> = {}, runId: string | null = run.id) => ({ id, type, data, runId, agentId: agent.id, createdAt: run.startedAt });
  const events = [event(1, "message", { role: "user" }), event(2, "run_started"),
    event(3, "thinking", { text: "First check" }), event(4, "tool_started", { toolCallId: "same" }),
    event(5, "message", { role: "assistant" }), event(6, "tool_completed", { toolCallId: "same" }),
    event(7, "message", { role: "user", mode: "steer" }), event(8, "tool_started", { toolCallId: "other" }),
    event(9, "image_generated"), event(10, "run_completed"),
    event(11, "message", { role: "user" }, second.id), event(12, "tool_completed", { toolCallId: "same" }, second.id),
    event(13, "run_failed", { error: "Visible failure" }, second.id)];
  const entries = conversationActivity(events, [run, second]);
  expect(entries.map((entry) => entry.key)).toEqual(["event:1", `run:${run.id}`, "event:5", "event:7", "event:9", "event:11", "run:second", "event:13"]);
  const work = entries.filter((entry) => entry.kind === "work");
  expect(work).toHaveLength(2);
  expect(work[0]!.events.map((event) => event.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(work[1]!.events.map((event) => event.id)).toEqual([11, 12, 13]);
  expect(conversationActivity([], [run, second]).map((entry) => entry.key)).toEqual([`run:${run.id}`]);
  expect(conversationActivity([], [run], false)).toEqual([]);
  expect(conversationActivity([events[11]!], [second], false).map((entry) => entry.key)).toEqual(["run:second"]);
  expect(workDuration("2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z")).toBe("30s");
  expect(workDuration("2026-01-01T00:00:00Z", "2026-01-01T00:01:30Z")).toBe("1m 30s");
  expect(workDuration("2026-01-01T00:00:00Z", "2026-01-01T01:02:00Z")).toBe("1h 2m");
  expect(workDuration("invalid", "invalid")).toBeNull();
  expect(workDuration("2026-01-01T00:00:00Z", null)).toBeNull();
});

test("Fresh Session menu action preserves chat and shows a durable session boundary", async () => {
  const app = await setup();
  const hasAuth = app.service.harness.auth.hasAuth.bind(app.service.harness.auth);
  app.service.harness.auth.hasAuth = () => false;
  const id = app.store.agents()[0]!.id;
  app.store.event(id, null, "message", { role: "assistant", text: "An earlier reply stays visible." });
  let ui = render(<App />);
  await within(screen.getByRole("main")).findByText("An earlier reply stays visible.");
  fireEvent.click(screen.getByRole("button", { name: "Agent options" }));
  expect(screen.getByRole("button", { name: "Fresh Session" }).hasAttribute("disabled")).toBe(true);
  await app.service.harness.auth.setRuntimeApiKey("openai", "local-test-key");
  app.service.harness.auth.hasAuth = hasAuth;
  app.service.setMode("api");
  await waitFor(() => expect(screen.getByRole("button", { name: "Fresh Session" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Fresh Session" }));
  await screen.findByText(/Fresh session started · existing context carried forward/);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(within(screen.getByRole("main")).getByText("An earlier reply stays visible.")).toBeDefined();
  expect(app.store.context(id)![0]!.type).toBe("session");
  expect(app.store.runs(id)).toHaveLength(1);
  ui.unmount();
  ui = render(<App />);
  await screen.findByText(/Fresh session started · existing context carried forward/);
  expect(within(screen.getByRole("main")).getByText("An earlier reply stays visible.")).toBeDefined();
  app.store.setStatus(id, "running");
  app.service.emit(id, null, "agent_updated", { agent: app.store.agent(id) });
  fireEvent.click(screen.getByRole("button", { name: "Agent options" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Fresh Session" }).hasAttribute("disabled")).toBe(true));
});

test("read-tool image attachments render outside work disclosures live and after remount", async () => {
  const app = await setup();
  const agent = app.store.agents()[0]!;
  const run = app.store.createRun(agent.id, crypto.randomUUID(), "Show ad", "demo", "local-demo");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7L8AAAAASUVORK5CYII=";
  app.store.event(agent.id, run.id, "message", { role: "user", text: "Show the ad image" });
  app.store.event(agent.id, run.id, "tool_started", { name: "read", toolCallId: "ad-read", args: { path: "ad.png" } });
  let ui = render(<App />);
  await screen.findByText("Show the ad image");
  const event = app.service.emit(agent.id, run.id, "tool_completed", { name: "read", toolCallId: "ad-read", result: { content: [{ type: "image", mimeType: "image/png", data: png }] } });
  const image = await screen.findByRole("img", { name: "Image from read" });
  expect(image.getAttribute("src")).toBe(`/api/tool-images/${event.id}/0`);
  expect(image.closest("details")).toBeNull();
  expect(document.body.textContent).not.toContain(png);
  const response = await fetch(`/api/tool-images/${event.id}/0`);
  expect(response.status).toBe(200);
  ui.unmount();
  ui = render(<App />);
  expect((await screen.findByRole("img", { name: "Image from read" })).closest("details")).toBeNull();
  expect(screen.getAllByRole("img", { name: "Image from read" })).toHaveLength(1);
});

test("render_file displays images and expandable inert text with download and history", async () => {
  const app = await setup();
  const agent = app.store.agents()[0]!;
  const source = join(dir!, "preview.html");
  writeFileSync(source, '<script>window.stolen=true</script>\n' + "hello from the file\n".repeat(220));
  const textFile = await app.service.harness.files.save(source, dir!);
  const imageSource = join(dir!, "cafe.png");
  writeFileSync(imageSource, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7L8AAAAASUVORK5CYII=", "base64"));
  const imageFile = await app.service.harness.files.save(imageSource, dir!);
  app.store.event(agent.id, null, "message", { role: "user", text: "Show these files" });
  app.store.event(agent.id, null, "file_rendered", { files: [textFile, imageFile] });
  let ui = render(<App />);
  await screen.findByRole("img", { name: "cafe.png" });
  const file = screen.getByRole("region", { name: "File: preview.html" });
  expect(file.textContent).not.toContain("hello from the file");
  const details = file.querySelector("details")!;
  await act(async () => { details.open = true; fireEvent(details, new window.Event("toggle")); });
  await waitFor(() => expect(file.querySelector("pre")?.textContent).toContain("hello from the file"));
  expect(file.querySelector("pre")!.textContent).toContain("<script>window.stolen=true</script>");
  expect(file.querySelector("script")).toBeNull();
  expect(file.textContent).toContain("Preview shortened");
  expect(within(file).getByRole("link", { name: "Download file" }).getAttribute("href")).toBe(textFile.url);
  expect(screen.getByRole("img", { name: "cafe.png" }).closest("details")).toBeNull();
  ui.unmount();
  ui = render(<App />);
  await screen.findByRole("img", { name: "cafe.png" });
  expect(screen.getByRole("region", { name: "File: preview.html" }).textContent).not.toContain("hello from the file");
});

test("active work stays after mid-turn replies, steering and attachments, then returns to history on settlement", async () => {
  const { conversationActivity, workState } = await import("../src/client/conversationActivity");
  const app = await setup();
  const agent = app.store.agents()[0]!;
  const run = app.store.createRun(agent.id, "tail-work", "Keep working", "api", "model");
  const event = (id: number, type: string, data: Record<string, unknown> = {}) => ({ id, type, data, runId: run.id, agentId: agent.id, createdAt: run.startedAt });
  const events = [
    event(1, "message", { role: "user", text: "Start" }),
    event(2, "run_started"),
    event(3, "message", { role: "assistant", text: "First update" }),
    event(4, "tool_started", { name: "read", toolCallId: "read" }),
    event(5, "message", { role: "user", mode: "steer", text: "Also check mobile" }),
    event(6, "message", { role: "assistant", text: "Second update" }),
    event(7, "image_generated"),
    event(8, "file_rendered"),
    event(9, "tool_completed", { name: "read", toolCallId: "read", result: { content: [{ type: "image", mimeType: "image/png", data: "fixture-image" }] } }),
  ];
  const expected = ["event:1", "event:3", "event:5", "event:6", "event:7", "event:8", "event:9", `run:${run.id}`];
  expect(conversationActivity(events, [run]).map((entry) => entry.key)).toEqual(expected);
  // A loaded slice of the active run still has the row at the bottom.
  expect(conversationActivity(events, [run], false).map((entry) => entry.key)).toEqual(expected);
  // A run_started event works even when run metadata hasn't arrived yet.
  expect(conversationActivity(events, []).map((entry) => entry.key)).toEqual(expected);
  expect(conversationActivity([], [run], false)).toEqual([]);
  for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
    const settled = [...events, event(10, `run_${status}`)];
    expect(workState(settled, run).active).toBe(false);
    const entries = conversationActivity(settled, [run]);
    expect(entries[1]!.key).toBe(`run:${run.id}`);
    expect(entries.filter((entry) => entry.kind === "work")).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === "event" && entry.event.type === "message").map((entry) => entry.key))
      .toEqual(["event:1", "event:3", "event:5", "event:6"]);
  }
});

function mockConversationLayout() {
  const chat = screen.getByLabelText("Conversation") as HTMLDivElement;
  Object.defineProperty(chat, "clientHeight", { configurable: true, value: 400 });
  Object.defineProperty(chat, "scrollHeight", { configurable: true,
    get: () => chat.querySelectorAll("[data-activity-key]").length * 40 + 100,
  });
  chat.scrollTo = ((options: ScrollToOptions) => {
    chat.scrollTop = Math.max(0, Math.min(options.top ?? 0, chat.scrollHeight - chat.clientHeight));
  }) as typeof chat.scrollTo;
  chat.scrollTop = chat.scrollHeight - chat.clientHeight;
  fireEvent.scroll(chat);
  return chat;
}

test("scrolling up prepends old messages once, preserves position and keeps the live tail with a circular jump button", async () => {
  const app = await setup();
  const id = app.store.agents()[0]!.id;
  for (let i = 1; i <= 240; i++) app.store.event(id, null, "message", { role: "user", text: `History line ${i}` });
  render(<App />);
  await screen.findByText("History line 240");
  await waitFor(() => expect(screen.getByText("Ready")).toBeDefined());
  expect(screen.queryByText("History line 140")).toBeNull();
  const chat = mockConversationLayout();
  expect(screen.queryByRole("button", { name: "Jump to bottom" })).toBeNull();
  const fetchBefore = globalThis.fetch;
  let requests = 0, release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = (async (input: any, init: any) => {
    const response = await fetchBefore(input, init);
    if (typeof input === "string" && input.includes(`/agents/${id}/history?`)) { requests++; await gate; }
    return response;
  }) as typeof fetch;
  chat.scrollTop = 80;
  fireEvent.scroll(chat);
  const jump = screen.getByRole("button", { name: "Jump to bottom" });
  expect(jump.querySelector("svg.lucide-arrow-down")).not.toBeNull();
  expect(jump.textContent).toBe("");
  await waitFor(() => expect(requests).toBe(1));
  chat.scrollTop = 60; fireEvent.scroll(chat);
  chat.scrollTop = 40; fireEvent.scroll(chat);
  expect(requests).toBe(1);
  release();
  await screen.findByText("History line 41");
  expect(screen.getByText("History line 240")).toBeDefined();
  expect(screen.getAllByText("History line 141")).toHaveLength(1);
  expect(chat.scrollTop).toBe(4040);
  app.service.emit(id, null, "message", { role: "assistant", text: "New live reply while reading history" });
  await within(chat).findByText("New live reply while reading history");
  expect(chat.scrollTop).toBe(4040);
  expect(screen.getByText("History line 41")).toBeDefined();
  // A second upward visit loads the final page and exhausts the cursor.
  chat.scrollTop = 50; fireEvent.scroll(chat);
  await screen.findByText("History line 1");
  expect(screen.queryByRole("button", { name: "Load older messages" })).toBeNull();
  expect(requests).toBe(2);
  fireEvent.click(screen.getByRole("button", { name: "Jump to bottom" }));
  expect(chat.scrollTop).toBe(chat.scrollHeight - chat.clientHeight);
  expect(screen.queryByRole("button", { name: "Jump to bottom" })).toBeNull();
  expect(screen.getByText("History line 1")).toBeDefined();
  // Further replies follow the bottom after jumping, without dropping loaded pages.
  app.service.emit(id, null, "message", { role: "user", text: "Next live message" });
  await screen.findByText("Next live message");
  expect(chat.scrollTop).toBe(chat.scrollHeight - chat.clientHeight);
});

test("history failures are retryable and late pagination cannot leak across agent switches", async () => {
  const app = await setup();
  const id = app.store.agents()[0]!.id;
  const other = app.service.createAgent({ name: "Pearl", instructions: "", color: "#a4c8e8" });
  for (let i = 1; i <= 120; i++) app.store.event(id, null, "message", { role: "user", text: `Jelly history ${i}` });
  app.store.event(other.id, null, "message", { role: "user", text: "Pearl only" });
  render(<App />); await screen.findByText("Jelly history 120");
  await waitFor(() => expect(screen.getByText("Ready")).toBeDefined());
  const chat = mockConversationLayout();
  const fetchBefore = globalThis.fetch;
  let fail = true, requests = 0, release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = (async (input: any, init: any) => {
    if (typeof input === "string" && input.includes(`/agents/${id}/history?`)) {
      requests++;
      if (fail) return new Response(JSON.stringify({ error: "Fixture offline" }), { status: 503 });
      const response = await fetchBefore(input, init); await gate; return response;
    }
    return fetchBefore(input, init);
  }) as typeof fetch;
  chat.scrollTop = 100; fireEvent.scroll(chat);
  await screen.findByRole("button", { name: "Retry loading older messages" });
  chat.scrollTop = 80; fireEvent.scroll(chat);
  expect(requests).toBe(1); // no retry storm from scroll events
  expect(screen.getByText("Jelly history 120")).toBeDefined();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry loading older messages" }));
  await waitFor(() => expect(requests).toBe(2));
  fireEvent.click(screen.getByTitle("Pearl · idle"));
  await screen.findByText("Pearl only");
  release(); await act(async () => { await new Promise(r => setTimeout(r, 40)); });
  expect(screen.queryByText("Jelly history 1")).toBeNull();
  expect(screen.getByText("Pearl only")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Jump to bottom" })).toBeNull();
  fireEvent.click(screen.getByTitle("Jelly · idle"));
  await screen.findByText("Jelly history 120");
  expect(screen.queryByText("Jelly history 1")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
  await screen.findByText("Jelly history 1");
});

test("history prepend anchors to the visible event rather than appended live content", async () => {
  const { captureAnchor, restoreAnchor } = await import("../src/client/history");
  const chat = document.createElement("div");
  const row = document.createElement("div"); row.dataset.activityKey = "event:123"; chat.append(row);
  chat.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
  let offset = 20;
  row.getBoundingClientRect = () => ({ top: 100 + offset, bottom: 200 + offset }) as DOMRect;
  Object.defineProperty(chat, "scrollHeight", { configurable: true, value: 1000 });
  chat.scrollTop = 500;
  const anchor = captureAnchor(chat);
  Object.defineProperty(chat, "scrollHeight", { value: 1500 }); // +300 prepended, +200 live tail
  offset += 300;
  chat.scrollTo = ((options: ScrollToOptions) => { chat.scrollTop = options.top!; }) as typeof chat.scrollTo;
  restoreAnchor(chat, anchor);
  expect(chat.scrollTop).toBe(800); // not 1000: newly appended messages don't move the reading position
});

test("agent inbox shows animated working indicators and live previews for an unselected agent", async () => {
  const app = await setup();
  const worker = app.service.createAgent({ name: "Active worker", instructions: "Test", color: "#abc" });
  const run = app.store.createRun(worker.id, "inbox-activity", "Work", "api", "model");
  app.service.emit(worker.id, run.id, "message", { role: "assistant", text: "Previous reply stays available." });
  app.store.setStatus(worker.id, "running");
  render(<App />);
  const row = await screen.findByTitle("Active worker · running");
  expect(within(row).getByText("Working").classList.contains("work-status-sheen")).toBe(true);
  expect(!!row.querySelector(".agent-avatar.is-working")).toBe(true);
  expect(!!row.querySelector("time")).toBe(false);
  expect(within(row).getByText("Thinking…")).toBeDefined();
  expect(within(row).getByRole("img", { name: "Unread messages" })).toBeDefined();
  expect(row.querySelectorAll(".status-dot")).toHaveLength(1);
  app.service.emit(worker.id, run.id, "tool_started", { toolCallId: "read", name: "read", args: { path: "private-file" } });
  await within(row).findByText("Reading files…");
  app.service.emit(worker.id, run.id, "tool_completed", { toolCallId: "read", name: "read", result: "private-result" });
  await within(row).findByText("Thinking…");
  app.service.emit(worker.id, run.id, "tool_started", { toolCallId: "check", name: "bash", args: { command: "bun run check" } });
  await within(row).findByText("Running checks…");
  expect(row.textContent).not.toContain("private");
  app.store.setStatus(worker.id, "waiting");
  app.service.emit(worker.id, run.id, "turn_completed", { turn: 1 });
  await within(row).findByText("Needs you");
  expect(within(row).getByText("Waiting for your help…")).toBeDefined();
  expect(!!row.querySelector(".agent-avatar.is-waiting")).toBe(true);
  expect(!!row.querySelector(".work-status-sheen, .agent-avatar.is-working")).toBe(false);
  expect(within(row).getByRole("img", { name: "Needs attention" })).toBeDefined();
  app.store.finishRun(run.id, "completed", null);
  app.store.setStatus(worker.id, "idle");
  app.service.emit(worker.id, run.id, "run_completed", { status: "completed" });
  await within(row).findByText("Previous reply stays available.");
  expect(!!row.querySelector("time")).toBe(true);
  expect(!!row.querySelector(".agent-row-status, .is-working, .is-waiting")).toBe(false);
  expect(within(row).getByRole("img", { name: "Unread messages" })).toBeDefined();
});

test("attachment frames reserve geometry through authentication, decoding, failure and retry", async () => {
  const { GeneratedImages } = await import("../src/client/GeneratedImages");
  const app = await setup();
  const fetchBefore = globalThis.fetch;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = (async (input: any, init: any) => {
    if (input === "/api/control-session") await gate;
    return fetchBefore(input, init);
  }) as typeof fetch;
  const images = [
    { url: "/api/images/11111111-1111-1111-1111-111111111111.png", alt: "Landscape", width: 1600, height: 900 },
    { url: "/api/images/22222222-2222-2222-2222-222222222222.png", alt: "Legacy image" },
  ];
  const ui = render(<GeneratedImages images={images} />);
  const frames = [...ui.container.querySelectorAll<HTMLElement>(".image-frame")];
  const geometry = frames.map(frame => frame.style.cssText);
  expect(frames).toHaveLength(2);
  expect(parseFloat(frames[0]!.style.aspectRatio)).toBe(1600 / 900);
  expect(parseFloat(frames[1]!.style.aspectRatio)).toBe(1);
  expect(screen.getAllByText("Loading image…")).toHaveLength(2);
  release();
  const image = await screen.findByRole("img", { name: "Landscape" });
  fireEvent.load(image);
  expect(frames.map(frame => frame.style.cssText)).toEqual(geometry);
  fireEvent.error(image);
  expect(screen.getByRole("img", { name: "Legacy image" })).toBeDefined();
  expect(frames.map(frame => frame.style.cssText)).toEqual(geometry);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("img", { name: "Landscape" });
  expect(frames.map(frame => frame.style.cssText)).toEqual(geometry);
});

test("anchor restoration preserves intervening user scrolling and skips momentum-breaking no-op writes", async () => {
  const { captureAnchor, restoreAnchor } = await import("../src/client/history");
  const chat = document.createElement("div");
  const row = document.createElement("div"); row.dataset.activityKey = "event:42"; chat.append(row);
  chat.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  let contentTop = 520;
  row.getBoundingClientRect = () => ({ top: contentTop - chat.scrollTop, bottom: contentTop - chat.scrollTop + 100 }) as DOMRect;
  chat.scrollTop = 500;
  let writes = 0;
  chat.scrollTo = ((options: ScrollToOptions) => { writes++; chat.scrollTop = options.top!; }) as typeof chat.scrollTo;
  const anchor = captureAnchor(chat);
  // User scrolls before the resize observer receives the queued content change.
  chat.scrollTop = 420;
  restoreAnchor(chat, anchor);
  expect(chat.scrollTop).toBe(420);
  expect(writes).toBe(0);
  // A late decode above the reading position adds 300px; don't undo the user's 80px movement.
  contentTop += 300;
  restoreAnchor(chat, anchor);
  expect(chat.scrollTop).toBe(720);
  expect(writes).toBe(1);
  const stable = captureAnchor(chat);
  restoreAnchor(chat, stable);
  expect(writes).toBe(1);
});

test("a connection is required to send, Settings has no demo option, and connecting preserves the draft", async () => {
  const app = await setup();
  app.service.harness.auth.hasAuth = () => false;
  app.service.setMode("auto");
  render(<App />);
  const input = await screen.findByRole("textbox", { name: "Message Jelly" });
  await screen.findByRole("button", { name: "Connect an account" });
  fireEvent.change(input, { target: { value: "Keep this draft until I connect" } });
  const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(app.store.runs(app.store.agents()[0]!.id)).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Connect an account" }));
  fireEvent.click(screen.getByRole("button", { name: "Model access" }));
  expect(screen.getAllByRole("radio")).toHaveLength(3);
  expect(screen.queryByRole("radio", { name: /demo/i })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(!!screen.queryByRole("dialog")).toBe(false));
  await act(async () => {
    app.service.harness.auth.hasAuth = (provider) => provider === "openai";
    app.service.setMode("api");
  });
  await waitFor(() => expect(send.disabled).toBe(false));
  expect(screen.queryByRole("button", { name: "Connect an account" })).toBeNull();
  expect((input as HTMLTextAreaElement).value).toBe("Keep this draft until I connect");
  await act(async () => {
    app.service.harness.auth.hasAuth = () => false;
    app.service.setMode("auto");
  });
  await waitFor(() => expect(send.disabled).toBe(true));
  expect((input as HTMLTextAreaElement).value).toBe("Keep this draft until I connect");
});

test("modal closing keeps its animation timing when system Reduce Motion is enabled", async () => {
  const { Modal } = await import("../src/client/Modal");
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion: reduce"), media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent() { return true; }, onchange: null,
  })) as typeof window.matchMedia;
  try {
    let closed = 0;
    render(<Modal title="Animated close" onClose={() => { closed++; }}>Keep the closing transition.</Modal>);
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
    expect(closed).toBe(0);
    await waitFor(() => expect(closed).toBe(1));
  } finally {
    window.matchMedia = original;
  }
});

for (const chatgptReady of [true, false]) {
  test(`legacy backend connection status keeps chat ${chatgptReady ? "enabled" : "disabled"}`, async () => {
    const app = await setup();
    app.service.harness.auth.hasAuth = (provider) => provider === "openai-codex" && chatgptReady;
    app.service.setMode("chatgpt");
    const fetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
      const response = await fetch(input, init);
      if (typeof input === "string" && input.startsWith("/api/state")) {
        const state = await response.json();
        delete state.config.ready;
        return Response.json(state);
      }
      return response;
    }) as typeof globalThis.fetch;
    render(<App />);
    const input = await screen.findByRole("textbox", { name: "Message Jelly" });
    await waitFor(() => expect((screen.getByRole("button", { name: "Create agent" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(input, { target: { value: "My subscription is connected" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(!chatgptReady));
    expect(!!screen.queryByRole("button", { name: "Connect an account" })).toBe(!chatgptReady);
  });
}

test("chat profile avatar shows a working ring only for the selected running agent", async () => {
  const app = await setup();
  const id = app.store.agents()[0]!.id;
  app.store.setStatus(id, "running");
  const other = app.service.createAgent({ name: "Pearl", instructions: "", color: "#a4c8e8" });
  render(<App />);
  const pill = await screen.findByRole("button", { name: "Jelly details" });
  const ring = () => pill.querySelector(".agent-avatar.is-working");
  expect(ring()).not.toBeNull();
  expect(ring()!.getAttribute("aria-hidden")).toBe("true");
  expect(ring()!.querySelector("img")!.getAttribute("src")).toContain("-working.png");
  for (const status of ["waiting", "idle", "error", "running"] as const) {
    app.store.setStatus(id, status);
    app.service.emit(id, null, "agent_updated", { agent: app.store.agent(id) });
    await screen.findByTitle(`Jelly · ${status}`);
    expect(!!ring()).toBe(status === "running");
  }
  fireEvent.click(screen.getByTitle("Pearl · idle"));
  const idlePill = await screen.findByRole("button", { name: "Pearl details" });
  expect(idlePill.querySelector(".agent-avatar.is-working")).toBeNull();
  expect(app.store.agent(other.id)!.status).toBe("idle");
  fireEvent.click(screen.getByTitle("Jelly · running"));
  const workingPill = await screen.findByRole("button", { name: "Jelly details" });
  expect(workingPill.querySelector(".agent-avatar.is-working")).not.toBeNull();
  fireEvent.click(workingPill);
  expect(screen.getByRole("dialog", { name: "Jelly" })).toBeDefined();
});

test("in-chat forms use the shared iOS card with reviewable commands and accessible private fields", async () => {
  const { InterventionCard } = await import("../src/client/InterventionCard");
  const composer = document.createElement("input");
  document.body.append(composer); composer.focus();
  const command = "printf '%s\\n' 'fixture only'\n".repeat(30);
  try {
    render(<InterventionCard item={{
      id: "card-layout", agentId: "agent", runId: "run", kind: "sudo", status: "pending",
      payload: { executable: "/usr/bin/bash", args: ["-c", command], cwd: "/tmp/fixture", reason: "Review a fixture command before approving." },
      result: null, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(),
    }} onComputer={() => {}} onChange={() => {}} />);
    const card = screen.getByRole("region", { name: "Sudo authentication" });
    expect(card.classList.contains("chat-form-card")).toBe(true);
    expect(within(card).getByRole("heading", { name: "Administrator password required" })).toBeDefined();
    expect(within(card).getByText("Needs your approval")).toBeDefined();
    expect(document.activeElement === composer).toBe(true);
    expect(!!screen.queryByRole("dialog")).toBe(false);
    const details = card.querySelector<HTMLDetailsElement>(".chat-form-details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toContain("/usr/bin/bash");
    fireEvent.click(within(card).getByText("Review command"));
    expect(details.open).toBe(true);
    expect(details.querySelector("pre")!.textContent).toBe(["/usr/bin/bash", "-c", command].map(value => JSON.stringify(value)).join(" "));
    expect(within(details).getByText("/tmp/fixture")).toBeDefined();
    const input = within(card).getByLabelText("Sudo password") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    expect(document.getElementById(input.getAttribute("aria-describedby")!)!.textContent).toContain("Never sent to the agent or saved by Jelly.");
    expect([...card.querySelectorAll(".chat-form-actions button")].map(button => button.textContent)).toEqual(["Deny", "Authenticate and run"]);
  } finally { composer.remove(); }
});

test("browser sign-in and future inline forms share the standard card shell", async () => {
  const { InterventionCard } = await import("../src/client/InterventionCard");
  const { ChatFormCard, ChatFormActions } = await import("../src/client/ChatFormCard");
  render(<>
    <InterventionCard item={{
      id: "browser-card", agentId: "agent", runId: "run", kind: "browser_login", status: "pending",
      payload: { url: "https://example.com/sign-in", reason: "Sign in to continue." },
      result: null, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(),
    }} onComputer={() => {}} onChange={() => {}} />
    <ChatFormCard title="Another inline form" icon={<span />} description="A shared form pattern." error="Try again.">
      <ChatFormActions><button type="button">Continue</button></ChatFormActions>
    </ChatFormCard>
  </>);
  const browser = screen.getByRole("region", { name: "Browser login" });
  expect(browser.classList.contains("chat-form-card")).toBe(true);
  expect(within(browser).getByText("Private sign-in")).toBeDefined();
  expect(within(browser).getByText("https://example.com/sign-in")).toBeDefined();
  expect(within(browser).getByRole("button", { name: "Open browser" })).toBeDefined();
  const generic = screen.getByRole("region", { name: "Another inline form" });
  expect(generic.classList.contains("chat-form-card")).toBe(true);
  expect(within(generic).getByRole("alert").textContent).toBe("Try again.");
  expect(within(generic).getByText("Needs your input")).toBeDefined();
});

test("profile activity ring does not opt out for reduced-motion preferences", () => {
  const css = readFileSync(new URL("../src/client/ios.css", import.meta.url), "utf8");
  expect(css).toContain("animation: agent-working-arc 2.8s linear infinite");
  expect(css).not.toContain("prefers-reduced-motion");
});

test("Review command shows the supplied human summary while preserving exact command details", async () => {
  const { InterventionCard } = await import("../src/client/InterventionCard");
  const summary = "List database names and sizes without changing data. <script> stays plain text.";
  render(<InterventionCard item={{
    id: "command-summary", agentId: "agent", runId: "run", kind: "sudo", status: "pending",
    payload: {
      executable: "/usr/bin/printf", args: ["fixture"], cwd: "/tmp/fixture",
      summary, reason: "Check capacity before planning a backup.",
    },
    result: null, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(),
  }} onComputer={() => {}} onChange={() => {}} />);
  const card = screen.getByRole("region", { name: "Sudo authentication" });
  const details = card.querySelector<HTMLDetailsElement>(".chat-form-details")!;
  expect(details.open).toBe(false);
  expect(details.querySelector("summary")!.textContent).not.toContain(summary);
  expect(within(details.querySelector(".chat-form-detail-content") as HTMLElement).getByText(summary)).toBeDefined();
  expect(details.querySelector(".chat-form-detail-content")!.firstElementChild?.textContent).toBe(summary);
  expect(!!card.querySelector("script")).toBe(false);
  expect(within(card).getByText("Check capacity before planning a backup.")).toBeDefined();
  fireEvent.click(within(card).getByText("Review command"));
  expect(details.open).toBe(true);
  expect(details.querySelector("pre")!.textContent).toBe('"/usr/bin/printf" "fixture"');
  expect(within(details).getByText("/tmp/fixture")).toBeDefined();
});

test("remote clipboard transfers are explicit, private, and have HTTP paste/copy fallbacks", async () => {
  const { RemoteClipboard } = await import("../src/client/RemoteClipboard");
  await setup();
  const priorClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const priorExec = document.execCommand;
  const fetchBefore = globalThis.fetch;
  const requests: { operation: string; text?: string }[] = [];
  let copied = "", pasteCount = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    if (input === "/api/computer/clipboard") {
      const value = JSON.parse(init.body); requests.push(value);
      return Response.json(value.operation === "read" ? { text: "remote fixture 🦀" } : { success: true });
    }
    return fetchBefore(input, init);
  }) as typeof fetch;
  try {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      readText: async () => "local fixture 🐙", writeText: async (text: string) => { copied = text; },
    } });
    const ui = render(<RemoteClipboard paste={() => { pasteCount++; }} />);
    expect(requests).toHaveLength(0); // never automatically synchronize private data
    fireEvent.click(screen.getByRole("button", { name: "Paste to remote" }));
    await waitFor(() => expect(pasteCount).toBe(1));
    expect(requests[0]).toEqual({ operation: "write", text: "local fixture 🐙" });
    expect(document.body.textContent).not.toContain("local fixture 🐙");
    fireEvent.click(screen.getByRole("button", { name: "Copy from remote" }));
    await waitFor(() => expect(copied).toBe("remote fixture 🦀"));
    expect(requests[1]).toEqual({ operation: "read" });
    expect(document.body.textContent).not.toContain("remote fixture 🦀");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    document.execCommand = () => false;
    fireEvent.click(screen.getByRole("button", { name: "Paste to remote" }));
    const input = await screen.findByRole("textbox", { name: "Text to paste" });
    fireEvent.change(input, { target: { value: "manual private fixture" } });
    expect(requests).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    await waitFor(() => expect(pasteCount).toBe(2));
    expect(requests[2]).toEqual({ operation: "write", text: "manual private fixture" });
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy from remote" }));
    const remote = await screen.findByRole("textbox", { name: "Remote clipboard text" }) as HTMLTextAreaElement;
    expect(remote.readOnly).toBe(true);
    expect(remote.value).toBe("remote fixture 🦀");
    fireEvent.click(screen.getByRole("button", { name: "Select text" }));
    expect(remote.selectionEnd).toBe(remote.value.length);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    ui.rerender(<RemoteClipboard disabled paste={() => { pasteCount++; }} />);
    expect(screen.getByRole("button", { name: "Paste to remote" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Copy from remote" }).hasAttribute("disabled")).toBe(true);
  } finally {
    document.execCommand = priorExec;
    if (priorClipboard) Object.defineProperty(navigator, "clipboard", priorClipboard);
    else delete (navigator as any).clipboard;
  }
});

test("closing the private clipboard discards late results without pasting into the remote browser", async () => {
  const { RemoteClipboard } = await import("../src/client/RemoteClipboard");
  await setup();
  const priorClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const fetchBefore = globalThis.fetch;
  let release = () => {}, submitted = false, pasteCount = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = (async (input: any, init: any) => {
    if (input === "/api/computer/clipboard") { submitted = true; await gate; return Response.json({ success: true }); }
    return fetchBefore(input, init);
  }) as typeof fetch;
  try {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => "private fixture" } });
    const ui = render(<RemoteClipboard paste={() => { pasteCount++; }} />);
    fireEvent.click(screen.getByRole("button", { name: "Paste to remote" }));
    await waitFor(() => expect(submitted).toBe(true));
    expect(screen.getByRole("button", { name: "Copy from remote" }).hasAttribute("disabled")).toBe(true);
    ui.unmount(); release();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(pasteCount).toBe(0);
    expect(document.body.textContent).not.toContain("private fixture");
  } finally {
    release();
    if (priorClipboard) Object.defineProperty(navigator, "clipboard", priorClipboard);
    else delete (navigator as any).clipboard;
  }
});
