await import("./dom");
import { test, expect, afterEach } from "bun:test";
const { render, screen, fireEvent, waitFor, cleanup } =
  await import("@testing-library/react");
import { ChromeSharePanel } from "../src/client/ChromeSharePanel";
import { BrowserPanel } from "../src/client/BrowserPanel";
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
        browserTarget: "chrome",
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
    <BrowserPanel agentId="agent" onClose={() => {}} onChange={() => {}} />,
  );
  await screen.findByRole("heading", {
    name: "Take control of Connected Chrome",
  });
  expect(container.querySelector(".chat-form-card")).toBeTruthy();
  expect(
    screen.getByText(
      /Other windows, accounts, notifications and unrelated private content/,
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Take control" })).toBeTruthy();
  expect(
    calls.some((c) => /computer\/start|\/ticket|\/take/.test(c.path)),
  ).toBe(false);
  expect(container.querySelector("canvas")).toBeNull();
  expect(container.querySelector('input[type="password"]')).toBeNull();
});
test("unsupported Chrome desktop reports unavailable with local option and no fallback", async () => {
  const calls = transport(idle, false);
  render(
    <ChromeSharePanel agentId="agent" onClose={() => {}} onChange={() => {}} />,
  );
  await screen.findByText(/Web VNC unavailable/);
  expect(
    (screen.getByRole("button", { name: "Take control" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    screen.getByText(/Use Open in Chrome locally; no managed-browser fallback/),
  ).toBeTruthy();
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
  const { container } = render(<ChromeSharePanel agentId="agent" onClose={() => {}} onChange={() => {}} />);
  await screen.findByText(/Owned virtual-X11 desktop is ready/);
  const button = screen.getByRole("button", { name: "Take control" });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(calls.some(c => /take-owned|ticket|computer\/start/.test(c.path))).toBe(false);
  expect(container.querySelector('input[type="password"]')).toBeNull();
  fireEvent.click(button);
  await waitFor(() => expect(calls.some(c => c.path.endsWith("/take-owned"))).toBe(true));
  expect(calls.find(c => c.path.endsWith("/take-owned"))?.body).toEqual({ agentId: "agent" });
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
    <ChromeSharePanel agentId="agent" onClose={() => {}} onChange={() => {}} />,
  );
  await screen.findByText(/Private desktop share owned by another/);
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
    <ChromeSharePanel agentId="agent" onClose={() => {}} onChange={() => {}} />,
  );
  const action = await screen.findByRole("button", {
    name: "End orphaned desktop share without viewing",
  });
  expect(calls.some((c) => /\/ticket|\/take|\/release/.test(c.path))).toBe(
    false,
  );
  fireEvent.click(action);
  await waitFor(() =>
    expect(calls.find((c) => c.path.endsWith("/release"))?.body).toEqual({
      generation: 7,
      cleanupOnly: true,
      resume: false,
    }),
  );
  expect(calls.some((c) => /\/ticket|\/take|\/resume/.test(c.path))).toBe(
    false,
  );
});

test("one direct Take control action sends no extra approval token, checkbox or dialog", async () => {
  const calls = transport();
  const { container } = render(
    <ChromeSharePanel agentId="agent" onClose={() => {}} onChange={() => {}} />,
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

test("owned availability never enables unavailable selected-profile route; explicit source matches Take", async () => {
  const calls = transport({ ...idle, ownedDesktopAvailable: true }, false);
  const { container } = render(<ChromeSharePanel agentId="agent" onClose={() => {}} onChange={() => {}} />);
  await screen.findByText(/Web VNC unavailable/);
  const take = screen.getByRole("button", { name: "Take control" }) as HTMLButtonElement;
  expect(take.disabled).toBe(true);
  expect((screen.getByRole("combobox", { name: "Desktop source" }) as HTMLSelectElement).value).toBe("selected");
  fireEvent.change(screen.getByRole("combobox", { name: "Desktop source" }), { target: { value: "owned" } });
  await screen.findByText(/Owned virtual-X11 desktop is ready/);
  expect(take.disabled).toBe(false);
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  fireEvent.click(take);
  await waitFor(() => expect(calls.find(c => c.path.endsWith("/take-owned"))?.body).toEqual({ agentId: "agent" }));
  expect(calls.some(c => c.path.endsWith("/take"))).toBe(false);
});
