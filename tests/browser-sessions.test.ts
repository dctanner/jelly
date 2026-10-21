import { expect, test } from "bun:test";
import { BrowserSessions, type BrowserPort } from "../src/server/browser-sessions";
import type { ChromeSessions } from "../src/server/chrome-sessions";
import type { ChromeSelection } from "../src/shared/chrome-protocol";

const selection = (profile: string): ChromeSelection => ({
  chromeProfile: profile,
  chromeOrigins: ["https://example.com"],
  chromeSiteScope: "approved",
});
const port: BrowserPort = {
  target: "chrome",
  action: async () => ({}),
  reserveLogin: async () => {},
  cancelLogin: () => {},
};
function fixture(fail = false) {
  const calls: { agent: string; run: string; selection: ChromeSelection; name: string }[] = [];
  const chrome = {
    allocate(agent: string, run: string, selection: ChromeSelection, name: string) {
      if (fail) throw new Error("Chrome is disconnected");
      calls.push({ agent, run, selection: structuredClone(selection), name });
      return port;
    },
  };
  return {
    sessions: new BrowserSessions(chrome as unknown as ChromeSessions),
    calls,
    reconnect: () => { fail = false; },
  };
}

test("BrowserSessions captures each run lazily without pinning nonbrowser runs", () => {
  const { sessions, calls } = fixture();
  sessions.forRun("agent", "nonbrowser", { chromeProfile: "", chromeOrigins: [] }, "Task");
  expect(sessions.target("agent")).toBeUndefined();
  const configured = selection("profile-a");
  const run = sessions.forRun("agent", "browser", configured, "Task");
  configured.chromeOrigins.push("https://later.example");
  expect(run.target).toBe("chrome");
  expect(calls).toHaveLength(0);
  expect(run.get("agent")).toBe(port);
  expect(run.get("agent")).toBe(port);
  expect(calls).toEqual([{ agent: "agent", run: "browser", selection: selection("profile-a"), name: "Task" }]);
  expect(sessions.target("agent")).toBe("chrome");
});

test("BrowserSessions failed allocation does not pin stale configuration", () => {
  const { sessions, calls, reconnect } = fixture(true);
  const failed = sessions.forRun("agent", "run-a", selection("profile-a"), "Task");
  expect(() => failed.get("agent")).toThrow("disconnected");
  expect(sessions.target("agent")).toBeUndefined();
  reconnect();
  sessions.forRun("agent", "run-b", selection("profile-b"), "Task").get("agent");
  expect(calls[0].selection.chromeProfile).toBe("profile-b");
});

test("BrowserSessions pins actual Chrome sessions until explicit release", () => {
  const { sessions, calls } = fixture();
  sessions.forRun("agent", "run-a", selection("profile-a"), "First").get("agent");
  sessions.forRun("agent", "run-b", selection("profile-b"), "Second").get("agent");
  expect(calls[1].selection).toEqual(selection("profile-a"));
  sessions.releasePin("agent");
  expect(sessions.target("agent")).toBeUndefined();
  sessions.forRun("agent", "run-c", selection("profile-b"), "Third").get("agent");
  expect(calls[2].selection).toEqual(selection("profile-b"));
});

test("BrowserSessions rejects child and foreign access without allocating or pinning", () => {
  const { sessions, calls } = fixture();
  const run = sessions.forRun("agent", "run", selection("profile-a"), "Task");
  expect(() => run.get("foreign")).toThrow("Child/foreign Chrome browser access");
  expect(calls).toHaveLength(0);
  expect(sessions.target("agent")).toBeUndefined();
  run.get("agent");
  expect(() => run.get("foreign")).toThrow("Child/foreign Chrome browser access");
  expect(calls).toHaveLength(1);
});
