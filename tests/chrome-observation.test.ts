import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { legacyChromeNavigationDiagnostic } from "./fixtures/chrome-navigation-diagnostic-v1";
import {
  chromeFailureReason,
  chromeOperationError,
  chromePauseReason,
  chromePauseError,
  chromeNavigationDiagnostic,
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
    frameKind?: "visible" | "clipped" | "srcdoc" | "extension";
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
    getRootNode: () => context.document,
    isConnected: true,
    closest: () => null,
    parentElement: null,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 300,
      bottom: options.frameKind === "clipped" ? 900 : 100,
    }),
    getAttribute: () => options.frameKind === "extension" ? `chrome-extension://${"a".repeat(32)}/helper.html` : "https://helper.example/",
    hasAttribute: (name: string) =>
      name === "srcdoc" && options.frameKind === "srcdoc",
  };
  const context = {
    crypto,
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
  expect(observe()).toMatchObject({ ok: true, framesOmitted: false, shadowRootsOmitted: false });
  expect(observe({ secret: true })).toEqual({
    observationBlocked: "secret_field",
  });
  expect(observe({ frame: true })).toEqual({
    observationBlocked: "unsupported_frame",
  });
  expect(observe({ shadow: true })).toMatchObject({ ok: true, shadowRootsOmitted: true });
  expect(observe({ shadow: true, operation: "screenshot" })).toEqual({ observationBlocked: "shadow_root" });
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
  for (const frameKind of [undefined, "clipped", "srcdoc", "extension"] as const) {
    expect(observe({ frame: true, frameKind, topDocumentOnly: true })).toMatchObject({
      ok: true,
      framesOmitted: true,
    });
    expect(
      observe({
        frame: true,
        frameKind,
        topDocumentOnly: true,
        operation: "screenshot",
      }),
    ).toEqual({ observationBlocked: "unsupported_frame" });
    expect(
      observe({ frame: true, frameKind, topDocumentOnly: true, secret: true }),
    ).toEqual({ observationBlocked: "secret_field" });
  }
  expect(
    observe({ frame: true, frameKind: "visible", topDocumentOnly: true }),
  ).toMatchObject({ ok: true, framesOmitted: false });
});

// A DOM fixture with deterministic visible geometry. No signed-in profile or
// network access is used. Run the same serialized program as executeScript.
function controls(html: string) {
  const window = new Window({ url: "https://fixture.example/" });
  window.document.body.innerHTML = html;
  const rect = () => new window.DOMRect(10, 10, 100, 30);
  window.HTMLElement.prototype.getBoundingClientRect = rect;
  window.Range.prototype.getBoundingClientRect = rect;
  const context: any = {
    document: window.document,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLSelectElement: window.HTMLSelectElement,
    NodeFilter: window.NodeFilter,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    KeyboardEvent: window.KeyboardEvent,
    Event: window.Event,
    crypto,
    URL,
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: () => ({
      visibility: "visible",
      display: "block",
      opacity: "1",
      overflowX: "visible",
      overflowY: "visible",
    }),
    chrome: { dom: { openOrClosedShadowRoot: () => null } },
  };
  return {
    context,
    document: window.document,
    run(operation: string, args = {}) {
      context.operation = operation;
      context.args = args;
      return runInNewContext(
        `${source}\nobservation(operation, args, 'https://fixture.example', 'epoch')`,
        context,
      );
    },
  };
}

test("snapshot labels the outer role button, including icon-only aria labels", () => {
  const fixture = controls(
    '<div role="button" aria-label="Archive" tabindex="0"><div class="Bn"></div></div>',
  );
  const snapshot = fixture.run("snapshot");
  expect(snapshot.elements).toHaveLength(1);
  expect(snapshot.elements[0]).toMatchObject({ tag: "div", label: "Archive" });
});

