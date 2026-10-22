await import("./dom");
import { test, expect, afterEach } from "bun:test";
const { render, screen, fireEvent, waitFor, cleanup } =
  await import("@testing-library/react");
import {
  ChromeConnection,
  type ChromeStatus,
} from "../src/client/ChromeConnection";
import { InterventionCard } from "../src/client/InterventionCard";
import { Settings } from "../src/client/Settings";
import { AgentDetails } from "../src/client/App";
import type { Snapshot, Intervention, AgentRecord } from "../src/shared/types";
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
const login = {
  id: "handoff",
  agentId: "agent",
  runId: "run",
  kind: "browser_login",
  status: "pending",
  payload: { url: "https://example.com", reason: "Sign in" },
  result: null,
  createdAt: "",
  expiresAt: "",
} as Intervention;
function transport(task: ChromeStatus["task"] = null) {
  const calls: { path: string; body: any }[] = [];
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    calls.push({
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (path.includes("control-session"))
      return Response.json({ csrf: "fixture" });
    if (path.includes("/chrome?"))
      return Response.json({
        selectedProfile: "global",
        profiles: [
          {
            id: "global",
            generation: "global-generation",
            connected: true,
            desktopAvailable: true,
          },
          {
            id: "pinned",
            generation: "pinned-generation",
            connected: true,
            desktopAvailable: true,
          },
        ],
        task: path.includes("agentId=agent") ? task : null,
      });
    if (path.endsWith("/chrome/share"))
      return Response.json({
        status: "idle",
        owned: false,
        generation: 0,
        profile: null,
        agentId: null,
        error: null,
      });
    return Response.json({ ok: true });
  }) as typeof fetch;
  return calls;
}
const task = {
  profile: "pinned",
  connected: true,
  humanUsing: true,
  paused: false,
  pauseState: "active",
  tabs: ["tab"],
  active: "tab",
  handoff: "handoff",
  origins: [],
} as NonNullable<ChromeStatus["task"]>;
const data = {
  config: { mode: "auto", selectedModel: "gpt-5.4", effort: "high" },
  selectedAgentId: null,
  instance: { id: "instance" },
  projects: [],
  agents: [],
} as unknown as Snapshot;

test("Connected Chrome configuration keeps only profile/site settings and the shared computer entry", async () => {
  const calls = transport(task);
  render(
    <ChromeConnection
      data={{ ...data, selectedAgentId: "agent" }}
      refresh={async () => {}}
    />,
  );
  await screen.findByText("Advanced session settings");
  for (const name of [
    /^Pause$/,
    /^Resume$/,
    /Disconnect/,
    /Open in Chrome/,
    /deliverable/,
    /Retain for/,
    /VNC/,
  ])
    expect(screen.queryByRole("button", { name })).toBeNull();
  fireEvent.change(screen.getByLabelText("Chrome profile"), {
    target: { value: "global" },
  });
  fireEvent.change(screen.getByLabelText("Site access"), {
    target: { value: "internet" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save Chrome profile and site scope" }),
  );
  await waitFor(() =>
    expect(
      calls.find((c) => c.path.endsWith("/chrome/settings"))?.body,
    ).toEqual({
      chromeProfile: "global",
      chromeOrigins: [],
      chromeSiteScope: "internet",
    }),
  );
  expect(screen.queryByLabelText("Browser target")).toBeNull();
  expect(screen.getByRole("button", { name: "Computer control" })).toBeTruthy();
});

test("Done remains available for disconnected/stale human-use and sends the bound request ID without secrets", async () => {
  const calls = transport({
    ...task,
    connected: false,
    pauseState: "disconnected",
  });
  const { container } = render(
    <InterventionCard item={login} onChange={() => {}} />,
  );
  expect(container.querySelector(".chat-form-card")).toBeTruthy();
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(screen.getByText(/Other browser work may continue/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open in Chrome" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(calls.find((c) => c.path.endsWith("/chrome/done"))?.body).toEqual({
      agentId: "agent",
      handoff: "handoff",
    }),
  );
  expect(calls.some((c) => /chrome\/(pause|resume|focus)/.test(c.path))).toBe(
    false,
  );
  expect(calls.some((c) => c.path.includes("/desktop"))).toBe(false);
});

test("a stale sign-in card surfaces the identity conflict without marking a newer request complete", async () => {
  transport();
  const base = globalThis.fetch;
  globalThis.fetch = (async (path, init) =>
    String(path).endsWith("/chrome/done")
      ? Response.json(
          { error: "This browser request is no longer current." },
          { status: 409 },
        )
      : base(path, init)) as typeof fetch;
  render(<InterventionCard item={login} onChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await screen.findByText("This browser request is no longer current.");
  expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
});

test("global Settings and agent menu open the same Computer control options with correct profile context", async () => {
  for (const entry of ["global", "agent", "browser-settings"] as const) {
    const calls = transport(task);
    if (entry === "global")
      render(
        <Settings
          data={data}
          theme="system"
          setTheme={() => {}}
          onClose={() => {}}
          refresh={async () => {}}
        />,
      );
    else if (entry === "agent")
      render(
        <AgentDetails
          agent={
            {
              id: "agent",
              name: "Agent",
              status: "idle",
              color: "#123456",
            } as AgentRecord
          }
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
    else render(<ChromeConnection data={data} refresh={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Computer control" }));
    await screen.findByRole("dialog", { name: "Computer control" });
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Take control",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(screen.getByText(/Browser agents may continue/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/take"))?.body).toEqual(
        entry === "agent"
          ? {
              agentId: "agent",
              profile: "pinned",
              profileGeneration: "pinned-generation",
            }
          : { profile: "global", profileGeneration: "global-generation" },
      ),
    );
    expect(calls.some((c) => /\/desktop|\/computer\/start/.test(c.path))).toBe(
      false,
    );
    cleanup();
  }
});

test("packaged popup has no human pause control and ignores stale reads during explicit Disconnect", async () => {
  const root = document.createElement("div");
  root.innerHTML =
    '<p id="status"></p><ul id="tasks"></ul><button id="connect"></button><button id="disconnect"></button>';
  document.body.append(root);
  let release!: () => void;
  const stale = new Promise<void>((r) => {
    release = r;
  });
  const script = await Bun.file(
    `${import.meta.dir}/../extensions/chrome/popup.js`,
  ).text();
  try {
    new Function("chrome", "document", "setInterval", script)(
      {
        runtime: {
          sendMessage: async ({ action }: { action: string }) => {
            if (action === "status") {
              await stale;
              return { connected: true };
            }
            return { optedOut: true };
          },
        },
      },
      document,
      () => 0,
    );
    fireEvent.click(document.getElementById("disconnect")!);
    await waitFor(() =>
      expect(root.querySelector("#status")!.textContent).toContain(
        "automatic connection is off",
      ),
    );
    release();
    await Bun.sleep(10);
    expect(root.querySelector("#status")!.textContent).toContain(
      "automatic connection is off",
    );
    const html = await Bun.file(
      `${import.meta.dir}/../extensions/chrome/popup.html`,
    ).text();
    expect(html).not.toContain('id="pause"');
    expect(html).toContain("Human use does not pause");
  } finally {
    release();
    root.remove();
  }
});
