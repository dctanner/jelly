await import("./dom");
import { test, expect, afterEach } from "bun:test";
const { render, screen, fireEvent, waitFor, cleanup, act } =
  await import("@testing-library/react");
import {
  ChromeConnection,
  type ChromeStatus,
} from "../src/client/ChromeConnection";
import { InterventionCard } from "../src/client/InterventionCard";
import type { Snapshot, Intervention } from "../src/shared/types";
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
function transport(task: ChromeStatus["task"] = null) {
  const calls: { path: string; body: any }[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    calls.push({
      path: input,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (input.includes("control-session"))
      return Response.json({ csrf: "fixture" });
    if (input.includes("/chrome?"))
      return Response.json({
        profiles: [
          { id: "profile-one", generation: "fixture", connected: true },
        ],
        task,
      });
    return Response.json({ ok: true });
  }) as typeof fetch;
  return calls;
}
test("Chrome handoff and metadata controls remain unavailable during Resume and failed pause", async () => {
  for (const state of [
    "paused",
    "resuming",
    "failed",
    "disconnected",
  ] as const) {
    transport({
      ...readyTask(),
      pauseState: state,
      paused: state === "paused",
      connected: state !== "disconnected",
    });
    render(
      <ChromeConnection
        data={
          {
            selectedAgentId: "agent",
            config: { browserTarget: "chrome" },
          } as Snapshot
        }
        refresh={async () => {}}
      />,
    );
    await screen.findByText("This agent’s pinned Chrome session");
    for (const name of ["Keep as deliverable", "Retain for follow-up handoff"])
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
    if (state !== "paused")
      expect(
        (
          screen.getByRole("button", {
            name: "Open in Chrome",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    cleanup();
  }
  transport({ ...readyTask(), pauseState: "resuming", paused: false });
  render(
    <InterventionCard
      item={chromeLogin}
      onComputer={() => {}}
      onChange={() => {}}
    />,
  );
  await screen.findByText("Resuming—do not enter credentials.");
  expect(
    (
      screen.getByRole("button", {
        name: "Return control to agent",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("packaged Chrome popup discards stale status during local Pause and clears safety indicators on failure", async () => {
  const root = document.createElement("div");
  root.innerHTML = `
    <p id="status"></p><ul id="tasks"></ul>
    <select id="session"></select><select id="tab"></select>
    <button id="connect"></button><button id="pause"></button>
    <button id="disconnect"></button><button id="grant"></button>`;
  document.body.append(root);
  const stale = pendingGate(),
    ack = pendingGate();
  let delivered = false;
  const api = {
    runtime: {
      sendMessage: async ({ action }: { action: string }) => {
        if (action === "pause") {
          await ack.promise;
          return { error: "Unavailable" };
        }
        await stale.promise;
        delivered = true;
        return {
          connected: true,
          sessions: [{ id: "session", name: "Fixture", tabs: 1, paused: true }],
        };
      },
    },
  };
  try {
    const script = await Bun.file(
      `${import.meta.dir}/../extensions/chrome/popup.js`,
    ).text();
    // Execute the actual packaged popup with a bounded fake local transport.
    new Function("chrome", "document", "setInterval", "Option", script)(
      api,
      document,
      () => 0,
      function Option(text: string, value: string) {
        const option = document.createElement("option");
        option.textContent = text;
        option.value = value;
        return option;
      },
    );
    fireEvent.click(document.getElementById("pause")!);
    expect(root.querySelector("#status")!.textContent).toContain("Pausing");
    stale.release();
    await waitFor(() => expect(delivered).toBe(true));
    expect(root.querySelector("#status")!.textContent).toContain("Pausing");
    expect(root.querySelector("#tasks")!.textContent).toBe("");
    ack.release();
    await waitFor(() =>
      expect(root.querySelector("#status")!.textContent).toContain(
        "do not enter credentials",
      ),
    );
    expect(root.querySelector("#tasks")!.textContent).toBe("");
  } finally {
    stale.release();
    ack.release();
    root.remove();
  }
});
test("Chrome target UI saves explicit profile/site scope separately and describes experimental limits", async () => {
  const calls = transport();
  const data = {
    config: { browserTarget: "managed", chromeProfile: "", chromeOrigins: [] },
    selectedAgentId: "agent",
  } as unknown as Snapshot;
  render(<ChromeConnection data={data} refresh={async () => {}} />);
  expect(
    (screen.getByLabelText("Browser target") as HTMLSelectElement).value,
  ).toBe("managed");
  await screen.findByRole("option", { name: "profile-one · connected" });
  fireEvent.change(screen.getByLabelText("Browser target"), {
    target: { value: "chrome" },
  });
  fireEvent.change(screen.getByLabelText("Chrome profile"), {
    target: { value: "profile-one" },
  });
  fireEvent.change(
    screen.getByLabelText("Approved exact HTTPS origins (one per line)"),
    { target: { value: "https://example.com" } },
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Save browser target and site scope" }),
  );
  await waitFor(() =>
    expect(calls.find((c) => c.path === "/api/chrome/settings")?.body).toEqual({
      browserTarget: "chrome",
      chromeProfile: "profile-one",
      chromeOrigins: ["https://example.com"],
      chromeSiteScope: "approved",
    }),
  );
  expect(screen.getByText(/not a network sandbox/i)).toBeTruthy();
});
test("Chrome target UI saves unrestricted internet without an origin list", async () => {
  const calls = transport();
  render(
    <ChromeConnection
      data={{ config: {}, selectedAgentId: "agent" } as Snapshot}
      refresh={async () => {}}
    />,
  );
  await screen.findByRole("option", { name: "profile-one · connected" });
  fireEvent.change(screen.getByLabelText("Browser target"), {
    target: { value: "chrome" },
  });
  fireEvent.change(screen.getByLabelText("Chrome profile"), {
    target: { value: "profile-one" },
  });
  fireEvent.change(screen.getByLabelText("Site access"), {
    target: { value: "internet" },
  });
  expect(
    screen.queryByLabelText("Approved exact HTTPS origins (one per line)"),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Save browser target and site scope" }),
  );
  await waitFor(() =>
    expect(calls.find((c) => c.path === "/api/chrome/settings")?.body).toEqual({
      browserTarget: "chrome",
      chromeProfile: "profile-one",
      chromeOrigins: [],
      chromeSiteScope: "internet",
    }),
  );
});
test("Connected Chrome private handoff retains local controls without automatically opening VNC or storing passwords", async () => {
  const calls = transport(readyTask());
  let vnc = false;
  const item = {
    id: "handoff",
    agentId: "agent",
    runId: "run",
    kind: "browser_login",
    status: "pending",
    payload: {
      browserTarget: "chrome",
      url: "https://example.com",
      reason: "Sign in privately",
    },
    result: null,
    createdAt: "",
    expiresAt: "",
  } as Intervention;
  const { container } = render(
    <InterventionCard
      item={item}
      onComputer={() => {
        vnc = true;
      }}
      onChange={() => {}}
    />,
  );
  expect(container.querySelector(".chat-form-card")).toBeTruthy();
  expect(container.querySelector('input[type="password"]')).toBeNull();
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Open in Chrome",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open in Chrome" }));
  await waitFor(() =>
    expect(calls.some((c) => c.path === "/api/chrome/focus")).toBe(true),
  );
  expect(vnc).toBe(false);
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Return control to agent",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Return control to agent" }),
  );
  await waitFor(() =>
    expect(calls.some((c) => c.path === "/api/chrome/resume")).toBe(true),
  );
});

function readyTask(): NonNullable<ChromeStatus["task"]> {
  return {
    profile: "profile-one",
    connected: true,
    paused: true,
    pauseState: "paused",
    active: "tab",
    tabs: ["tab"],
    handoff: "handoff",
    origins: ["https://example.com"],
  };
}
const chromeLogin = {
  id: "handoff",
  agentId: "agent",
  runId: "run",
  kind: "browser_login",
  status: "pending",
  payload: {
    browserTarget: "chrome",
    url: "https://example.com",
    reason: "Sign in privately",
  },
  result: null,
  createdAt: "",
  expiresAt: "",
} as Intervention;

test("Connected Chrome handoff disables private controls until the reserved tab pause is acknowledged", async () => {
  const task = {
    ...readyTask(),
    paused: false,
    pauseState: "pausing" as const,
    handoff: null,
  } as NonNullable<ChromeStatus["task"]>;
  const calls = transport(task);
  render(
    <InterventionCard
      item={chromeLogin}
      onComputer={() => {
        throw new Error("Must not automatically open a viewer");
      }}
      onChange={() => {}}
    />,
  );
  expect(screen.getByText("Pausing—do not enter credentials yet")).toBeTruthy();
  expect(screen.queryByText("Private sign-in")).toBeNull();
  for (const name of ["Open in Chrome", "Return control to agent"]) {
    expect(
      (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name }));
  }
  expect(calls.some((c) => /chrome\/(focus|resume)$/.test(c.path))).toBe(false);
  // An acknowledged DIFFERENT handoff is not permission to enter credentials.
  Object.assign(task, readyTask(), { handoff: "other-request" });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1100));
  });
  expect(
    (
      screen.getByRole("button", {
        name: "Open in Chrome",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  task.handoff = "handoff";
  await waitFor(
    () =>
      expect(
        (
          screen.getByRole("button", {
            name: "Open in Chrome",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    { timeout: 3000 },
  );
  expect(screen.getByText(/debugger detached/)).toBeTruthy();
});

test("Connected Chrome private handoff distinguishes failed pause and disconnect from acknowledgement", async () => {
  for (const pauseState of ["failed", "disconnected"] as const) {
    const calls = transport({
      ...readyTask(),
      paused: false,
      pauseState,
      connected: pauseState !== "disconnected",
    });
    render(
      <InterventionCard
        item={chromeLogin}
        onComputer={() => {}}
        onChange={() => {}}
      />,
    );
    await screen.findByText(
      pauseState === "failed"
        ? "Pause failed—do not enter credentials."
        : "Chrome disconnected or unavailable—do not enter credentials.",
    );
    expect(screen.queryByText(/debugger detached/)).toBeNull();
    for (const name of ["Open in Chrome", "Return control to agent"]) {
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
      fireEvent.click(screen.getByRole("button", { name }));
    }
    expect(calls.some((c) => /chrome\/(focus|resume)$/.test(c.path))).toBe(
      false,
    );
    cleanup();
  }
});

function pendingGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("Chrome settings discard a stale paused poll after Resume and clear safe status immediately", async () => {
  const gate = pendingGate();
  const resumeGate = pendingGate();
  let reads = 0;
  let resumed = false;
  globalThis.fetch = (async (input: string) => {
    if (input.includes("control-session"))
      return Response.json({ csrf: "fixture" });
    if (input.endsWith("/chrome/resume")) {
      await resumeGate.promise;
      resumed = true;
      return Response.json({ ok: true });
    }
    const task = {
      ...readyTask(),
      paused: !resumed,
      pauseState: resumed ? "active" : "paused",
    };
    if (++reads === 2) await gate.promise;
    return Response.json({ profiles: [], task });
  }) as typeof fetch;
  try {
    render(
      <ChromeConnection
        data={{ config: {}, selectedAgentId: "agent" } as unknown as Snapshot}
        refresh={async () => {}}
      />,
    );
    await screen.findByText(/profile-one · Paused/);
    await waitFor(() => expect(reads).toBe(2), { timeout: 4000 });
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(screen.queryByText(/profile-one · Paused/)).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Open in Chrome",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    resumeGate.release();
    await screen.findByText(/profile-one · Connected/);
    await act(async () => {
      gate.release();
      await gate.promise;
    });
    expect(screen.queryByText(/profile-one · Paused/)).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Open in Chrome",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  } finally {
    gate.release();
    resumeGate.release();
  }
}, 8000);

test("Chrome settings never reuse another agent's paused status while its request is pending", async () => {
  const gate = pendingGate();
  let requested = false;
  globalThis.fetch = (async (input: string) => {
    if (input.includes("control-session"))
      return Response.json({ csrf: "fixture" });
    const second = input.includes("agentId=second");
    if (second) {
      requested = true;
      await gate.promise;
    }
    return Response.json({
      profiles: [],
      task: {
        ...readyTask(),
        paused: !second,
        pauseState: second ? "active" : "paused",
      },
    });
  }) as typeof fetch;
  const data = { config: {}, selectedAgentId: "first" } as unknown as Snapshot;
  try {
    const view = render(
      <ChromeConnection data={data} refresh={async () => {}} />,
    );
    await screen.findByText(/profile-one · Paused/);
    view.rerender(
      <ChromeConnection
        data={{ ...data, selectedAgentId: "second" }}
        refresh={async () => {}}
      />,
    );
    expect(screen.queryByText(/profile-one · Paused/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Open in Chrome" })).toBeNull();
    await waitFor(() => expect(requested).toBe(true));
    gate.release();
    await screen.findByText(/profile-one · Connected/);
  } finally {
    gate.release();
  }
});

test("Chrome settings clear human-safe status when polling fails", async () => {
  let reads = 0;
  globalThis.fetch = (async (input: string) => {
    if (input.includes("control-session"))
      return Response.json({ csrf: "fixture" });
    if (++reads > 1) throw new Error("offline");
    return Response.json({ profiles: [], task: readyTask() });
  }) as typeof fetch;
  render(
    <ChromeConnection
      data={{ config: {}, selectedAgentId: "agent" } as unknown as Snapshot}
      refresh={async () => {}}
    />,
  );
  await screen.findByText(/profile-one · Paused/);
  await screen.findByText(
    "Chrome status unavailable—do not enter credentials.",
    {},
    { timeout: 4000 },
  );
  expect(screen.queryByText(/profile-one · Paused/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Open in Chrome" })).toBeNull();
}, 6000);

test("Chrome settings display draining rather than Paused while pause control awaits acknowledgement", async () => {
  const task = {
    ...readyTask(),
    paused: false,
    pauseState: "active" as const,
  } as NonNullable<ChromeStatus["task"]>;
  transport(task);
  const base = globalThis.fetch;
  let acknowledge!: () => void;
  const ack = new Promise<void>((r) => {
    acknowledge = r;
  });
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/chrome/pause") {
      await ack;
      Object.assign(task, readyTask());
      return Response.json({ ok: true });
    }
    return base(input, init);
  }) as typeof fetch;
  render(
    <ChromeConnection
      data={{ config: {}, selectedAgentId: "agent" } as unknown as Snapshot}
      refresh={async () => {}}
    />,
  );
  const pause = await screen.findByRole("button", { name: "Pause" });
  expect(
    (
      screen.getByRole("button", {
        name: "Open in Chrome",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(pause);
  expect(screen.getByText(/Pausing—do not enter credentials yet/)).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "Open in Chrome",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Resume" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  acknowledge();
  await waitFor(() =>
    expect(screen.getByText(/profile-one · Paused/)).toBeTruthy(),
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Open in Chrome",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
