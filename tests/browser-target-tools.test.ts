import { expect, test } from "bun:test";
import { interventionTools } from "../src/server/agent-tools";
import type { TObject } from "typebox";
import type { Interventions } from "../src/server/interventions";

test("only Connected Chrome tools are advertised, without allocating a browser", () => {
  const list = interventionTools({ get: () => { throw new Error("Must not allocate a browser while registering tools"); } }, {} as Interventions, "agent", "run", "/tmp");
  const names = list.map(tool => tool.name);
  for (const name of ["browser_keep_tab", "browser_name_task", "browser_select", "request_browser_login"])
    expect(names).toContain(name);
  for (const name of ["browser_type", "browser_upload", "browser_diagnostics"])
    expect(names).not.toContain(name);
  const click = list.find(tool => tool.name === "browser_click")!;
  expect(Object.keys((click.parameters as TObject).properties)).toEqual(["ref"]);
  const key = list.find(tool => tool.name === "browser_key")!;
  expect((key.parameters as TObject).required).toContain("ref");
  expect(key.description).toContain("Connected Chrome");
  const login = list.find(tool => tool.name === "request_browser_login")!;
  expect(login.description).toContain("Connected Chrome");
});