test("exact custom-button activation supplies press/release before click, once", () => {
  for (const operation of ["click", "Enter", "Space"]) {
    const fixture = controls(
      '<div role="button" tabindex="0"><div class="Bn">Archive</div></div>',
    );
    const button = fixture.document.querySelector('[role="button"]')!;
    const events: string[] = [];
    let armed = false,
      actions = 0;
    for (const type of [
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
    ]) {
      button.addEventListener(type, (event) => {
        expect(event.target).toBe(button); // Never retarget to the inner label.
        events.push(type);
        if (type === "mousedown") armed = true;
        if (type === "mouseup" && armed) {
          actions++;
          armed = false;
        }
      });
    }
    const { ref } = fixture.run("snapshot").elements[0];
    expect(
      fixture.run(operation === "click" ? "click" : "key", {
        ref,
        key: operation,
      }),
    ).toEqual({ ok: true });
    expect(actions).toBe(1);
    expect(events).toEqual([
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
    ]);
    expect(fixture.run("click", { ref })).toEqual({
      observationBlocked: "stale_reference",
    });
  }
});

test("native controls retain single-click activation and disabled controls stay blocked", () => {
  for (const html of ["<button>Native</button>", '<input type="checkbox">']) {
    const fixture = controls(html);
    const element = fixture.document.body.firstElementChild!;
    let clicks = 0;
    element.addEventListener("click", () => clicks++);
    const { ref } = fixture.run("snapshot").elements[0];
    expect(fixture.run("click", { ref })).toEqual({ ok: true });
    expect(clicks).toBe(1);
    if (element.tagName === "INPUT")
      expect((element as any).checked).toBe(true);
  }
  const fixture = controls("<button disabled>Disabled</button>");
  const { ref } = fixture.run("snapshot").elements[0];
  expect(fixture.run("click", { ref })).toEqual({
    observationBlocked: "unsupported_operation",
  });
});

test("removing a custom target during press prevents subsequent dispatch and replay", () => {
  const fixture = controls('<div role="button">Remove</div>');
  const element = fixture.document.body.firstElementChild!;
  const events: string[] = [];
  element.addEventListener("mousedown", () => {
    events.push("down");
    element.remove();
  });
  element.addEventListener("mouseup", () => events.push("up"));
  element.addEventListener("click", () => events.push("click"));
  const { ref } = fixture.run("snapshot").elements[0];
  expect(fixture.run("click", { ref })).toEqual({
    observationBlocked: "unsupported_operation",
  });
  expect(events).toEqual(["down"]);
  expect(fixture.run("click", { ref })).toEqual({
    observationBlocked: "stale_reference",
  });
});

test("disabled role buttons cannot activate; press handlers cannot redirect the final click", () => {
  for (const disabled of ['aria-disabled="true"', "inert"]) {
    const fixture = controls(`<div role="button" ${disabled}>Archive</div>`);
    let actions = 0;
    fixture.document
      .querySelector('[role="button"]')!
      .addEventListener("click", () => actions++);
    const { ref } = fixture.run("snapshot").elements[0];
    expect(fixture.run("click", { ref })).toEqual({
      observationBlocked: "unsupported_operation",
    });
    expect(actions).toBe(0);
  }
  const fixture = controls('<a href="/safe" role="button">Go</a>');
  const anchor = fixture.document.querySelector("a")!;
  let clicks = 0;
  anchor.addEventListener("mousedown", () =>
    anchor.setAttribute("href", "https://other.example/"),
  );
  anchor.addEventListener("click", () => clicks++);
  const { ref } = fixture.run("snapshot").elements[0];
  expect(fixture.run("click", { ref })).toEqual({
    observationBlocked: "unsupported_operation",
  });
  expect(clicks).toBe(0);
  expect(fixture.run("click", { ref })).toEqual({
    observationBlocked: "stale_reference",
  });
});

