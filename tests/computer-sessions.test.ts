import { expect, test } from "bun:test";
import { ComputerSessions } from "../src/server/computer-sessions";

test("registry validates identities, isolates storage and tickets, reuses and closes sessions", async () => {
  const registry = new ComputerSessions("/unused", id => ["a", "b"].includes(id));
  expect(() => registry.get("../a")).toThrow("Agent not found");
  const a = registry.get("a"), b = registry.get("b");
  expect(registry.get("a")).toBe(a);
  expect(a.dataDir).not.toBe(b.dataDir);
  const internal = a as unknown as { tickets: Map<string, unknown>; runtime: string };
  internal.tickets.set("private-ticket", { session: "owner", mode: "view", generation: 0, expires: Date.now() + 60000 });
  expect(() => b.consume("private-ticket", "owner")).toThrow("Expired");
  await registry.closeSession("a");
  expect(registry.get("a")).not.toBe(a);
  await registry.close();
  expect(() => registry.get("b")).toThrow("closing");
});

test("registry caps live sessions without evicting private sessions", async () => {
  const registry = new ComputerSessions("/unused", () => true);
  for (let i = 0; i < 8; i++) registry.get(String(i));
  expect(() => registry.get("ninth")).toThrow("limit 8");
  await registry.closeSession("0");
  registry.get("ninth");
  await registry.close();
});
