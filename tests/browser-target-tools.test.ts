import { expect, test } from "bun:test";
import { interventionTools } from "../src/server/agent-tools";
import type { TObject } from "typebox";
import type { Interventions } from "../src/server/interventions";

test("Connected Chrome is driven through the browser_js REPL, without allocating a browser at registration", () => {
  const list = interventionTools({ get: () => { throw new Error("Must not allocate a browser while registering tools"); } }, {} as Interventions, "agent", "run", "/tmp");
  const names = list.map(tool => tool.name);
  for (const name of ["browser_js", "browser_reconnect", "request_browser_login", "request_browser_recovery"])
    expect(names).toContain(name);
  for (const name of ["browser_click", "browser_snapshot", "browser_fill", "browser_key", "browser_keep_tab", "browser_name_task"])
    expect(names).not.toContain(name);
  const js = list.find(tool => tool.name === "browser_js")!;
  expect(Object.keys((js.parameters as TObject).properties).sort()).toEqual(["code", "timeout_ms"]);
  expect(js.description).toContain("tab.ax");
  const reconnect = list.find(tool => tool.name === "browser_reconnect")!;
  expect(Object.keys((reconnect.parameters as TObject).properties)).toEqual([]);
  expect(reconnect.parameters).toMatchObject({ additionalProperties: false });
  expect(reconnect.description).toContain("never replays");
});