test("author shadow subtrees and slots are omitted without exposing or activating their contents", () => {
  for (const mode of ["open", "closed"] as const) {
    const f = controls('<h1>Ordinary page</h1><button id="outside">Safe action</button><div id="host"><button>Slotted sentinel</button></div>');
    const host = f.document.getElementById("host")!;
    const root = host.attachShadow({ mode });
    root.innerHTML = '<input type="password" value="PRIVATE"><button>Shadow sentinel</button><slot></slot>';
    f.context.chrome.dom.openOrClosedShadowRoot = (el: unknown) => el === host ? root : null;
    const snapshot = f.run("snapshot");
    expect(snapshot.shadowRootsOmitted).toBe(true);
    expect(snapshot.text).toContain("Ordinary page");
    expect(snapshot.text).not.toContain("sentinel");
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
    expect(snapshot.elements.map((el: any) => el.label.trim())).toEqual(["Safe action"]);
    expect(f.run("screenshot")).toEqual({ observationBlocked: "shadow_root" });
    let clicks = 0;
    const outside = f.document.getElementById("outside")!;
    outside.addEventListener("click", () => clicks++);
    expect(f.run("click", { ref: snapshot.elements[0].ref })).toEqual({ ok: true });
    expect(clicks).toBe(1);
    const next = f.run("snapshot");
    host.append(outside); // Same root scope, but the exact element became omitted.
    expect(f.run("click", { ref: next.elements[0].ref }).observationBlocked).toBeDefined();
    expect(clicks).toBe(1);
  }
});

test("old exact refs cannot enter an existing open or closed actual shadow root", () => {
  for (const mode of ["open", "closed"] as const) {
    const f = controls('<div id="host"></div><button id="target">Outside</button>');
    const host = f.document.getElementById("host")!;
    const target = f.document.getElementById("target")!;
    const root = host.attachShadow({ mode });
    f.context.chrome.dom.openOrClosedShadowRoot = (el: unknown) => el === host ? root : null;
    let clicks = 0;
    target.addEventListener("click", () => clicks++);
    const { ref } = f.run("snapshot").elements[0];
    root.append(target);
    expect(target.isConnected).toBe(true);
    expect(host.contains(target)).toBe(false); // The original predicate missed this.
    expect(target.getRootNode()).not.toBe(f.document);
    expect(f.run("click", { ref }).observationBlocked).toBeDefined();
    expect(clicks).toBe(0);
  }
});

const exactEventFixtures = [
  { operation: "fill", html: '<input id="target" type="text">', first: "input", later: "change" },
  { operation: "select", html: '<select id="target"><option value="a">A</option><option value="b">B</option></select>', first: "input", later: "change" },
  { operation: "key", html: '<button id="target">Key</button>', first: "keydown", later: "keyup" },
];

test("fill/select/key revalidate light-DOM and actual-root reparenting between events, without replay", () => {
  for (const spec of exactEventFixtures) {
    for (const mode of ["open", "closed"] as const) {
      for (const destination of ["host", "root"] as const) {
        const f = controls('<div id="host"></div>' + spec.html);
        const host = f.document.getElementById("host")!;
        const target = f.document.getElementById("target")!;
        const root = host.attachShadow({ mode });
        f.context.chrome.dom.openOrClosedShadowRoot = (el: unknown) => el === host ? root : null;
        const { ref } = f.run("snapshot").elements[0];
        const args = { ref, text: "Fixture value", value: "b", key: "ArrowDown" };
        const events: string[] = [];
        let reentrant: any;
        target.addEventListener(spec.first, () => {
          events.push(spec.first);
          reentrant = f.run(spec.operation, args); // Already consumed before dispatch.
          (destination === "host" ? host : root).append(target);
        });
        target.addEventListener(spec.later, () => events.push(spec.later));
        expect(f.run(spec.operation, args).observationBlocked).toBeDefined();
        expect(events).toEqual([spec.first]);
        expect(reentrant).toEqual({ observationBlocked: "stale_reference" });
        f.document.body.append(target);
        expect(f.run(spec.operation, args)).toEqual({ observationBlocked: "stale_reference" });
        expect(events).toEqual([spec.first]);
      }
    }
  }
});

