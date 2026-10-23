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
import { composerBudget } from "../src/client/useComposerSize";
import { placePopover } from "../src/client/useAnchoredPopover";
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
let app: Awaited<ReturnType<typeof startApp>> | undefined;
let dir: string | undefined;
afterEach(async () => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  localStorage.clear();
  window.location.href = "http://localhost/";
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
      { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...(cookie ? { cookie } : {}) } },
    );
    if (response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    return response;
  }) as typeof fetch;
  globalThis.EventSource = class extends NodeEventSource {
    constructor(url: string) {
      super(new URL(url, origin), { fetch: (input, init) => originalFetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), cookie } }) });
    }
  } as unknown as typeof EventSource;
  return app;
}
async function waitForConnectedAgent() {
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Create agent" }).hasAttribute("disabled")).toBe(false);
    expect(!!document.querySelector(".initial-agent-identity, .conversation-header .agent-identity")).toBe(true);
  });
}
test("slow HTTP loads agents and keeps controls usable with a blocked event stream", async () => {
  const a = await setup();
  globalThis.EventSource = class extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    onopen = null;
    onerror = null;
    close() {}
  } as unknown as typeof EventSource;
  const fetchApi = globalThis.fetch;
  let pending = 0;
  let peak = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    if (typeof input !== "string" || !input.startsWith("/api/state"))
      return fetchApi(input, init);
    pending++;
    peak = Math.max(peak, pending);
    try {
      await new Promise(resolve => setTimeout(resolve, 3400));
      return await fetchApi(input, init);
    } finally {
      pending--;
    }
  }) as typeof fetch;
  render(<App />);
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Create agent" }).hasAttribute("disabled")).toBe(false);
    expect(!!screen.queryByRole("textbox", { name: "Message Jelly" })).toBe(true);
  }, { timeout: 10000 });
  a.service.createAgent({ name: "Arrived via polling", instructions: "", color: "#a4c8e8" });
  await waitFor(() => {
    expect(screen.getAllByText("Arrived via polling").length).toBeGreaterThan(0);
  }, { timeout: 10000 });
  expect(peak).toBe(1);
}, 25000);

