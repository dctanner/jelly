await import("./dom");
import { test, expect, afterEach } from "bun:test";
const { render, screen, fireEvent, waitFor, cleanup } =
  await import("@testing-library/react");
import { ComputerControlPanel } from "../src/client/ComputerControlPanel";
import type { ChromeShareState } from "../src/shared/chrome-share";
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
const idle: ChromeShareState = {
  status: "idle",
  owned: false,
  profile: null,
  agentId: null,
  generation: 0,
  error: null,
};
function transport(state = idle, available = true) {
  const calls: { path: string; body: any }[] = [];
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    calls.push({
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (path.endsWith("/control-session"))
      return Response.json({ csrf: "test" });
    if (path.includes("/chrome?"))
      return Response.json({
        selectedProfile: "configured-but-not-pinned",
        profiles: [
          {
            id: "pinned-profile",
            generation: "native-generation",
            connected: true,
            desktopAvailable: available,
          },
        ],
        task: { profile: "pinned-profile" },
      });
    if (path.endsWith("/chrome/share")) return Response.json(state);
    if (path.endsWith("/release")) return Response.json(idle);
    throw new Error(`Unexpected capture/managed request: ${path}`);
  }) as typeof fetch;
  return calls;
}
test("pinned Chrome viewer opens an informational full-desktop ChatFormCard, never managed startup or automatic tickets", async () => {
  const calls = transport();
  const { container } = render(
    <ComputerControlPanel agentId="agent" onClose={() => {}} onChange={() => {}} />,
  );
  await screen.findByRole("heading", {
    name: "Use the computer",
  });
  expect(container.querySelector(".chat-form-card")).toBeTruthy();
  expect(
    screen.getByText(
      /Full computer access, including other windows and notifications/,
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Take control" })).toBeTruthy();
  expect(
    calls.some((c) => /computer\/start|\/ticket|\/take/.test(c.path)),
  ).toBe(false);
  expect(container.querySelector("canvas")).toBeNull();
  expect(container.querySelector<HTMLElement>(".chrome-share-viewer")?.hidden).toBe(true);
  // Layout chrome is allowed before Take, but keyboard and clipboard input are not.
  expect(container.querySelector('.computer-keyboard, .computer-clipboard')).toBeNull();
  expect(container.querySelector('input[type="password"]')).toBeNull();
});
test("unsupported pinned computer reports unavailable without a local-machine path or fallback", async () => {
  const calls = transport(idle, false);
  render(
    <ComputerControlPanel agentId="agent" onClose={() => {}} onChange={() => {}} />,
  );
  await screen.findByText(/Remote control is unavailable/);
  expect(
    (screen.getByRole("button", { name: "Take control" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    screen.queryByText(/Open in Chrome|VNC/),
  ).toBeNull();
  expect(
    calls.some((c) => /computer\/start|\/ticket|\/take/.test(c.path)),
  ).toBe(false);
});
test("zero paired profiles can explicitly Take the installed owned desktop without a transcript secret form", async () => {
  const calls: { path: string; body: any }[] = [];
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path.endsWith("/control-session")) return Response.json({ csrf: "fixture" });
    if (path.includes("/chrome?")) return Response.json({ profiles: [], task: null });
    if (path.endsWith("/chrome/share")) return Response.json({ ...idle, ownedDesktopAvailable: true });
    if (path.endsWith("/take-owned")) return Response.json({ ...idle, owned: true, status: "pausing", ownedDesktopAvailable: true });
    throw new Error("Unexpected bootstrap request");
  }) as typeof fetch;
  const { container } = render(<ComputerControlPanel onClose={() => {}} onChange={() => {}} />);
  await screen.findByText(/installed computer is available/);
  const button = screen.getByRole("button", { name: "Take control" });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(calls.some(c => /take-owned|ticket|computer\/start/.test(c.path))).toBe(false);
  expect(container.querySelector('input[type="password"]')).toBeNull();
  fireEvent.click(button);
  await waitFor(() => expect(calls.some(c => c.path.endsWith("/take-owned"))).toBe(true));
  expect(calls.find(c => c.path.endsWith("/take-owned"))?.body).toEqual({});
});
test("global disconnected configuration can explicitly choose the installed computer without silently retargeting", async () => {
  const calls = transport({ ...idle, ownedDesktopAvailable: true }, false);
  const base = globalThis.fetch;
  globalThis.fetch = (async (path, init) => {
    if (String(path).includes("/chrome?"))
      return Response.json({ selectedProfile: "disconnected-config", profiles: [], task: null });
    return base(path, init);
  }) as typeof fetch;
  render(<ComputerControlPanel onClose={() => {}} onChange={() => {}} />);
  const choose = await screen.findByRole("button", { name: "Use installed computer" });
  expect((screen.getByRole("button", { name: "Take control" }) as HTMLButtonElement).disabled).toBe(true);
  expect(calls.some(c => /\/take/.test(c.path))).toBe(false);
  fireEvent.click(choose);
  fireEvent.click(screen.getByRole("button", { name: "Take control" }));
  await waitFor(() => expect(calls.find(c => c.path.endsWith("/take-owned"))?.body).toEqual({}));
});

test("non-owner never obtains pixels, control or recovery actions", async () => {
  const calls = transport({
    ...idle,
    status: "sharing",
    profile: "private",
    agentId: "agent",
    generation: 8,
  });
  const { container } = render(
    <ComputerControlPanel agentId="agent" onClose={() => {}} onChange={() => {}} />,
  );
  await screen.findByText(/computer viewer is open in another control session/);
  expect(
    screen.queryByRole("button", {
      name: /take control|Return control|Reconnect|Recover/,
    }),
  ).toBeNull();
  expect(container.querySelector("canvas")).toBeNull();
  expect(calls.some((c) => /\/ticket|\/take|\/release/.test(c.path))).toBe(
    false,
  );
});
test("orphan cleanup uses an explicit cleanup-only action without requesting a viewer or resuming old tasks", async () => {
  const calls = transport({ ...idle, status: "orphaned", generation: 7 });
  render(
    <ComputerControlPanel agentId="agent" onClose={() => {}} onChange={() => {}} />,
  );
  const action = await screen.findByRole("button", {
    name: "Retry cleanup",
  });
  expect(calls.some((c) => /\/ticket|\/take|\/release/.test(c.path))).toBe(
    false,
  );
  fireEvent.click(action);
  await waitFor(() =>
    expect(calls.find((c) => c.path.endsWith("/release"))?.body).toEqual({
      generation: 7,
      cleanupOnly: true,
    }),
  );
  expect(calls.some((c) => /\/ticket|\/take|\/resume/.test(c.path))).toBe(
    false,
  );
});

test("one direct Take control action sends no extra approval token, checkbox or dialog", async () => {
  const calls = transport();
  const { container } = render(
    <ComputerControlPanel agentId="agent" onClose={() => {}} onChange={() => {}} />,
  );
  const take = await screen.findByRole("button", { name: "Take control" });
  expect(calls.some((c) => c.path.endsWith("/take"))).toBe(false);
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  fireEvent.click(take);
  await waitFor(() =>
    expect(calls.find((c) => c.path.endsWith("/take"))?.body).toEqual({
      agentId: "agent",
      profile: "pinned-profile",
      profileGeneration: "native-generation",
    }),
  );
  expect(calls.some((c) => c.body?.confirm !== undefined)).toBe(false);
});

test("owned availability never silently changes an agent’s pinned computer", async () => {
  const calls = transport({ ...idle, ownedDesktopAvailable: true }, false);
  render(<ComputerControlPanel agentId="agent" onClose={() => {}} onChange={() => {}} />);
  await screen.findByText(/Remote control is unavailable/);
  expect((screen.getByRole("button", { name: "Take control" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("combobox", { name: "Desktop source" })).toBeNull();
  expect(calls.some(c => c.path.endsWith("/take-owned"))).toBe(false);
});

test("closing an owned disconnected viewer sends Done, permits dismissal after cleanup failure and keeps retry available", async () => {
  const calls = transport({ ...idle, status: "disconnected", owned: true, generation: 6 });
  const base = globalThis.fetch;
  globalThis.fetch = (async (path, init) => {
    if (String(path).endsWith("/release")) {
      calls.push({ path: String(path), body: JSON.parse(String(init?.body)) });
      return Response.json({ error: "Viewer cleanup needs repair." }, { status: 409 });
    }
    return base(path, init);
  }) as typeof fetch;
  let closed = false;
  render(<ComputerControlPanel agentId="agent" onClose={() => { closed = true; }} onChange={() => {}} />);
  await screen.findByRole("button", { name: "Done" });
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  await waitFor(() => expect(closed).toBe(true));
  expect(calls.find(c => c.path.endsWith("/release"))?.body).toEqual({ generation: 6, cleanupOnly: false });
  expect(screen.getByText(/Browser agents can continue/)).toBeTruthy();
});

test("global and agent entry display the same active computer, never an alternative target", async () => {
  for (const agentId of [undefined, "other-agent"]) {
    const calls = transport({ ...idle, status: "disconnected", owned: true, profile: "active-global-computer", agentId: "original-context", generation: 9 });
    const view = render(<ComputerControlPanel agentId={agentId} onClose={() => {}} onChange={() => {}} />);
    await screen.findByRole("button", { name: "Done" });
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    expect(calls.some(c => c.path.endsWith("/take-owned") || c.path.endsWith("/take"))).toBe(false);
    view.unmount();
    await waitFor(() => expect(calls.find(c => c.path.endsWith("/release"))?.body).toEqual({ generation: 9, cleanupOnly: false }));
  }
});

test("stale panel actions stay bound to the displayed Take rather than fetching replacement authority", async () => {
  for (const action of ["Done", "Reconnect", "unmount"]) {
    const displayed = { ...idle, status: "disconnected" as const, owned: true, generation: 8, controlId: "old-take" };
    const calls = transport(displayed);
    const view = render(<ComputerControlPanel onClose={() => {}} onChange={() => {}} />);
    await screen.findByRole("button", { name: "Done" });
    const initialReads = calls.filter(c => c.path.endsWith("/chrome/share")).length;
    // The backing state now represents a replacement not yet shown to this panel.
    displayed.generation = 99; displayed.controlId = "replacement";
    if (action === "unmount") view.unmount();
    else fireEvent.click(screen.getByRole("button", { name: action }));
    const route = action === "Reconnect" ? "/reconnect" : "/release";
    await waitFor(() => expect(calls.find(c => c.path.endsWith(route))?.body).toMatchObject({
      generation: 8, controlId: "old-take",
    }));
    // Post-action refresh is fine; there must be no pre-action authority fetch.
    const index = calls.findIndex(c => c.path.endsWith(route));
    expect(calls.slice(0, index).filter(c => c.path.endsWith("/chrome/share")).length).toBe(initialReads);
    view.unmount();
    await Bun.sleep(0); // Drain best-effort unmount requests before swapping transport.
  }
});

test("agent browser recovery stays collapsed and separate from global computer control", async () => {
  const calls = transport();
  render(<ComputerControlPanel agentId="agent" onClose={() => {}} onChange={() => {}} />);
  const advanced = await screen.findByText("Advanced");
  expect(advanced.closest("details")?.open).toBe(false);
  fireEvent.click(advanced);
  expect(screen.getByText("This agent’s browser session")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close session" }));
  await waitFor(() => expect(calls.find(c => c.path.endsWith("/chrome/close"))?.body).toEqual({ agentId: "agent" }));
  expect(calls.some(c => c.path.endsWith("/release"))).toBe(false);
});
