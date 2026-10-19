await import("./dom");
import { afterEach, beforeEach, expect, test } from "bun:test";
const { render, screen, fireEvent, waitFor, cleanup } = await import("@testing-library/react");
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store";
import { BrowserNotifications } from "../src/client/BrowserNotifications";
import { useAgentNotifications } from "../src/client/useAgentNotifications";
import { claimAgentNotification, notificationAgentId, setNotificationsEnabled, showBrowserNotification } from "../src/client/browser-notifications";
import type { AgentNotification, AgentRecord, Snapshot } from "../src/shared/types";

const originalNotification = Object.getOwnPropertyDescriptor(window, "Notification");
const originalSecure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
const originalFocus = document.hasFocus;
const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
const notices: FakeNotification[] = [];
let permissionRequests = 0;
let permissionResult: NotificationPermission = "granted";
class FakeNotification {
  static permission: NotificationPermission = "granted";
  static async requestPermission() {
    permissionRequests++;
    FakeNotification.permission = permissionResult;
    return permissionResult;
  }
  onclick: (() => void) | null = null;
  closed = false;
  constructor(readonly title: string, readonly options: NotificationOptions) {
    notices.push(this);
  }
  close() { this.closed = true; }
}
function restore(object: object, key: string, descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(object, key, descriptor);
  else Reflect.deleteProperty(object, key);
}
beforeEach(() => {
  Object.defineProperty(window, "Notification", { configurable: true, value: FakeNotification });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  document.hasFocus = () => false;
  FakeNotification.permission = "granted";
  permissionResult = "granted";
  permissionRequests = 0;
  notices.length = 0;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  restore(window, "Notification", originalNotification);
  restore(window, "isSecureContext", originalSecure);
  restore(document, "visibilityState", originalVisibility);
  document.hasFocus = originalFocus;
});
const agent = (id: string): AgentRecord => ({
  id, name: `Agent ${id}`, instructions: "", color: "#123456", status: "idle",
  model: "gpt-6-astra", effort: "medium", projectId: null, cwd: "/tmp",
  managedCwd: 1, avatarId: "jellyfish", createdAt: new Date().toISOString(), archivedAt: null,
});
function snapshot(cursor: number, notifications: AgentNotification[] = [], instance = "one"): Snapshot {
  return {
    instance: { id: instance, name: "Test" }, cursor, agents: [agent("a"), agent("b")],
    agentNotifications: notifications,
  } as Snapshot;
}
function Harness({ data, viewing = null, open = () => {} }: {
  data: Snapshot; viewing?: string | null; open?: (id: string) => void;
}) {
  useAgentNotifications(data, viewing, open);
  return null;
}
test("permissions are requested only on enable, saved per instance, with an explicit test and off switch", async () => {
  FakeNotification.permission = "default";
  render(<BrowserNotifications instance="one" />);
  expect(permissionRequests).toBe(0);
  expect(screen.getByRole("status").textContent).toBe("Notifications off");
  fireEvent.click(screen.getByRole("button", { name: "Enable notifications" }));
  await screen.findByText("Notifications on");
  expect(permissionRequests).toBe(1);
  expect(localStorage.getItem("jelly.notifications.one")).toBe("on");
  expect(localStorage.getItem("jelly.notifications.two")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Send test notification" }));
  await waitFor(() => expect(notices).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole("button", { name: "Turn off notifications" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Turn off notifications" }));
  expect(localStorage.getItem("jelly.notifications.one")).toBe("off");
});
test("denied, dismissed, unavailable and insecure permissions have actionable states", async () => {
  FakeNotification.permission = "denied";
  let ui = render(<BrowserNotifications instance="one" />);
  expect(screen.getByRole("status").textContent).toBe("Blocked by browser");
  expect(screen.getByRole("button", { name: "Enable notifications" }).hasAttribute("disabled")).toBe(true);
  expect(permissionRequests).toBe(0);
  ui.unmount();
  FakeNotification.permission = "default";
  permissionResult = "default";
  ui = render(<BrowserNotifications instance="one" />);
  fireEvent.click(screen.getByRole("button", { name: "Enable notifications" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/wasn’t granted/);
  expect(localStorage.getItem("jelly.notifications.one")).toBeNull();
  ui.unmount();
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
  ui = render(<BrowserNotifications instance="one" />);
  expect(screen.getByRole("status").textContent).toBe("HTTPS required");
  expect(screen.getByRole("button", { name: "Enable notifications" }).hasAttribute("disabled")).toBe(true);
  ui.unmount();
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(window, "Notification", { configurable: true, value: undefined });
  render(<BrowserNotifications instance="one" />);
  expect(screen.getByRole("status").textContent).toBe("Not supported");
});
test("completion and attention work for unselected agents, never on initial load, and clicks open the right agent", async () => {
  setNotificationsEnabled("one", true);
  const opened: string[] = [];
  const open = (id: string) => opened.push(id);
  const ui = render(<Harness data={snapshot(10, [{ id: 9, agentId: "a", type: "run_completed" }])} open={open} />);
  expect(notices).toHaveLength(0);
  ui.rerender(<Harness data={snapshot(12, [
    { id: 11, agentId: "a", type: "run_completed" },
    { id: 12, agentId: "b", type: "intervention_requested" },
  ])} open={open} />);
  await waitFor(() => expect(notices).toHaveLength(2));
  expect(notices.map(notice => notice.title)).toEqual(["Agent a finished", "Agent b needs attention"]);
  notices[1]!.onclick!();
  expect(opened).toEqual(["b"]);
  expect(notices[1]!.closed).toBe(true);
  ui.rerender(<Harness data={snapshot(20, [{ id: 12, agentId: "b", type: "intervention_requested" }])} />);
  await waitFor(() => expect(localStorage.getItem("jelly.notifications.delivered.one.b")).toBe("12"));
  expect(notices).toHaveLength(2);
});
test("suppress focused conversation but notify an unfocused or hidden conversation", async () => {
  setNotificationsEnabled("one", true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.hasFocus = () => true;
  const ui = render(<Harness data={snapshot(1)} viewing="a" />);
  ui.rerender(<Harness data={snapshot(2, [{ id: 2, agentId: "a", type: "run_completed" }])} viewing="a" />);
  await waitFor(() => expect(localStorage.getItem("jelly.notifications.delivered.one.a")).toBe("2"));
  expect(notices).toHaveLength(0);
  document.hasFocus = () => false;
  ui.rerender(<Harness data={snapshot(3, [{ id: 3, agentId: "a", type: "run_failed" }])} viewing="a" />);
  await waitFor(() => expect(notices).toHaveLength(1));
  document.hasFocus = () => true;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  ui.rerender(<Harness data={snapshot(4, [{ id: 4, agentId: "a", type: "run_interrupted" }])} viewing="a" />);
  await waitFor(() => expect(notices).toHaveLength(2));
});
test("disabled alerts, archived agents, revoked permission and instance switches never replay old events", async () => {
  const ui = render(<Harness data={snapshot(1)} />);
  ui.rerender(<Harness data={snapshot(2, [{ id: 2, agentId: "a", type: "run_completed" }])} />);
  await waitFor(() => expect(localStorage.getItem("jelly.notifications.delivered.one.a")).toBe("2"));
  expect(notices).toHaveLength(0);
  setNotificationsEnabled("one", true);
  ui.rerender(<Harness data={snapshot(3, [{ id: 2, agentId: "a", type: "run_completed" }])} />);
  const archived = snapshot(4, [{ id: 4, agentId: "a", type: "run_completed" }]);
  archived.agents[0]!.archivedAt = new Date().toISOString();
  ui.rerender(<Harness data={archived} />);
  FakeNotification.permission = "denied";
  ui.rerender(<Harness data={snapshot(5, [{ id: 5, agentId: "b", type: "run_completed" }])} />);
  await waitFor(() => expect(localStorage.getItem("jelly.notifications.delivered.one.b")).toBe("5"));
  expect(notices).toHaveLength(0);
  FakeNotification.permission = "granted";
  setNotificationsEnabled("two", true);
  ui.rerender(<Harness data={snapshot(50, [{ id: 49, agentId: "a", type: "run_completed" }], "two")} />);
  expect(notices).toHaveLength(0);
});
test("shared delivery claims deduplicate simultaneous tabs and links reject unsafe URLs", async () => {
  const event: AgentNotification = { id: 8, agentId: "a", type: "run_completed" };
  expect(await Promise.all([claimAgentNotification("one", event), claimAgentNotification("one", event)])).toEqual([true, false]);
  expect(await claimAgentNotification("one", { ...event, id: 7 })).toBe(false);
  expect(notificationAgentId("/agents/a%20b")).toBe("a b");
  for (const url of ["https://evil.example/agents/a", "//evil.example/agents/a", "/agents/a?x=1", "/agents/%E0", "/apps/a"])
    expect(notificationAgentId(url)).toBeNull();
});
test("turning notifications off during worker setup cancels pending delivery", async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  let ready!: (registration: ServiceWorkerRegistration) => void;
  let shown = 0;
  let allowed = true;
  const registration = new Promise<ServiceWorkerRegistration>(resolve => { ready = resolve; });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register: () => registration } });
  try {
    const delivery = showBrowserNotification("Test", "Test", "/agents/a", "test", () => {}, () => allowed);
    allowed = false;
    ready({ active: {}, showNotification: async () => { shown++; } } as unknown as ServiceWorkerRegistration);
    await delivery;
    expect(shown).toBe(0);
    expect(notices).toHaveLength(0);
  } finally { restore(navigator, "serviceWorker", originalWorker); }
});
test("durable markers cover all agents without leaking data, omit settled attention and archived agents", () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-notification-store-"));
  const store = new Store(join(dir, "test.sqlite"));
  try {
    const a = store.addAgent({ name: "A", instructions: "", color: "#123" });
    const b = store.addAgent({ name: "B", instructions: "", color: "#456" });
    const done = store.event(a.id, null, "run_completed", { private: "never expose this" });
    const handoff = store.event(b.id, null, "intervention_requested", { request: { payload: { reason: "private" } } });
    store.setStatus(b.id, "waiting");
    expect(store.agentNotifications()).toEqual([
      { id: done.id, agentId: a.id, type: "run_completed" },
      { id: handoff.id, agentId: b.id, type: "intervention_requested" },
    ]);
    store.setStatus(b.id, "running");
    expect(store.agentNotifications()).toHaveLength(1);
    const failed = store.event(b.id, null, "run_failed", { error: "private error" });
    store.setStatus(b.id, "error");
    expect(store.agentNotifications()[1]).toEqual({ id: failed.id, agentId: b.id, type: "run_failed" });
    // The SSE log is bounded; the durable timeline still retains the markers.
    store.db.query("DELETE FROM events").run();
    expect(store.agentNotifications()).toHaveLength(2);
    store.db.query("UPDATE agents SET archivedAt=? WHERE id=?").run(new Date().toISOString(), a.id);
    expect(store.agentNotifications()).toHaveLength(1);
    store.setStatus(b.id, "idle");
    store.event(b.id, null, "run_cancelled", {});
    expect(store.agentNotifications()).toHaveLength(0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