async function backToInboxRoot() {
  const back = screen.queryByRole("button", { name: "Back to all agents" });
  if (back) fireEvent.click(back);
  await screen.findByRole("navigation", { name: "Projects and agents" });
}
async function openInboxProject(name: string) {
  await backToInboxRoot();
  fireEvent.click(await screen.findByRole("button", { name: `Open project ${name}` }));
}
async function editNewAgent() {
  await screen.findByRole("textbox", { name: "Message New Agent" });
  expect(screen.queryByRole("dialog", { name: "Create an agent" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Agent options" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit agent profile" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Edit agent profile" }));
  return screen.getByRole("dialog", { name: "Agent profile" });
}
async function saveAgentProfile(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await screen.findByRole("dialog", { name });
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  await waitFor(() => expect(!!screen.queryByRole("dialog")).toBe(false));
}
test("Computer control is shared by agent options and Connected Chrome settings", async () => {
  const a = await setup();
  render(<App />);
  await waitForConnectedAgent();
  expect(screen.queryByRole("button", { name: /^Computer$/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Agent options" }));
  await screen.findByRole("button", { name: "Fresh Session" });
  expect(screen.getByRole("button", { name: "Computer control" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  fireEvent.click(screen.getByRole("button", { name: "Agent list menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
  expect(screen.queryByRole("button", { name: /Browser target|Browser controller/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Connected Chrome" }));
  expect(screen.queryByLabelText("Browser target")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Computer control" }));
  const computer = await screen.findByRole("dialog", { name: "Computer control" });
  await within(computer).findByRole("heading", { name: "Use the computer" });
  expect(a.service.chromeShare.state().status).toBe("idle");
  fireEvent.click(within(computer).getByRole("button", { name: "Close dialog" }));
  await waitFor(() => expect(!!screen.queryByRole("dialog", { name: "Computer control" })).toBe(false));
});

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
  const dialog = await editNewAgent();
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
  await saveAgentProfile("Scout");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Edit agent name" }).textContent).toBe("Scout"),
  );
  await waitForConnectedAgent();
  const textarea = screen.getByRole("textbox", { name: "Message Scout" });
  fireEvent.change(textarea, { target: { value: "Check the workspace" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => {
    const status = document.querySelector('.work-activity > summary [role="status"]');
    expect(status?.textContent).toBe("Thinking…");
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
    { timeout: 15000 },
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
  await waitForConnectedAgent();
  fireEvent.click(screen.getByRole("button", { name: "Agent options" }));
  const details = screen.getByRole("dialog", { name: "Jelly" });
  expect(within(details).getAllByText("Website").length).toBeGreaterThan(0);
  expect(
    within(screen.getByRole("main")).queryByRole("button", {
      name: "All agents",
    }),
  ).toBeNull();
  for (const name of [
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
        .getByRole("button", { name: "Agent list menu" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Agent list menu" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
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
        .getByRole("button", { name: "Agent list menu" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Agent list menu" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
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
      { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...(cookie ? { cookie } : {}) } },
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
test.each(["http://localhost/", "http://box.tailbfab3f.ts.net:5173/"])("Connection settings accept a key privately and complete ChatGPT sign-in at %s", async (url) => {
  window.location.href = url;
  let approve!: () => void;
  const app = await setup({
    chatgptLogin: async (callbacks) => {
      callbacks.onDeviceCode({
        verificationUri: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      });
      await new Promise<void>((resolve) => { approve = resolve; });
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
        .getByRole("button", { name: "Agent list menu" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Agent list menu" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
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
  expect(screen.getByText("ABCD-EFGH")).toBeDefined();
  expect(screen.queryByLabelText("Callback URL")).toBeNull();
  expect(JSON.stringify(app.service.snapshot())).not.toContain("ABCD-EFGH");
  await act(async () => approve());
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
        .getByRole("button", { name: "Agent list menu" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Agent list menu" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
  expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(
    (screen.getByRole("radio", { name: "GPT-6 Astra" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  for (const label of ["GPT-6 Astra Fast", "GPT-6 Sol Fast", "GPT-6.1 Sol Fast"]) {
    fireEvent.click(screen.getByRole("radio", { name: label }));
    expect((screen.getByRole("radio", { name: label }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Fast requests priority processing/)).toBeDefined();
    expect(screen.queryByText(/Ultrafast requires/)).toBeNull();
  }
  expect(screen.queryByRole("radio", { name: "GPT-6 Sol Ultrafast" })).toBeNull();
  expect(screen.getByRole("radio", { name: "GPT-6.1 Sol Ultrafast" })).toBeDefined();
  fireEvent.click(screen.getByRole("radio", { name: "GPT-6 Astra Ultrafast" }));
  expect(screen.getByText(/Higher API pricing/)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: "Reasoning effort" }));
  expect(
    (screen.getByRole("radio", { name: "Medium" }) as HTMLInputElement).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Max" }));
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(!!screen.queryByRole("dialog")).toBe(false));
  expect(app.service.snapshot().config).toMatchObject({
    selectedModel: "gpt-6-astra-ultrafast",
    effort: "max",
  });
  ui.unmount();
  ui = render(<App />);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Agent list menu" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Agent list menu" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
  expect(screen.getByRole("button", { name: "Model" }).textContent).toContain(
    "GPT-6 Astra Ultrafast",
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
  await waitForConnectedAgent();
  fireEvent.change(screen.getByRole("textbox", { name: "Message Jelly" }), {
    target: { value: "Keep my Jelly draft" },
  });
  await openInboxProject("Website");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Edit agent name" }).textContent).toBe("Milo"),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Message Milo" }), {
    target: { value: "Keep my Milo draft" },
  });
  await openInboxProject("Empty project");
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
  expect(screen.queryByRole("button", { name: "Edit agent name" })).toBeNull();
  await openInboxProject("Website");
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message Milo",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Keep my Milo draft"),
  );
  await backToInboxRoot();
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
  await waitForConnectedAgent();
  await openInboxProject("Research");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Edit agent name" }).textContent).toBe("Fin"),
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
      screen.getAllByRole("navigation", { name: "Projects and agents" }).length,
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
  await waitForConnectedAgent();
  await openInboxProject("Test project");
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "A fresh space for your ideas." }),
    ).toBeDefined(),
  );
  fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: "Create agent" }));
  const form = await editNewAgent();
  fireEvent.change(within(form).getByLabelText("Name"), {
    target: { value: "Pearl" },
  });
  expect(screen.queryByLabelText("Role")).toBeNull();
  fireEvent.click(within(form).getByRole("button", { name: "Choose avatar" }));
  fireEvent.click(within(form).getByRole("button", { name: "sea turtle" }));
  await saveAgentProfile("Pearl");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Edit agent name" }).textContent).toBe("Pearl"),
  );
  const a = app.store.agents().find((a) => a.name === "Pearl")!;
  expect(a.cwd).toBe(saved.defaultCwd);
  expect(a.projectId).toBe(saved.id);
  expect(a.avatarId).toBe("sea-turtle");
});

test("folder picker times out a stalled listing and Retry loads folders", async () => {
  await setup();
  const { DirectoryPicker } = await import("../src/client/Projects");
  const fetchBefore = globalThis.fetch;
  let stalled = true;
  let listingSignal: AbortSignal | undefined;
  globalThis.fetch = ((input: any, init: any) => {
    if (String(input).startsWith("/api/directories?")) {
      if (stalled) {
        listingSignal = init.signal;
        // Even a transport that ignores cancellation must stop blocking the UI.
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(Response.json({
        path: "/test", home: "/test", parent: "/", cursor: null,
        entries: [{ name: "Project files", path: "/test/Project files", available: true }],
      }));
    }
    return fetchBefore(input, init);
  }) as typeof fetch;
  render(<DirectoryPicker instance="Test server" onClose={() => {}} onChoose={() => {}} />);
  expect(screen.getByText("Loading folders…")).toBeDefined();
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("timed out"), { timeout: 12_000 });
  expect(listingSignal?.aborted).toBe(true);
  expect(screen.queryByText("Loading folders…")).toBeNull();
  expect(screen.getByRole("button", { name: "Use this folder" }).hasAttribute("disabled")).toBe(true);
  stalled = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: "Project files" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Use this folder" }).hasAttribute("disabled")).toBe(false);
}, 15_000);

test("new project can create a directory, recover from a conflict, and select it without losing its name", async () => {
  const app = await setup();
  const { ProjectForm } = await import("../src/client/Projects");
  // The default Home listing is redirected to a disposable test directory.
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = ((input: any, init: any) => {
    if (String(input).startsWith("/api/directories?") && !String(input).includes("&path="))
      input += `&path=${encodeURIComponent(dir!)}`;
    return fetchBefore(input, init);
  }) as typeof fetch;
  mkdirSync(join(dir!, "Existing"));
  let saved: any;
  render(<ProjectForm instance="Test server" count={0} onClose={() => {}} onDeleted={() => {}} onSaved={p => { saved = p; }} />);
  fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Coral" } });
  fireEvent.click(screen.getByRole("button", { name: "New Directory" }));
  const picker = screen.getByRole("dialog", { name: "Choose a folder" });
  const name = within(picker).getByRole("textbox", { name: "Directory name" });
  fireEvent.change(name, { target: { value: "Existing" } });
  const create = within(picker).getByRole("button", { name: "Create Directory" });
  await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
  fireEvent.click(create);
  await within(picker).findByText(/already exists/);
  expect((name as HTMLInputElement).value).toBe("Existing");
  fireEvent.change(name, { target: { value: "Coral files" } });
  fireEvent.click(create);
  const use = within(picker).getByRole("button", { name: "Use this folder" });
  await waitFor(() => expect(use.hasAttribute("disabled")).toBe(false));
  expect(within(picker).getAllByText(join(dir!, "Coral files")).length).toBeGreaterThan(0);
  fireEvent.click(use);
  expect((screen.getByLabelText("Project name") as HTMLInputElement).value).toBe("Coral");
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await waitFor(() => expect(saved?.defaultCwd).toBe(join(dir!, "Coral files")));
  expect(app.store.project(saved.id)?.name).toBe("Coral");
});

test("upload New Directory preserves selected files and uploads into the newly chosen directory", async () => {
  const app = await setup();
  const { UploadFiles } = await import("../src/client/UploadFiles");
  const agent = app.store.agents()[0]!;
  let uploaded = "";
  render(<UploadFiles agent={agent} instance="Test server" onClose={() => {}} onUploaded={name => { uploaded = name; }} />);
  const upload = screen.getByRole("dialog", { name: "Upload file" });
  fireEvent.change(within(upload).getByLabelText("Destination folder"), { target: { value: dir! } });
  fireEvent.change(within(upload).getByLabelText("Files"), {
    target: { files: [new File(["kept"], "notes.txt", { type: "text/plain" })] },
  });
  fireEvent.click(within(upload).getByRole("button", { name: "New Directory" }));
  const picker = screen.getByRole("dialog", { name: "Choose a folder" });
  fireEvent.change(within(picker).getByRole("textbox", { name: "Directory name" }), { target: { value: "Uploads" } });
  const create = within(picker).getByRole("button", { name: "Create Directory" });
  await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
  fireEvent.click(create);
  const use = within(picker).getByRole("button", { name: "Use this folder" });
  await waitFor(() => expect(use.hasAttribute("disabled")).toBe(false));
  fireEvent.click(use);
  expect((within(upload).getByLabelText("Destination folder") as HTMLInputElement).value).toBe(join(dir!, "Uploads"));
  expect(within(upload).getByText("notes.txt")).toBeDefined();
  fireEvent.click(within(upload).getByRole("button", { name: "Upload" }));
  await waitFor(() => expect(uploaded).toBe("notes.txt"));
  expect(readFileSync(join(dir!, "Uploads", "notes.txt"), "utf8")).toBe("kept");
});

test("late history from a rapid A to B to A switch cannot replace the selected chat or its draft", async () => {
  const app = await setup();
  const b = app.service.createAgent({
    name: "Pearl",

    instructions: "",
    color: "#a4c8e8",
  });
  render(<App />);
  await waitForConnectedAgent();
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
  expect(document.activeElement === trigger).toBe(true);
  expect(document.activeElement === model).toBe(false);
  expect(within(model).getByRole("option", { name: "GPT-6.1 Sol" })).toBeDefined();
  for (const [id, label] of [
    ["gpt-6-astra-fast", "GPT-6 Astra Fast"],
    ["gpt-6-sol-fast", "GPT-6 Sol Fast"],
    ["gpt-6.1-sol-fast", "GPT-6.1 Sol Fast"],
  ] as const) {
    expect(within(model).getByRole("option", { name: label })).toBeDefined();
    fireEvent.change(model, { target: { value: id } });
    await waitFor(() => {
      expect(model.value).toBe(id);
      expect(model.disabled).toBe(false);
    });
    expect(app.service.snapshot().config.selectedModel).toBe(id);
    expect(screen.getByText(/Fast requests priority processing/)).toBeDefined();
    expect(screen.queryByText(/Ultrafast requires/)).toBeNull();
  }
  expect(within(model).queryByRole("option", { name: "GPT-6 Sol Ultrafast" })).toBeNull();
  expect(within(model).getByRole("option", { name: "GPT-6.1 Sol Ultrafast" })).toBeDefined();
  fireEvent.change(model, { target: { value: "gpt-6-astra-ultrafast" } });
  await waitFor(() => {
    expect(model.value).toBe("gpt-6-astra-ultrafast");
    expect(model.disabled).toBe(false);
  });
  expect(screen.getByText(/Higher API pricing/)).toBeDefined();
  const effort = screen.getByRole("combobox", {
    name: "Reasoning effort",
  }) as HTMLSelectElement;
  fireEvent.change(effort, { target: { value: "high" } });
  await waitFor(() => {
    expect(effort.value).toBe("high");
    expect(effort.disabled).toBe(false);
  });
  expect(app.service.snapshot().config).toMatchObject({
    selectedModel: "gpt-6-astra-ultrafast",
    effort: "high",
    mode: "auto",
  });
  fireEvent.keyDown(effort, { key: "Escape" });
  fireEvent.click(trigger);
  fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "gpt-6.1-sol" } });
  await waitFor(() => expect(app.service.snapshot().config.selectedModel).toBe("gpt-6.1-sol"));
  expect(app.service.snapshot().config.model).toBe("gpt-6.1-sol");
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

test("older servers default the effort display to High without overwriting saved settings", async () => {
  const app = await setup();
  const first = app.store.agents()[0]!;
  app.service.setConfig({ model: "gpt-6-sol", effort: "low" });
  app.store.setAgentConfig(first.id, "gpt-6.1-sol", "max");
  const fetchBefore = globalThis.fetch;
  let legacy = true;
  const changes: unknown[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    if (String(input) === "/api/config" && init?.method === "PUT")
      changes.push(JSON.parse(init.body));
    const response = await fetchBefore(input, init);
    if (response.ok && legacy && String(input).startsWith("/api/state")) {
      const snapshot = await response.json();
      snapshot.agents = snapshot.agents.map(({ model, effort, ...agent }: any) => agent);
      return Response.json(snapshot);
    }
    return response;
  }) as typeof fetch;
  let ui = render(<App />);
  await waitForConnectedAgent();
  const trigger = screen.getByRole("button", { name: "Model and effort" });
  expect(trigger.getAttribute("title")).toBe("GPT-6 Sol · High");
  fireEvent.click(trigger);
  const effort = screen.getByRole("combobox", { name: "Reasoning effort" }) as HTMLSelectElement;
  const model = screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement;
  expect(effort.value).toBe("high");
  expect(model.value).toBe("gpt-6-sol");
  expect(effort.disabled).toBe(true);
  expect(model.disabled).toBe(true);
  expect(screen.getByText(/Server restart pending/)).toBeDefined();
  fireEvent.change(effort, { target: { value: "low" } });
  expect(changes).toEqual([]);
  expect(app.store.instance().effort).toBe("low");
  ui.unmount();
  legacy = false;
  ui = render(<App />);
  await waitForConnectedAgent();
  fireEvent.click(screen.getByRole("button", { name: "Model and effort" }));
  const upgraded = screen.getByRole("combobox", { name: "Reasoning effort" }) as HTMLSelectElement;
  expect(upgraded.value).toBe("max");
  expect(upgraded.disabled).toBe(false);
  expect(screen.queryByText(/Server restart pending/)).toBeNull();
  fireEvent.change(upgraded, { target: { value: "xhigh" } });
  await waitFor(() => {
    expect(upgraded.value).toBe("xhigh");
    expect(upgraded.disabled).toBe(false);
  });
  expect(changes).toEqual([{ effort: "xhigh", agentId: first.id }]);
});

test("composer model settings follow the selected agent rather than the latest creation defaults", async () => {
  const app = await setup();
  const first = app.store.agents()[0]!;
  const other = app.service.createAgent({ name: "Other", instructions: "", color: "#fff" });
  render(<App />);
  await waitForConnectedAgent();
  fireEvent.click(screen.getByTitle(`${first.name} · idle`));
  const open = async () => {
    const button = screen.getByRole("button", { name: "Model and effort" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    return screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement;
  };
  const choose = async (name: string, value: string) => {
    fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } });
    await waitFor(() => {
      const select = screen.getByRole("combobox", { name }) as HTMLSelectElement;
      expect(select.value).toBe(value);
      expect(select.disabled).toBe(false);
    });
  };
  await open();
  await choose("Model", "gpt-6.1-sol");
  await choose("Reasoning effort", "max");
  const newer = app.service.createAgent({ name: "Newer", instructions: "", color: "#fff" });
  expect(newer).toMatchObject({ model: "gpt-6.1-sol", effort: "max" });
  fireEvent.click(screen.getByTitle("Other · idle"));
  await screen.findByRole("textbox", { name: "Message Other" });
  expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
  expect((await open()).value).toBe("gpt-6-astra");
  expect((screen.getByRole("combobox", { name: "Reasoning effort" }) as HTMLSelectElement).value).toBe("medium");
  await choose("Reasoning effort", "low");
  expect(app.store.agent(other.id)).toMatchObject({ model: "gpt-6-astra", effort: "low" });
  expect(app.store.instance()).toMatchObject({ model: "gpt-6-astra", effort: "low" });
  fireEvent.click(screen.getByTitle(`${first.name} · idle`));
  await screen.findByRole("textbox", { name: `Message ${first.name}` });
  expect((await open()).value).toBe("gpt-6.1-sol");
  expect((screen.getByRole("combobox", { name: "Reasoning effort" }) as HTMLSelectElement).value).toBe("max");
});

test("mobile model settings use a heading-focused sheet and restore the trigger", async () => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => {
    const media = originalMatchMedia.call(window, query);
    if (query.includes("max-width: 767px"))
      Object.defineProperty(media, "matches", { value: true });
    return media;
  }) as typeof window.matchMedia;
  try {
    await setup();
    render(<App />);
    await waitForConnectedAgent();
    const trigger = screen.getByRole("button", { name: "Model and effort" });
    fireEvent.click(trigger);
    const sheet = screen.getByRole("dialog", { name: "Model and effort" });
    expect(document.activeElement?.tagName).toBe("H2");
    expect(sheet.closest("form")).toBeNull();
    const effort = within(sheet).getByRole("combobox", { name: "Reasoning effort" });
    fireEvent.change(effort, { target: { value: "high" } });
    await waitFor(() => expect(effort.hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("dialog", { name: "Model and effort" })).toBe(sheet);
    fireEvent(sheet, new window.Event("cancel", { cancelable: true }));
    await waitFor(() => expect(!!screen.queryByRole("dialog", { name: "Model and effort" })).toBe(false));
    expect(document.activeElement).toBe(trigger);
  } finally {
    cleanup();
    window.matchMedia = originalMatchMedia;
  }
});

test("composer and popup budgets reserve conversation and avoid viewport edges", () => {
  expect(composerBudget(800, 800, 100)).toBe(500);
  expect(composerBudget(320, 320, 100)).toBe(140);
  expect(composerBudget(100, 100, 120)).toBe(0);
  const bounds = { left: 12, right: 308, top: 12, bottom: 308 };
  const size = { width: 280, height: 180 };
  const left = placePopover({ left: 20, right: 64, top: 260, bottom: 304 }, size, bounds, "above");
  expect(left).toEqual({ left: 12, top: 72, maxHeight: 240 });
  const flipped = placePopover({ left: 260, right: 304, top: 20, bottom: 64 }, size, bounds, "above");
  expect(flipped).toEqual({ left: 24, top: 72, maxHeight: 236 });
  const short = placePopover({ left: 20, right: 64, top: 130, bottom: 174 }, { ...size, height: 800 }, bounds, "below");
  expect(short.top + short.maxHeight).toBeLessThanOrEqual(bounds.bottom);
  const offscreen = placePopover({ left: 20, right: 64, top: 1000, bottom: 1044 }, { ...size, height: 800 }, bounds, "above");
  expect(offscreen.top).toBe(bounds.top);
  expect(offscreen.top + offscreen.maxHeight).toBe(bounds.bottom);
});

test("composer expands, reserves a quarter of the viewport, and shrinks when text is removed", async () => {
  await setup();
  // The DOM fixture has no layout. Supply textarea metrics for both the live
  // input and the hidden measurement textarea used to preserve iOS selection.
  const prototype = window.HTMLTextAreaElement.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, "scrollHeight");
  let contentHeight = 240;
  Object.defineProperty(prototype, "scrollHeight", {
    configurable: true,
    get: () => contentHeight,
  });
  try {
    render(<App />);
    const input = (await screen.findByRole("textbox", {
      name: /Message Jelly/,
    })) as HTMLTextAreaElement;
    const main = input.closest("main")!;
    Object.defineProperty(main, "clientHeight", {
      configurable: true,
      value: 800,
    });
    fireEvent.change(input, { target: { value: "one\ntwo\nthree" } });
    expect(input.style.height).toBe("240px");
    expect(input.style.overflowY).toBe("hidden");
    contentHeight = 1200;
    fireEvent.change(input, { target: { value: "line\n".repeat(80) } });
    expect(parseFloat(input.style.height)).toBeLessThanOrEqual(800 - Math.min(800, window.innerHeight) / 4);
    expect(input.style.overflowY).toBe("auto");
    contentHeight = 44;
    fireEvent.change(input, { target: { value: "" } });
    expect(input.style.height).toBe("44px");
    expect(input.style.overflowY).toBe("hidden");
  } finally {
    cleanup();
    if (original) Object.defineProperty(prototype, "scrollHeight", original);
    else Reflect.deleteProperty(prototype, "scrollHeight");
  }
});

test("settings shows read-only MCP status and refreshes agent configuration changes", async () => {
  const app = await setup();
  render(<App />);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Agent list menu" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Agent list menu" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "MCP connections" }));
  const fieldset = await screen.findByRole("group", {
    name: "MCP connections",
  });
  await waitFor(() =>
    expect(
      within(fieldset).getByText("No MCP servers connected."),
    ).toBeTruthy(),
    { timeout: 10000 },
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
    { timeout: 10000 },
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
  await waitForConnectedAgent();
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
  await waitForConnectedAgent();
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

test("busy composer always queues without a delivery dropdown and preserves Steer now", async () => {
  const app = await setup({ fixtureDelayMs: 800 });
  const id = app.store.agents()[0]!.id;
  let ui = render(<App />);
  await waitForConnectedAgent();
  app.service.start(id, "ui-first", "Keep working");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Queue message" })).toBeDefined(),
  );
  const textarea = screen.getByRole("textbox", { name: "Message Jelly" });
  expect(screen.queryByLabelText("Message delivery")).toBeNull();
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
  fireEvent.change(screen.getByRole("textbox", { name: "Message Jelly" }), {
    target: { value: "One more correction" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message Jelly",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe(""),
  );
  expect(screen.queryByLabelText("Message delivery")).toBeNull();
  await act(async () => {
    await app.service.settled();
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeDefined(),
  );
  expect(app.store.runs(id)).toHaveLength(2);
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
    if (query === "(max-width: 767px)" || query === "(max-width: 767px), (any-pointer: coarse)")
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
    act(() => {
      input.blur();
      viewport.height = window.innerHeight;
      viewport.dispatchEvent(new window.Event("resize"));
    });
    expect(root.dataset.keyboardOpen).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Model and effort" }));
    const effort = screen.getByRole("combobox", { name: "Reasoning effort" });
    act(() => {
      effort.focus();
      viewport.height = 320;
      viewport.dispatchEvent(new window.Event("resize"));
    });
    expect(root.dataset.keyboardOpen).toBe("true");
    expect(screen.getByRole("dialog", { name: "Model and effort" }).style.getPropertyValue("--sheet-viewport-height")).toBe("320px");
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

test("browser login cards collapse after settling, without duplicating tool history", async () => {
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
  const onChange = () => {};
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
      onChange={() => {
        changed = true;
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText("Sign in through the browser")).toBeNull();
  await screen.findByText("Dismissal failed.");
  expect(screen.getByText("Sign in through the browser")).toBeDefined();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
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
  expect(document.querySelector(".initial-agent-identity .status-dot")).toBeNull();
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
        .getByRole("button", { name: "Agent list menu" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Agent list menu" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
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
  await screen.findByRole("button", { name: "Agent options" });
  fireEvent.click(screen.getByRole("button", { name: "Agent options" }));
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

test("plus creates and opens an agent immediately without a modal or duplicate in-flight requests", async () => {
  const app = await setup();
  render(<App />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Create agent" }).hasAttribute("disabled")).toBe(false));
  const fetchBefore = globalThis.fetch;
  let release = () => {}, requests = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = (async (input: any, init: any) => {
    if (input === "/api/agents" && init?.method === "POST") { requests++; await gate; }
    return fetchBefore(input, init);
  }) as typeof fetch;
  fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
  fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
  await waitFor(() => expect(requests).toBe(1));
  expect(screen.getByRole("button", { name: "Create agent" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
  release();
  await screen.findByRole("textbox", { name: "Message New Agent" });
  expect(app.store.agents()).toHaveLength(2);
  expect(app.store.agents().find(a => a.name === "New Agent")?.projectId).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.querySelector(".app")?.classList.contains("show-chat")).toBe(true);
});

test("quick-create failure stays visible and allows a fresh attempt", async () => {
  const app = await setup();
  render(<App />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Create agent" }).hasAttribute("disabled")).toBe(false));
  const fetchBefore = globalThis.fetch;
  let fail = true;
  globalThis.fetch = (async (input: any, init: any) => {
    if (fail && input === "/api/agents" && init?.method === "POST")
      return Response.json({ error: "Could not create this agent" }, { status: 503 });
    return fetchBefore(input, init);
  }) as typeof fetch;
  fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain("Could not create this agent");
  expect(app.store.agents()).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Create agent" }).hasAttribute("disabled")).toBe(false);
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
  await screen.findByRole("textbox", { name: "Message New Agent" });
  expect(screen.queryByRole("alert")).toBeNull();
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
  ui.rerender(<WorkActivity {...props} activity="Checking the layout before editing." />);
  expect(work.querySelector('summary [role="status"]')?.textContent).toBe("Checking the layout before editing.");
  fireEvent.click(work.querySelector("summary")!);
  await waitFor(() => expect(work.open).toBe(true));
  const thinking = screen.getByRole("region", { name: "Thinking" });
  expect(within(thinking).getByText("Inspect the layout before making a change.")).toBeDefined();
  expect(work.querySelector(".work-activity-items")!.firstElementChild).toBe(thinking);
  expect(screen.queryByText(/Raw tool output/)).toBeNull();
  const tool = work.querySelector<HTMLDetailsElement>(".work-step")!;
  expect(tool.open).toBe(false);
  ui.rerender(<WorkActivity {...props} activity="Now tightening the spacing." />);
  expect(work.open).toBe(true);
  expect(work.querySelector('summary [role="status"]')?.textContent).toBe("Now tightening the spacing.");
  ui.rerender(<WorkActivity {...props} activity="Stale live preview" run={{ ...run, status: "completed", endedAt: "2026-01-01T12:00:30Z" }} />);
  expect(screen.getByText("Worked for 30s").classList.contains("work-status-sheen")).toBe(false);
  expect(work.open).toBe(true);
  expect(tool.open).toBe(false);
  fireEvent.click(tool.querySelector("summary")!);
  await waitFor(() => expect(!!screen.queryByText(/Raw tool output/)).toBe(true));
  expect(screen.getByText("Input")).toBeDefined();
  expect(screen.getByText("Result")).toBeDefined();
  ui.rerender(<WorkActivity {...props} activity="Stale live preview" agent={{ ...agent, status: "waiting" }} />);
  expect(screen.getByText(`${agent.name} is Waiting for you`).classList.contains("work-status-sheen")).toBe(false);
  ui.rerender(<WorkActivity {...props} activity="Stale live preview" stopping />);
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

test("browser screenshots group across tool activity but not messages, other images, or runs", async () => {
  const { conversationActivity } = await import("../src/client/conversationActivity");
  const image = { type: "image", mimeType: "image/png", data: "AAAA" };
  const event = (id: number, type: string, data: Record<string, unknown> = {}, runId = "one"): import("../src/shared/types").Activity => ({ id, type, data, runId, agentId: "agent", createdAt: "2026-01-01T00:00:00Z" });
  const shot = (id: number, name = "browser_screenshot", runId = "one") => event(id, "tool_completed", { name, result: { content: [image] } }, runId);
  const entries = conversationActivity([
    shot(1), event(2, "tool_started", { name: "browser_click" }),
    event(3, "turn_completed"), shot(4),
    event(5, "message", { role: "assistant", text: "Next page" }), shot(6),
    shot(7, "read"), shot(8), shot(9, "browser_screenshot", "two"),
  ], []);
  expect(entries.filter(entry => entry.kind === "screenshots").map(entry => entry.events.map(e => e.id)))
    .toEqual([[1, 4], [6], [8], [9]]);
  expect(entries.some(entry => entry.kind === "event" && entry.event.id === 7)).toBe(true);
});

test("browser screenshot carousel shows latest, navigates all shots, follows live updates and restores history", async () => {
  const app = await setup();
  const agent = app.store.agents()[0]!;
  const run = app.store.createRun(agent.id, crypto.randomUUID(), "Browse", "api", "model");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7L8AAAAASUVORK5CYII=";
  const shot = () => app.service.emit(agent.id, run.id, "tool_completed", {
    name: "browser_screenshot", toolCallId: crypto.randomUUID(),
    result: { content: [{ type: "image", mimeType: "image/png", data: png }] },
  });
  app.store.event(agent.id, run.id, "message", { role: "user", text: "Browse the site" });
  const shots = Array.from({ length: 12 }, shot);
  let ui = render(<App />);
  const image = () => screen.getByRole("img", { name: "Image from browser_screenshot" });
  await screen.findByRole("img", { name: "Image from browser_screenshot" });
  expect(image().getAttribute("src")).toBe(`/api/tool-images/${shots[11]!.id}/0`);
  expect(screen.getAllByRole("region", { name: "Browser screenshots" })).toHaveLength(1);
  expect(screen.getAllByRole("img", { name: "Image from browser_screenshot" })).toHaveLength(1);
  const carousel = screen.getByRole("region", { name: "Browser screenshots" });
  expect(within(carousel).getByRole("status").textContent).toBe("12 / 12");
  expect((within(carousel).getByRole("button", { name: "Next screenshot" }) as HTMLButtonElement).disabled).toBe(true);
  let latest!: ReturnType<typeof shot>;
  act(() => { latest = shot(); });
  await waitFor(() => expect(image().getAttribute("src")).toBe(`/api/tool-images/${latest.id}/0`));
  fireEvent.click(within(carousel).getByRole("button", { name: "Previous screenshot" }));
  expect(image().getAttribute("src")).toBe(`/api/tool-images/${shots[11]!.id}/0`);
  act(() => { latest = shot(); });
  await waitFor(() => expect(within(carousel).getByRole("status").textContent).toBe("12 / 14"));
  expect(image().getAttribute("src")).toBe(`/api/tool-images/${shots[11]!.id}/0`);
  for (let i = 0; i < 11; i++) fireEvent.click(within(carousel).getByRole("button", { name: "Previous screenshot" }));
  expect(image().getAttribute("src")).toBe(`/api/tool-images/${shots[0]!.id}/0`);
  expect((within(carousel).getByRole("button", { name: "Previous screenshot" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(carousel).getByRole("button", { name: "Next screenshot" }));
  expect(image().getAttribute("src")).toBe(`/api/tool-images/${shots[1]!.id}/0`);
  fireEvent.click(within(carousel).getByRole("button", { name: "Latest" }));
  const download = within(carousel).getByRole("link", { name: "Download image" });
  expect(download.getAttribute("href")).toBe(`/api/tool-images/${latest.id}/0`);
  expect(download.textContent).toBe("");
  expect(download.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  expect(download.getAttribute("title")).toBe("Download image");
  ui.unmount();
  ui = render(<App />);
  await screen.findByRole("img", { name: "Image from browser_screenshot" });
  expect(image().getAttribute("src")).toBe(`/api/tool-images/${latest.id}/0`);
  expect(screen.getAllByRole("region", { name: "Browser screenshots" })).toHaveLength(1);
});

test("render_file displays images and expandable inert text with download and history", async () => {
  const app = await setup();
  const agent = app.store.agents()[0]!;
  const source = join(dir!, "preview.txt");
  writeFileSync(source, '<script>window.stolen=true</script>\n' + "hello from the file\n".repeat(220));
  const textFile = await app.service.harness.files.save(source, dir!);
  const imageSource = join(dir!, "cafe.png");
  writeFileSync(imageSource, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7L8AAAAASUVORK5CYII=", "base64"));
  const imageFile = await app.service.harness.files.save(imageSource, dir!);
  app.store.event(agent.id, null, "message", { role: "user", text: "Show these files" });
  app.store.event(agent.id, null, "file_rendered", { files: [textFile, imageFile] });
  let ui = render(<App />);
  await screen.findByRole("img", { name: "cafe.png" });
  const file = screen.getByRole("region", { name: "File: preview.txt" });
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
  expect(screen.getByRole("region", { name: "File: preview.txt" }).textContent).not.toContain("hello from the file");
});

test("render_file formats Markdown previews safely, including saved attachments and full downloads", async () => {
  const app = await setup();
  const agent = app.store.agents()[0]!;
  const text = [
    "# Project notes",
    "",
    "**Important** and `inline code` with [documentation](https://example.com/docs).",
    "",
    "- First task",
    "- Second task",
    "",
    "```ts",
    'const example = "<script>not executed</script>";',
    "```",
    "",
    "| Name | Status |",
    "| --- | --- |",
    "| Preview | Ready |",
    "",
    '<script>window.stolen=true</script>',
    '<img src="https://evil.example/tracker" onerror="window.stolen=true">',
    "[unsafe](javascript:alert(1))",
    "",
    ...Array.from({ length: 220 }, (_, i) => `Note ${i}`),
  ].join("\n");
  const files = [];
  for (const name of ["notes.md", "NOTES.MD", "notes.markdown"]) {
    const source = join(dir!, name);
    writeFileSync(source, text);
    files.push(await app.service.harness.files.save(source, dir!));
  }
  app.store.event(agent.id, null, "message", { role: "user", text: "Show Markdown files" });
  app.store.event(agent.id, null, "file_rendered", { files });
  let ui = render(<App />);
  for (const saved of files) {
    const file = await screen.findByRole("region", { name: `File: ${saved.name}` });
    expect(file.textContent).toContain("Markdown ·");
    expect(file.querySelector(".message-text")).toBeNull();
    const details = file.querySelector("details")!;
    await act(async () => { details.open = true; fireEvent(details, new window.Event("toggle")); });
    await within(file).findByRole("heading", { name: "Project notes" });
    const preview = within(file).getByRole("region", { name: `Markdown preview: ${saved.name}` });
    expect(preview.getAttribute("tabindex")).toBe("0");
    expect(preview.querySelector("strong")?.textContent).toBe("Important");
    expect(preview.querySelector("code")?.textContent).toBe("inline code");
    expect(within(preview).getAllByRole("listitem").map(item => item.textContent)).toEqual(["First task", "Second task"]);
    expect(preview.querySelector(".code-block pre code")?.textContent).toBe('const example = "<script>not executed</script>";');
    expect(within(preview).getByRole("cell", { name: "Ready" })).toBeDefined();
    const link = within(preview).getByRole("link", { name: "documentation" });
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(preview.textContent).toContain("<script>window.stolen=true</script>");
    expect(preview.querySelector("script, img, iframe, a[href^='javascript:']")).toBeNull();
    expect(file.textContent).toContain("Preview shortened");
    const download = within(file).getByRole("link", { name: "Download file" });
    expect(download.getAttribute("href")).toBe(saved.url);
    expect(download.getAttribute("download")).toBe(saved.name);
    expect(await (await fetch(saved.url)).text()).toBe(text);
  }
  ui.unmount();
  ui = render(<App />);
  const file = await screen.findByRole("region", { name: "File: notes.md" });
  const details = file.querySelector("details")!;
  await act(async () => { details.open = true; fireEvent(details, new window.Event("toggle")); });
  await within(file).findByRole("heading", { name: "Project notes" });
});

test("Markdown previews retain on-demand loading and retry after a failed fetch", async () => {
  const { RenderedFiles } = await import("../src/client/RenderedFiles");
  const app = await setup();
  const source = join(dir!, "retry.md");
  writeFileSync(source, "# Loaded after retry");
  const saved = await app.service.harness.files.save(source, dir!);
  const fetchBefore = globalThis.fetch;
  let fail = true, requests = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    if (input === `${saved.url}?preview=1`) {
      requests++;
      if (fail) return new Response(JSON.stringify({ error: "Fixture offline" }), { status: 503 });
    }
    return fetchBefore(input, init);
  }) as typeof fetch;
  render(<RenderedFiles files={[saved]} />);
  expect(requests).toBe(0);
  const file = screen.getByRole("region", { name: "File: retry.md" });
  const details = file.querySelector("details")!;
  await act(async () => { details.open = true; fireEvent(details, new window.Event("toggle")); });
  await within(file).findByRole("alert");
  expect(requests).toBe(1);
  expect(within(file).getByRole("link", { name: "Download file" })).toBeDefined();
  fail = false;
  fireEvent.click(within(file).getByRole("button", { name: "Retry" }));
  await within(file).findByRole("heading", { name: "Loaded after retry" });
  expect(requests).toBe(2);
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
  await waitForConnectedAgent();
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
  await waitForConnectedAgent();
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
  fireEvent.click(screen.getByRole("button", { name: "New agent provider" }));
  expect(screen.getAllByRole("radio")).toHaveLength(4);
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
      if (response.ok && typeof input === "string" && input.startsWith("/api/state")) {
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
  app.service.emit(id, null, "message", { role: "user", text: "Earlier work" });
  app.store.setStatus(id, "running");
  const other = app.service.createAgent({ name: "Pearl", instructions: "", color: "#a4c8e8" });
  app.service.emit(other.id, null, "message", { role: "user", text: "Earlier work" });
  render(<App />);
  const pill = await screen.findByRole("button", { name: "Edit Jelly profile" });
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
  const idlePill = await screen.findByRole("button", { name: "Edit Pearl profile" });
  expect(idlePill.querySelector(".agent-avatar.is-working")).toBeNull();
  expect(app.store.agent(other.id)!.status).toBe("idle");
  fireEvent.click(screen.getByTitle("Jelly · running"));
  const workingPill = await screen.findByRole("button", { name: "Edit Jelly profile" });
  expect(workingPill.querySelector(".agent-avatar.is-working")).not.toBeNull();
  fireEvent.click(workingPill);
  expect(screen.getByRole("dialog", { name: "Agent profile" })).toBeDefined();
  expect(screen.getByLabelText("Name").closest("fieldset")!.disabled).toBe(true);
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
    }} onChange={() => {}} />);
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
    }} onChange={() => {}} />
    <ChatFormCard title="Another inline form" icon={<span />} description="A shared form pattern." error="Try again.">
      <ChatFormActions><button type="button">Continue</button></ChatFormActions>
    </ChatFormCard>
  </>);
  const browser = screen.getByRole("region", { name: "Browser login" });
  expect(browser.classList.contains("chat-form-card")).toBe(true);
  expect(within(browser).getByText("Needs your sign-in")).toBeDefined();
  expect(within(browser).getByText("https://example.com/sign-in")).toBeDefined();
  expect(within(browser).getByRole("button", { name: "Take control" })).toBeDefined();
  expect(within(browser).getByRole("button", { name: "Done" }).hasAttribute("disabled")).toBe(false);
  const generic = screen.getByRole("region", { name: "Another inline form" });
  expect(generic.classList.contains("chat-form-card")).toBe(true);
  expect(within(generic).getByRole("alert").textContent).toBe("Try again.");
  expect(within(generic).getByText("Needs your input")).toBeDefined();
  expect(within(browser).getByText(/Other browser work may continue/)).toBeDefined();
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
  }} onChange={() => {}} />);
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

test("new agents default to New Agent and receive a sea-themed name after the first message", async () => {
  const app = await setup();
  const prompts: string[] = [];
  app.service.harness.generateAgentName = async prompt => { prompts.push(prompt); return "Coral Coder"; };
  render(<App />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Create agent" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await screen.findByRole("textbox", { name: "Message New Agent" });
  expect(prompts).toEqual([]);
  fireEvent.change(screen.getByRole("textbox", { name: "Message New Agent" }), { target: { value: "Build a React app" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("textbox", { name: "Message Coral Coder" });
  expect(prompts).toEqual(["Build a React app"]);
  expect(within(screen.getByRole("main")).getByText("Build a React app")).toBeDefined();
  await act(async () => { await app.service.settled(); });
});

test("editing the placeholder name before the first message opts out even when changed back", async () => {
  const app = await setup();
  let calls = 0;
  app.service.harness.generateAgentName = async () => { calls++; return "Never Applied"; };
  const agent = app.service.createAgent({ name: "New Agent", instructions: "", color: "#b5bafc" });
  render(<App />);
  fireEvent.click(await screen.findByTitle("New Agent · idle"));
  await screen.findByRole("textbox", { name: "Message New Agent" });
  fireEvent.click(screen.getByRole("button", { name: "Edit agent name" }));
  fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "My choice" } });
  fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "New Agent" } });
  fireEvent.blur(screen.getByLabelText("Agent name"));
  await waitFor(() => expect(!!screen.queryByLabelText("Agent name")).toBe(false));
  fireEvent.change(screen.getByRole("textbox", { name: "Message New Agent" }), { target: { value: "Organize the workspace" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(!!within(screen.getByRole("main")).queryByText("Organize the workspace")).toBe(true));
  await act(async () => { await app.service.settled(); });
  expect(calls).toBe(0);
  expect(app.store.agent(agent.id)!.name).toBe("New Agent");
});

test("centered identity edits the name in place, preserves other fields, and skips automatic naming", async () => {
  const app = await setup();
  const agent = app.service.createAgent({ name: "New Agent", instructions: "Keep these instructions", color: "#abcdef", avatarId: "crab" });
  let namingCalls = 0;
  app.service.harness.generateAgentName = async () => { namingCalls++; return "Coral Coder"; };
  render(<App />);
  fireEvent.click(await screen.findByTitle("New Agent · idle"));
  await screen.findByRole("textbox", { name: "Message New Agent" });
  expect(document.querySelector(".conversation-header .agent-identity")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit agent name" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  const input = screen.getByRole("textbox", { name: "Agent name" });
  expect(input.closest(".initial-agent-identity")).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Save agent name" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel name edit" })).toBeNull();
  fireEvent.change(input, { target: { value: "My Crab" } });
  fireEvent.blur(input);
  await waitFor(() => expect(app.store.agent(agent.id)!.name).toBe("My Crab"));
  await screen.findByRole("textbox", { name: "Message My Crab" });
  expect(app.store.agent(agent.id)!.instructions).toBe("Keep these instructions");
  expect(app.store.agent(agent.id)!.color).toBe("#abcdef");
  expect(app.store.agent(agent.id)!.avatarId).toBe("crab");
  expect(screen.getByRole("button", { name: "Edit agent name" }).textContent).toBe("My Crab");
  fireEvent.change(screen.getByRole("textbox", { name: "Message My Crab" }), { target: { value: "Help with code" } });
  await waitFor(() => expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("button", { name: "Edit My Crab profile" });
  await act(async () => { await app.service.settled(); });
  expect(namingCalls).toBe(0);
  expect(screen.queryByRole("button", { name: "Edit agent name" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit My Crab profile" }));
  await screen.findByRole("dialog", { name: "Agent profile" });
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("My Crab");
  expect(screen.getByRole("button", { name: "Save profile" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Edit agent profile" })).toBeNull();
});

test("avatar edits are inline, leave automatic naming eligible, and remain centered while scrolling", async () => {
  const app = await setup();
  const agent = app.service.createAgent({ name: "New Agent", instructions: "Preserve", color: "#aabbcc" });
  app.service.harness.generateAgentName = async () => "Coral Coder";
  render(<App />);
  fireEvent.click(await screen.findByTitle("New Agent · idle"));
  await screen.findByRole("textbox", { name: "Message New Agent" });
  fireEvent.click(screen.getByRole("button", { name: "Edit agent avatar" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  const grid = screen.getByRole("group", { name: "Sea creature avatars" });
  expect(within(grid).getAllByRole("button")).toHaveLength(12);
  expect(screen.queryByText("Choose avatar")).toBeNull();
  expect(screen.queryByText("Choose a sea creature")).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  const chat = screen.getByLabelText("Conversation");
  Object.defineProperties(chat, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 300, configurable: true }, scrollTop: { value: 100, writable: true, configurable: true } });
  fireEvent.scroll(chat);
  expect(screen.getByRole("button", { name: "Edit agent name" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "octopus" }));
  await waitFor(() => expect(app.store.agent(agent.id)!.avatarId).toBe("octopus"));
  await waitFor(() => expect(!!screen.queryByRole("group", { name: "Sea creature avatars" })).toBe(false));
  expect(app.store.agent(agent.id)!.instructions).toBe("Preserve");
  expect(app.store.agent(agent.id)!.color).toBe("#aabbcc");
  expect(document.querySelector(".initial-agent-avatar img")!.getAttribute("src")).toContain("octopus");
  fireEvent.change(screen.getByRole("textbox", { name: "Message New Agent" }), { target: { value: "Make a web app" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("textbox", { name: "Message Coral Coder" });
  await act(async () => { await app.service.settled(); });
  expect(app.store.agent(agent.id)!.avatarId).toBe("octopus");
});

test("inline name Escape cancels, blur saves, and failures remain retryable without racing Send", async () => {
  const app = await setup();
  const agent = app.store.agents()[0]!;
  render(<App />);
  await screen.findByRole("textbox", { name: "Message Jelly" });
  await waitForConnectedAgent();
  fireEvent.click(screen.getByRole("button", { name: "Edit agent name" }));
  fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Discard this" } });
  fireEvent.keyDown(screen.getByLabelText("Agent name"), { key: "Escape" });
  expect(screen.queryByLabelText("Agent name")).toBeNull();
  expect(app.store.agent(agent.id)!.name).toBe("Jelly");
  const fetchBefore = globalThis.fetch;
  let reject = true;
  globalThis.fetch = (async (input: any, init: any) => {
    if (reject && init?.method === "PATCH") return Response.json({ error: "Try again" }, { status: 503 });
    return fetchBefore(input, init);
  }) as typeof fetch;
  fireEvent.click(screen.getByRole("button", { name: "Edit agent name" }));
  fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Jelly Updated" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Message Jelly" }), { target: { value: "A preserved draft" } });
  expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.blur(screen.getByLabelText("Agent name"), { relatedTarget: screen.getByRole("textbox", { name: "Message Jelly" }) });
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toBe("Try again");
  expect((screen.getByLabelText("Agent name") as HTMLInputElement).value).toBe("Jelly Updated");
  expect(app.store.agent(agent.id)!.name).toBe("Jelly");
  reject = false;
  fireEvent.blur(screen.getByLabelText("Agent name"));
  await screen.findByRole("textbox", { name: "Message Jelly Updated" });
  expect((screen.getByRole("textbox", { name: "Message Jelly Updated" }) as HTMLTextAreaElement).value).toBe("A preserved draft");
  await waitFor(() => expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByRole("alert")).toBeNull();
});


test("centered identity has no Ready indicator or workspace prompt suggestion", async () => {
  const app = await setup();
  render(<App />);
  await waitForConnectedAgent();
  const pill = screen.getByRole("group", { name: "Agent profile" });
  expect(within(pill).queryByText("Ready")).toBeNull();
  expect(pill.querySelector(".status-dot")).toBeNull();
  expect(screen.queryByRole("button", { name: /Tell me about this workspace/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Edit agent name" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Edit agent avatar" })).toBeDefined();
  act(() => { app.service.emit(app.store.agents()[0]!.id, null, "message", { role: "user", text: "Begin work" }); });
  const headerPill = await screen.findByRole("button", { name: "Edit Jelly profile" });
  expect(within(headerPill).getByText("Ready")).toBeDefined();
});

test("inbox sorts by latest assistant response and updates live without changing selection", async () => {
  const app = await setup();
  const original = app.store.agents()[0]!;
  const recent = app.service.createAgent({ name: "Recent responder", instructions: "Test", color: "#abc" });
  const empty = app.service.createAgent({ name: "No replies yet", instructions: "Test", color: "#abc" });
  const older = app.service.emit(original.id, null, "message", { role: "assistant", text: "Earlier answer." });
  const newer = app.service.emit(recent.id, null, "message", { role: "assistant", text: "Recent answer." });
  app.store.db.query("UPDATE timeline SET createdAt=? WHERE id=?").run(new Date(Date.now() - 60000).toISOString(), older.id);
  app.store.db.query("UPDATE timeline SET createdAt=? WHERE id=?").run(new Date(Date.now() - 30000).toISOString(), newer.id);
  render(<App />);
  await screen.findByTitle("Recent responder · idle");
  const order = () => [...document.querySelectorAll(".sidebar nav .agent-row strong")].map(row => row.textContent);
  expect(order()).toEqual([recent.name, original.name, empty.name]);
  expect(screen.getByTitle(`${original.name} · idle`).getAttribute("aria-current")).toBe("page");
  app.service.emit(empty.id, null, "message", { role: "user", text: "A prompt must not bump this agent." });
  app.store.setStatus(empty.id, "running");
  app.service.emit(empty.id, null, "tool_started", { name: "read", toolCallId: "sort-test", args: {} });
  await screen.findByTitle("No replies yet · running");
  expect(order()).toEqual([recent.name, original.name, empty.name]);
  app.service.emit(empty.id, null, "message", { role: "assistant", text: "Newest response." });
  await waitFor(() => expect(order()).toEqual([empty.name, recent.name, original.name]));
  expect(screen.getByTitle(`${original.name} · idle`).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByLabelText("Find an agent")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Agent list menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Search" }));
  const search = screen.getByRole("dialog", { name: "Search" });
  fireEvent.change(within(search).getByLabelText("Find an agent"), { target: { value: "Recent" } });
  expect(within(search).getAllByRole("button").filter(b => b.classList.contains("agent-row")).map(b => b.querySelector("strong")?.textContent)).toEqual([recent.name]);
  expect(order()).toEqual([empty.name, recent.name, original.name]);
});

test("response ordering uses timestamps before IDs, breaks ties, and leaves the snapshot unchanged", async () => {
  const { sortAgentsByResponse } = await import("../src/client/agent-order");
  const app = await setup();
  const original = app.store.agents()[0]!;
  const agents = Object.freeze(["empty-1", "older", "tie-1", "tie-2", "empty-2"].map(id => ({ ...original, id })));
  const previews = {
    older: { text: "Older timestamp, larger ID", createdAt: "2026-01-01T00:00:00Z" },
    "tie-1": { text: "Same millisecond", createdAt: "2026-01-02T00:00:00Z" },
    "tie-2": { text: "Same millisecond", createdAt: "2026-01-02T00:00:00Z" },
  };
  const sorted = sortAgentsByResponse(agents, previews, { older: 99, "tie-1": 2, "tie-2": 3 });
  expect(sorted.map(agent => agent.id)).toEqual(["tie-2", "tie-1", "older", "empty-1", "empty-2"]);
  expect(agents.map(agent => agent.id)).toEqual(["empty-1", "older", "tie-1", "tie-2", "empty-2"]);
  expect(sortAgentsByResponse(agents, undefined, {}).map(agent => agent.id)).toEqual(agents.map(agent => agent.id));
  expect(sortAgentsByResponse(agents, { older: { text: "Invalid date", createdAt: "invalid" } }, {}).map(agent => agent.id)).toEqual(agents.map(agent => agent.id));
});

test("sidebar archive targets an unselected agent without opening it or losing the current draft", async () => {
  const app = await setup();
  const selected = app.store.agents()[0]!;
  const other = app.service.createAgent({ name: "Archive from sidebar", instructions: "Test", color: "#abc" });
  render(<App />);
  await waitForConnectedAgent();
  fireEvent.click(screen.getByTitle(`${selected.name} · idle`));
  const input = await screen.findByRole("textbox", { name: `Message ${selected.name}` });
  fireEvent.change(input, { target: { value: "Keep this draft" } });
  const archive = screen.getByRole("button", { name: `Archive ${other.name}` });
  expect(archive.closest(".agent-row-item")?.querySelector(".agent-row")?.contains(archive)).toBe(false);
  fireEvent.click(archive);
  await waitFor(() => expect(app.store.agent(other.id)?.archivedAt).toBeTruthy());
  await waitFor(() => expect(screen.queryByTitle(`${other.name} · idle`)).toBeNull());
  expect((screen.getByRole("textbox", { name: `Message ${selected.name}` }) as HTMLTextAreaElement).value).toBe("Keep this draft");
  expect(app.store.agent(selected.id)?.archivedAt).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: `Archive ${selected.name}` }));
  await screen.findByText("This agent is archived. Its profile and history are preserved.");
  expect(screen.queryByTitle(`${selected.name} · idle`)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Restore agent" }));
  await screen.findByTitle(`${selected.name} · idle`);
  expect((screen.getByRole("textbox", { name: `Message ${selected.name}` }) as HTMLTextAreaElement).value).toBe("Keep this draft");
});

test("sidebar archive works within projects and disables active agents", async () => {
  const app = await setup();
  const project = app.service.saveProject(null, { name: "Archive project", defaultCwd: dir! });
  const member = app.service.createAgent({ name: "Idle member", instructions: "Test", color: "#abc", projectId: project.id });
  const running = app.service.createAgent({ name: "Running member", instructions: "Test", color: "#abc", projectId: project.id });
  const waiting = app.service.createAgent({ name: "Waiting member", instructions: "Test", color: "#abc", projectId: project.id });
  app.store.setStatus(running.id, "running");
  app.store.setStatus(waiting.id, "waiting");
  render(<App />);
  await waitForConnectedAgent();
  await openInboxProject(project.name);
  await waitForConnectedAgent();
  const pane = screen.getByRole("navigation", { name: `${project.name} agents` });
  for (const agent of [running, waiting]) {
    const button = within(pane).getByRole("button", { name: `Archive ${agent.name}` });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(app.store.agent(agent.id)?.archivedAt).toBeNull();
  }
  fireEvent.click(within(pane).getByRole("button", { name: `Archive ${member.name}` }));
  await waitFor(() => expect(!!within(pane).queryByTitle(`${member.name} · idle`)).toBe(false));
  expect(app.store.agent(member.id)?.archivedAt).toBeTruthy();
});

test("sidebar archive disables pending actions and keeps failures retryable in the sidebar", async () => {
  const app = await setup();
  const selected = app.store.agents()[0]!;
  const other = app.service.createAgent({ name: "Retry archive", instructions: "Test", color: "#abc" });
  render(<App />);
  await waitForConnectedAgent();
  fireEvent.click(screen.getByTitle(`${selected.name} · idle`));
  await screen.findByRole("textbox", { name: `Message ${selected.name}` });
  const fetch = globalThis.fetch;
  let fail!: () => void;
  globalThis.fetch = ((input: any, init: any) => {
    if (input === `/api/agents/${other.id}/archive`)
      return new Promise<Response>((resolve) => {
        fail = () => resolve(new Response(JSON.stringify({ error: "Archive unavailable" }), { status: 503 }));
      });
    return fetch(input, init);
  }) as typeof fetch;
  fireEvent.click(screen.getByRole("button", { name: `Archive ${other.name}` }));
  await waitFor(() => expect(typeof fail).toBe("function"));
  for (const agent of [selected, other])
    expect(screen.getByRole("button", { name: `Archive ${agent.name}` }).hasAttribute("disabled")).toBe(true);
  fail();
  const sidebar = screen.getByRole("complementary", { name: "Agents" });
  await within(sidebar).findByText(`Could not archive ${other.name}: Archive unavailable`);
  expect(app.store.agent(other.id)?.archivedAt).toBeNull();
  expect(screen.getByRole("button", { name: `Archive ${other.name}` }).hasAttribute("disabled")).toBe(false);
  globalThis.fetch = fetch;
  fireEvent.click(screen.getByRole("button", { name: `Archive ${other.name}` }));
  await waitFor(() => expect(app.store.agent(other.id)?.archivedAt).toBeTruthy());
  expect(within(sidebar).queryByRole("alert")).toBeNull();
});

test("inbox menu contains archive, settings and theme, supports keyboard dismissal and survives live updates", async () => {
  const app = await setup();
  const agent = app.store.agents()[0]!;
  const archived = app.service.createAgent({ name: "Archived fixture", instructions: "Test", color: "#abc" });
  app.service.archiveAgent(archived.id, true);
  render(<App />);
  await waitForConnectedAgent();
  const trigger = screen.getByRole("button", { name: "Agent list menu" });
  expect(document.querySelector(".sidebar-bottom")).toBeNull();
  expect(screen.queryByText("Connected locally")).toBeNull();
  expect(screen.getByRole("button", { name: "Create agent" }).classList.contains("agent-create-fab")).toBe(true);
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const archive = screen.getByRole("menuitem", { name: "Archived agents" });
  const settings = screen.getByRole("menuitem", { name: "Settings" });
  const searchItem = screen.getByRole("menuitem", { name: "Search" });
  expect(document.activeElement === searchItem).toBe(true);
  fireEvent.keyDown(searchItem, { key: "ArrowDown" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement === archive).toBe(true);
  fireEvent.keyDown(archive, { key: "ArrowDown" });
  expect(document.activeElement === settings).toBe(true);
  app.service.emit(agent.id, null, "message", { role: "user", text: "A live update while the menu is open." });
  await screen.findByText("A live update while the menu is open.");
  expect(document.activeElement === settings).toBe(true);
  fireEvent.keyDown(settings, { key: "Escape" });
  expect(!!screen.queryByRole("menu")).toBe(false);
  expect(document.activeElement === trigger).toBe(true);
  fireEvent.keyDown(trigger, { key: "ArrowUp" });
  const target = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  const theme = screen.getByRole("menuitem", { name: `Switch to ${target} mode` });
  expect(document.activeElement === theme).toBe(true);
  fireEvent.click(theme);
  expect(document.documentElement.dataset.theme).toBe(target);
  expect(localStorage.getItem("jelly.theme")).toBe(target);
  expect(!!screen.queryByRole("menu")).toBe(false);
  expect(document.activeElement === trigger).toBe(true);
  fireEvent.click(trigger);
  fireEvent.pointerDown(screen.getByRole("heading", { name: "Agents" }));
  expect(!!screen.queryByRole("menu")).toBe(false);
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("menuitem", { name: "Archived agents" }));
  const dialog = await screen.findByRole("dialog", { name: "Archived agents" });
  await within(dialog).findByRole("button", { name: "Archived fixture" });
  expect(!!screen.queryByRole("menu")).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }));
  await waitFor(() => expect(!!screen.queryByRole("dialog")).toBe(false));
  expect(document.activeElement === trigger).toBe(true);
});

test("projects replace grouped agents at the inbox root and aggregate live attention without archived members", async () => {
  const app = await setup();
  const original = app.store.agents()[0]!;
  app.service.emit(original.id, null, "message", { role: "assistant", text: "Earlier unassigned reply." });
  const project = app.service.saveProject(null, { name: "Design team", defaultCwd: dir! });
  const member = app.service.createAgent({ name: "Designer", instructions: "Test", color: "#abc", projectId: project.id });
  const archived = app.service.createAgent({ name: "Archived designer", instructions: "Test", color: "#abc", projectId: project.id });
  app.service.archiveAgent(archived.id, true);
  app.store.setStatus(archived.id, "error");
  app.store.setStatus(member.id, "waiting");
  render(<App />);
  await waitForConnectedAgent();
  const root = screen.getByRole("navigation", { name: "Projects and agents" });
  expect(within(root).queryByTitle("Designer · waiting")).toBeNull();
  expect(screen.queryByLabelText("Find an agent")).toBeNull();
  expect(document.querySelector(".project-trigger")).toBeNull();
  const row = within(root).getByRole("button", { name: "Open project Design team" });
  const rootOrder = () => [...root.querySelectorAll(".agent-row strong")].map(node => node.textContent);
  expect(rootOrder()).toEqual([original.name, project.name]);
  expect(within(row).getByText("1 agent needs attention")).toBeDefined();
  expect(within(row).getByRole("img", { name: "Needs attention" })).toBeDefined();
  expect(row.querySelectorAll(".project-avatars img").length).toBe(3);
  app.store.setStatus(member.id, "idle");
  app.service.emit(member.id, null, "message", { role: "assistant", text: "Design is ready." });
  await within(row).findByText("1 agent");
  expect(rootOrder()).toEqual([project.name, original.name]);
  expect(within(row).queryByRole("img", { name: "Needs attention" })).toBeNull();
  expect(within(row).getByRole("img", { name: "Unread messages" })).toBeDefined();
  fireEvent.click(row);
  const child = screen.getByRole("navigation", { name: "Design team agents" });
  expect(within(child).getByTitle("Designer · idle")).toBeDefined();
  expect(within(child).queryByText("Archived designer")).toBeNull();
  expect(screen.getByRole("heading", { name: "Design team" })).toBeDefined();
  await backToInboxRoot();
  expect(screen.getByRole("heading", { name: "Agents" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Agent list menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Search" }));
  const search = screen.getByRole("dialog", { name: "Search" });
  fireEvent.change(within(search).getByLabelText("Find an agent"), { target: { value: "Designer" } });
  expect(within(search).queryByText("Archived designer")).toBeNull();
  fireEvent.click(within(search).getByTitle("Designer · idle"));
  await screen.findByRole("textbox", { name: "Message Designer" });
  expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
  expect(screen.getByRole("navigation", { name: "Design team agents" })).toBeDefined();
});

test("HTML attachments use isolated inline frames, including saved text metadata, and retain downloads", async () => {
  const app = await setup();
  const agent = app.store.agents()[0]!;
  const source = join(dir!, "preview.HTML");
  writeFileSync(source, '<h1>Rendered page</h1><script>window.stolen=true</script>');
  const html = await app.service.harness.files.save(source, dir!);
  expect(html.kind).toBe("text");
  app.store.event(agent.id, null, "message", { role: "user", text: "Show the page" });
  app.store.event(agent.id, null, "file_rendered", { files: [html] });
  const ui = render(<App />);
  const frame = await screen.findByTitle("HTML preview: preview.HTML");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("src")).toBe(html.url + "?inline=1");
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  const card = screen.getByRole("region", { name: "File: preview.HTML" });
  expect(card.querySelector("pre")).toBeNull();
  expect(card.querySelector("details")).toBeNull();
  expect(card.textContent).not.toContain("window.stolen");
  expect(within(card).getByRole("link", { name: "Download file" }).getAttribute("href")).toBe(html.url);
  ui.unmount();
  render(<App />);
  expect((await screen.findByTitle("HTML preview: preview.HTML")).getAttribute("sandbox")).toBe("allow-scripts");
});

test("project front avatar spins while any active member works, independently of attention", async () => {
  const app = await setup();
  const project = app.service.saveProject(null, { name: "Working team", defaultCwd: dir! });
  const members = ["One", "Two", "Waiting", "Archived"].map(name => app.service.createAgent({ name, instructions: "Test", color: "#abc", projectId: project.id }));
  app.service.archiveAgent(members[3]!.id, true);
  for (const member of members) app.store.setStatus(member.id, member.name === "Waiting" ? "idle" : "running");
  render(<App />);
  const row = await screen.findByRole("button", { name: "Open project Working team" });
  const spinning = () => !!row.querySelector(".project-avatar-front.is-working");
  expect(spinning()).toBe(true);
  expect(row.querySelectorAll(".project-avatars .is-working").length).toBe(1);
  expect(row.querySelector(".project-avatars")?.lastElementChild?.classList.contains("project-avatar-front")).toBe(true);
  expect(within(row).getByText("2 agents working")).toBeDefined();
  app.store.setStatus(members[0]!.id, "idle");
  app.service.emit(members[0]!.id, null, "run_completed", { status: "completed" });
  await within(row).findByText("1 agent working");
  expect(spinning()).toBe(true);
  app.store.setStatus(members[2]!.id, "waiting");
  app.service.emit(members[2]!.id, null, "status_changed", { status: "waiting" });
  await within(row).findByText("1 agent needs attention");
  expect(spinning()).toBe(true);
  expect(within(row).getByRole("img", { name: "Needs attention" })).toBeDefined();
  app.store.setStatus(members[1]!.id, "idle");
  app.service.emit(members[1]!.id, null, "run_completed", { status: "completed" });
  await waitFor(() => expect(spinning()).toBe(false));
  expect(within(row).getByRole("img", { name: "Needs attention" })).toBeDefined();
});

test("Markdown tables render semantic aligned cells and safe inline formatting beside paragraphs", async () => {
  const { MessageText } = await import("../src/client/MessageText");
  render(<MessageText text={'Before the table\n| Name | Status | Count |\n| :--- | :---: | ---: |\n| **Jelly** | `a|b` | 2 |\n| [Docs](https://example.com) | a\\|b | <img src=x onerror=alert(1)> |\nAfter the table'} />);
  const table = screen.getByRole("table");
  expect(within(table).getAllByRole("columnheader").map(cell => cell.style.textAlign)).toEqual(["left", "center", "right"]);
  expect(within(table).getAllByRole("row")).toHaveLength(3);
  expect(within(table).getByText("Jelly").tagName).toBe("STRONG");
  expect(within(table).getByText("a|b", { selector: "code" })).toBeDefined();
  expect(within(table).getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("https://example.com");
  expect(table.querySelector("img")).toBeNull();
  expect(within(table).getByText("<img src=x onerror=alert(1)>")).toBeDefined();
  expect(screen.getByText("Before the table").tagName).toBe("P");
  expect(screen.getByText("After the table").tagName).toBe("P");
  expect(table.parentElement?.getAttribute("tabindex")).toBe("0");
});

test("Markdown table parsing handles optional outer pipes, ragged rows, CRLF and single columns", async () => {
  const { MessageText } = await import("../src/client/MessageText");
  render(<MessageText text={'A | B\r\n--- | ---\r\n| one |\r\n| two | three | ignored |\r\n\r\n| Single |\n| --- |\n| value |'} />);
  const tables = screen.getAllByRole("table");
  expect(tables).toHaveLength(2);
  expect(within(tables[0]!).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["one", "", "two", "three"]);
  expect(within(tables[1]!).getByRole("cell").textContent).toBe("value");
});

test("Code fences, ordinary pipes and malformed separators are not Markdown tables", async () => {
  const { MessageText } = await import("../src/client/MessageText");
  render(<MessageText text={'```md\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```\n\nA | B\nnot | a separator\n\n| A | B |\n| --- |\n\nhello\n---'} />);
  expect(screen.queryByRole("table")).toBeNull();
  expect(document.querySelector(".code-block code")?.textContent).toContain("| --- | --- |");
});

test("render_file audio and video use native controls without autoplay, with download, retry and replay", async () => {
  const app = await setup();
  const { wavFixture, mp4Header } = await import("./fixtures/media");
  const agent = app.store.agents()[0]!;
  const audioPath = join(dir!, "sound.wav"), videoPath = join(dir!, "movie.mp4");
  writeFileSync(audioPath, wavFixture()); writeFileSync(videoPath, mp4Header());
  const audio = await app.service.harness.files.save(audioPath, dir!);
  const video = await app.service.harness.files.save(videoPath, dir!);
  app.store.event(agent.id, null, "message", { role: "user", text: "Show these media files" });
  app.store.event(agent.id, null, "file_rendered", { files: [audio, video] });
  const ui = render(<App />);
  const sound = await screen.findByLabelText("Audio: sound.wav");
  const movie = await screen.findByLabelText("Video: movie.mp4");
  expect(sound.tagName).toBe("AUDIO"); expect(movie.tagName).toBe("VIDEO");
  for (const element of [sound, movie]) {
    expect(element.hasAttribute("controls")).toBe(true);
    expect(element.hasAttribute("autoplay")).toBe(false);
    expect(element.getAttribute("preload")).toBe("metadata");
  }
  expect(movie.hasAttribute("playsinline")).toBe(true);
  const card = screen.getByRole("region", { name: "File: movie.mp4" });
  expect(within(card).getByRole("link", { name: "Download file" }).getAttribute("href")).toBe(video.url + "?download=1");
  fireEvent.error(movie);
  expect(within(card).getByRole("alert").textContent).toContain("could not be played");
  fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
  await within(card).findByLabelText("Video: movie.mp4");
  ui.unmount(); render(<App />);
  await screen.findByLabelText("Audio: sound.wav"); await screen.findByLabelText("Video: movie.mp4");
});

test("composer selects Claude before a run, shows adjacent provider/model/effort, and locks only provider afterward", async () => {
  const app = await setup();
  const id = app.store.agents()[0]!.id;
  render(<App />);
  await waitForConnectedAgent();
  const trigger = screen.getByRole("button", { name: "Model and effort" });
  expect(trigger.nextElementSibling?.className).toBe("composer-model-summary");
  expect(trigger.nextElementSibling?.textContent).toContain("GPT-6 Astra · Medium");
  fireEvent.click(trigger);
  const provider = screen.getByRole("combobox", { name: "Provider" }) as HTMLSelectElement;
  expect(provider.disabled).toBe(false);
  fireEvent.change(provider, { target: { value: "claude-code" } });
  await waitFor(() => {
    expect(app.store.agent(id)?.mode).toBe("claude-code");
    expect(provider.disabled).toBe(false);
  });
  const model = screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement;
  expect(model.value).toBe("claude-opus-5-5");
  expect(within(model).queryByRole("option", { name: "GPT-6 Astra" })).toBeNull();
  expect(within(model).getByRole("option", { name: "Claude Sonnet 5" })).toBeDefined();
  fireEvent.change(model, { target: { value: "claude-sonnet-5" } });
  await waitFor(() => expect(trigger.nextElementSibling?.textContent).toBe("Claude subscription · Claude Sonnet 5 · Medium"));
  await act(async () => {
    const run = app.store.createRun(id, "lock-claude-ui", "No live request", "claude-code", "claude-sonnet-5");
    app.store.finishRun(run.id, "failed", "Hermetic test");
    app.service.setMode("api");
  });
  await waitFor(() => expect(provider.disabled).toBe(true));
  expect(model.disabled).toBe(false);
  expect(screen.getByText(/Fresh Session keeps its context and provider/)).toBeDefined();
  expect(trigger.nextElementSibling?.textContent).toContain("Claude subscription");
  fireEvent.keyDown(model, { key: "Escape" });
  expect(document.activeElement).toBe(trigger);
  // The unrelated API default is ready, but this selected Claude agent is not.
  expect(screen.getByRole("button", { name: "Connect an account" })).toBeDefined();
  expect(screen.queryByLabelText("Message delivery")).toBeNull();
});

test("Claude Settings offers host CLI instructions and status refresh without OAuth or retargeting agents", async () => {
  const app = await setup();
  const id = app.store.agents()[0]!.id;
  app.service.setConfig({ agentId: id, mode: "api" });
  let refreshes = 0;
  app.service.harness.claude.refresh = async () => {
    refreshes++;
    return { claudeReady: true, claudeNotice: "Claude subscription fixture ready" };
  };
  render(<App />);
  await waitForConnectedAgent();
  fireEvent.click(screen.getByRole("button", { name: "Agent list menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Claude subscription" }));
  expect(await screen.findByText("Claude subscription fixture ready")).toBeDefined();
  expect(screen.getByText("claude auth login")).toBeDefined();
  expect(screen.getByText("PI_CLAUDE_CODE_COMMAND")).toBeDefined();
  expect(screen.queryByRole("link", { name: /Continue to Claude/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh Claude status" }));
  await waitFor(() => expect(refreshes).toBeGreaterThan(1));
  expect(app.store.agent(id)?.mode).toBe("api");
  expect(app.store.instance().mode).toBe("api");
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("button", { name: "ChatGPT" })).toBeDefined();
});
