import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromePauseError, chromePauseReason } from "../src/shared/chrome-errors";

// Observation moved to the Jelly server (protocol v9). The extension keeps
// only pause diagnostics, which must stay allowlisted.
test("pause diagnostics allowlist causes without leaking raw incident data", () => {
  for (const reason of ["requested", "native_handoff", "settlement", "cleanup_failed"])
    expect(chromePauseReason(reason)).toBe(reason as ReturnType<typeof chromePauseReason>);
  for (const removed of ["navigation_denied", "debugger_detached", "popup_denied", "tab_replaced", "__proto__", "toString", null, {}])
    expect(chromePauseReason(removed)).toBeUndefined();
  expect(chromePauseError("native_handoff")).toContain("private handoff paused");
  expect(chromePauseError("PRIVATE URL")).toContain("[unknown]");
  expect(chromePauseError("PRIVATE URL")).not.toContain("PRIVATE URL");
});

test("the extension ships no in-page observation script", () => {
  expect(existsSync("extensions/chrome/observation.js")).toBe(false);
});