test("fill/select/key stop after handlers make the target secret, disabled, inert or foreign-origin", () => {
  for (const spec of exactEventFixtures) {
    for (const change of ["secret", "new-secret-field", "disabled", "inert", "aria-disabled", "origin", "operation-eligibility"]) {
      const f = controls(spec.html);
      const target = f.document.getElementById("target")!;
      f.context.location = { origin: "https://fixture.example", href: "https://fixture.example/" };
      const { ref } = f.run("snapshot").elements[0];
      const args = { ref, text: "Fixture value", value: "b", key: "ArrowDown" };
      const events: string[] = [];
      target.addEventListener(spec.first, () => {
        events.push(spec.first);
        if (change === "secret") target.setAttribute("name", "auth-code");
        if (change === "new-secret-field") {
          const field = f.document.createElement("input");
          field.id = "new-field";
          field.type = "password";
          f.document.body.append(field);
        }
        if (change === "disabled") target.setAttribute("disabled", "");
        if (change === "inert") target.setAttribute("inert", "");
        if (change === "aria-disabled") target.setAttribute("aria-disabled", "true");
        if (change === "origin") f.context.location.origin = "https://other.example";
        if (change === "operation-eligibility") {
          if (spec.operation === "fill") target.setAttribute("readonly", "");
          else if (spec.operation === "select") target.querySelector('option[value="b"]')!.setAttribute("disabled", "");
          else target.remove();
        }
      });
      target.addEventListener(spec.later, () => events.push(spec.later));
      expect(f.run(spec.operation, args).observationBlocked).toBeDefined();
      expect(events).toEqual([spec.first]);
      for (const attr of ["name", "disabled", "inert", "aria-disabled", "readonly"]) target.removeAttribute(attr);
      target.querySelector("option[disabled]")?.removeAttribute("disabled");
      f.document.getElementById("new-field")?.remove();
      f.document.body.append(target);
      f.context.location.origin = "https://fixture.example";
      expect(f.run(spec.operation, args)).toEqual({ observationBlocked: "stale_reference" });
      expect(events).toEqual([spec.first]);
    }
  }
});

test("safe fill/select/key retain their event sequence and consume refs before dispatch", () => {
  for (const spec of exactEventFixtures) {
    const f = controls(spec.html);
    const target = f.document.getElementById("target")!;
    const events: string[] = [];
    const { ref } = f.run("snapshot").elements[0];
    const args = { ref, text: "Fixture value", value: "b", key: "ArrowDown" };
    target.addEventListener(spec.first, () => events.push(spec.first));
    target.addEventListener(spec.later, () => events.push(spec.later));
    expect(f.run(spec.operation, args)).toEqual({ ok: true });
    expect(events).toEqual([spec.first, spec.later]);
    expect(f.run(spec.operation, args)).toEqual({ observationBlocked: "stale_reference" });
  }
});

test("a changed shadow scope invalidates old refs and ancestor controls cannot target omitted content", () => {
  const f = controls('<button id="outside">Safe</button><div role="button">Ancestor<div id="host"></div></div>');
  const old = f.run("snapshot");
  const host = f.document.getElementById("host")!;
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = '<button>Private</button>';
  f.context.chrome.dom.openOrClosedShadowRoot = (el: unknown) => el === host ? root : null;
  expect(f.run("click", { ref: old.elements[0].ref })).toEqual({ observationBlocked: "stale_reference" });
  expect(f.run("snapshot").elements.map((el: any) => el.label.trim())).toEqual(["Safe"]);
  f.context.chrome.dom.openOrClosedShadowRoot = undefined;
  expect(f.run("snapshot")).toEqual({ observationBlocked: "shadow_inspection_unavailable" });
});

test("a press handler creating a shadow root prevents subsequent activation and replay", () => {
  const f = controls('<div role="button" id="host">Action</div>');
  const host = f.document.getElementById("host")!;
  let root: unknown = null, clicks = 0;
  f.context.chrome.dom.openOrClosedShadowRoot = (el: unknown) => el === host ? root : null;
  host.addEventListener("mousedown", () => { root = host.attachShadow({ mode: "closed" }); });
  host.addEventListener("click", () => clicks++);
  const { ref } = f.run("snapshot").elements[0];
  expect(f.run("click", { ref })).toEqual({ observationBlocked: "stale_reference" });
  expect(clicks).toBe(0);
  expect(f.run("click", { ref })).toEqual({ observationBlocked: "stale_reference" });
});

