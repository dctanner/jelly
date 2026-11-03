import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  chromeFailureReason,
  chromeOperationError,
} from "../src/shared/chrome-errors";

// Exercise the exact serialized isolated-world function, without a real profile.
const source = readFileSync(
  new URL("../extensions/chrome/observation.js", import.meta.url),
  "utf8",
).replace("export function", "function");
function observe(
  options: {
    secret?: boolean;
    frame?: boolean;
    shadow?: boolean;
    large?: boolean;
    unexpected?: boolean;
    operation?: string;
    topDocumentOnly?: boolean;
    frameKind?: "visible" | "clipped" | "srcdoc";
  } = {},
) {
  class Element {}
  const host = new Element();
  const field = {
    type: "password",
    name: "private-value-must-not-leak",
    getAttribute: () => null,
  };
  const frame = {
    isConnected: true,
    closest: () => null,
    parentElement: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: options.frameKind === "clipped" ? 900 : 100 }),
    getAttribute: () => "https://helper.example/",
    hasAttribute: (name: string) => name === "srcdoc" && options.frameKind === "srcdoc",
  };
  const context = {
    location: { origin: "https://fixture.example" },
    HTMLElement: Element,
    chrome: {
      dom: { openOrClosedShadowRoot: () => (options.shadow ? {} : null) },
    },
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle: () => ({
      visibility: "visible",
      display: options.frameKind ? "block" : "none",
      opacity: "1",
    }),
    document: {
      querySelector: () => {
        if (options.unexpected) throw new Error("PRIVATE runtime error");
        return null;
      },
      querySelectorAll: (selector: string) =>
        selector === "*"
          ? options.large
            ? Array(10001).fill(host)
            : [host]
          : selector === "iframe,frame"
            ? options.frame
              ? [frame]
              : []
            : options.secret
              ? [field]
              : [],
    },
    operation: options.operation ?? "guard",
    args: { topDocumentOnly: options.topDocumentOnly },
  };
  return runInNewContext(
    `${source}\nobservation(operation, args, 'https://fixture.example', 'epoch')`,
    context,
  );
}

test("guard failure categories contain no page content and keep refusals intact", () => {
  expect(observe()).toEqual({ ok: true, framesOmitted: false });
  expect(observe({ secret: true })).toEqual({
    observationBlocked: "secret_field",
  });
  expect(observe({ frame: true })).toEqual({
    observationBlocked: "unsupported_frame",
  });
  expect(observe({ shadow: true })).toEqual({
    observationBlocked: "shadow_root",
  });
  expect(observe({ large: true })).toEqual({ observationBlocked: "dom_limit" });
  expect(observe({ unexpected: true })).toEqual({
    observationBlocked: "unsupported_operation",
  });
  for (const operation of ["snapshot", "screenshot", "click", "fill"]) {
    expect(observe({ secret: true, operation })).toEqual({
      observationBlocked: "secret_field",
    });
    expect(observe({ frame: true, operation })).toEqual({
      observationBlocked: "unsupported_frame",
    });
  }
});

test("main-document fallback excludes unsupported frames but never relaxes screenshot or secret guards", () => {
  for (const frameKind of [undefined, "clipped", "srcdoc"] as const) {
    expect(observe({ frame: true, frameKind, topDocumentOnly: true })).toEqual({ ok: true, framesOmitted: true });
    expect(observe({ frame: true, frameKind, topDocumentOnly: true, operation: "screenshot" })).toEqual({ observationBlocked: "unsupported_frame" });
    expect(observe({ frame: true, frameKind, topDocumentOnly: true, secret: true })).toEqual({ observationBlocked: "secret_field" });
  }
  expect(observe({ frame: true, frameKind: "visible", topDocumentOnly: true })).toEqual({ ok: true, framesOmitted: false });
});

test("only exact allowlisted reason codes reach diagnostic messages", () => {
  expect(chromeOperationError("unsupported_frame")).toContain(
    "[unsupported_frame]",
  );
  for (const value of [
    "PRIVATE",
    "__proto__",
    "constructor",
    "toString",
    null,
    {},
    ["secret_field"],
  ]) {
    expect(chromeFailureReason(value)).toBeUndefined();
    expect(chromeOperationError(value)).toBe(chromeOperationError(undefined));
  }
});