test("pause diagnostics allowlist causes without leaking raw incident data", () => {
  expect(chromePauseReason("navigation_denied")).toBe("navigation_denied");
  expect(chromePauseError("navigation_denied")).toContain("navigation event");
  expect(chromePauseError("PRIVATE URL")).toContain("[unknown]");
  expect(chromePauseError("PRIVATE URL")).not.toContain("PRIVATE URL");
  expect(chromePauseError("native_handoff")).toContain("private handoff paused");
});

test("navigation diagnostics contain only known enums and never raw event values", () => {
  const diagnostic = { event: "fragment", frame: "child", destination: "url_too_long" } as const;
  expect(chromeNavigationDiagnostic({ ...diagnostic, url: "PRIVATE" })).toEqual(diagnostic);
  expect(chromePauseError("navigation_denied", diagnostic)).toContain("event=fragment, frame=child, destination=url_too_long");
  expect(chromePauseError("native_handoff", diagnostic)).not.toContain("Navigation classification");
  const errorDocument = { event: "committed", frame: "child", destination: "chromium_error_document" } as const;
  expect(chromeNavigationDiagnostic({ ...errorDocument, url: "PRIVATE" })).toEqual(errorDocument);
  expect(chromePauseError("navigation_denied", errorDocument)).toContain("destination=chromium_error_document");
  expect(chromePauseError("navigation_denied", { ...errorDocument, url: "PRIVATE" })).not.toContain("PRIVATE");
  for (const key of ["event", "frame", "destination"]) {
    for (const invalid of ["PRIVATE", "__proto__", null, {}, ["child"]]) {
      const value = { ...diagnostic, [key]: invalid };
      expect(chromeNavigationDiagnostic(value)).toBeUndefined();
      expect(chromePauseError("navigation_denied", value)).not.toContain("Navigation classification");
      expect(chromePauseError("navigation_denied", value)).not.toContain("PRIVATE");
    }
  }
});

test("diagnostic revisions identify loaded backend and only a validated worker marker", () => {
  const base = { event: "committed", frame: "child", destination: "extension_other" } as const;
  const current = { ...base, revision: "internal_v2" } as const;
  expect(chromeNavigationDiagnostic(current)).toEqual(current);
  expect(chromePauseError("navigation_denied", current)).toContain("backend=internal_v2, worker=internal_v2");
  for (const revision of [undefined, "PRIVATE", "internal_v3", 2, null, {}, ["internal_v2"]]) {
    const value = { ...base, revision };
    expect(chromeNavigationDiagnostic(value)).toEqual(base);
    expect(chromePauseError("navigation_denied", value)).toContain("backend=internal_v2, worker=unreported");
    expect(chromePauseError("navigation_denied", value)).not.toContain("PRIVATE");
  }
  expect(chromePauseError("navigation_denied", { ...current, destination: "PRIVATE" })).toContain("worker=unreported");
  expect(chromePauseError("native_handoff", current)).not.toContain("Diagnostic revisions");
});

test("previous deployed backend drops new subclasses instead of downgrading them to browser_internal", () => {
  const diagnostic = { event: "committed", frame: "child", revision: "internal_v2" };
  for (const destination of ["chrome_internal", "chromium_error_variant", "chrome_error_other", "extension_self", "extension_other", "devtools"] as const) {
    expect(legacyChromeNavigationDiagnostic({ ...diagnostic, destination })).toBeUndefined();
    expect(chromeNavigationDiagnostic({ ...diagnostic, destination })?.destination).toBe(destination);
  }
  for (const destination of ["chromium_error_document", "browser_internal"]) {
    expect(legacyChromeNavigationDiagnostic({ ...diagnostic, destination })).toEqual({ event: "committed", frame: "child", destination });
  }
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
