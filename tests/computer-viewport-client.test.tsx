await import("./dom");
import { test, expect, afterEach } from "bun:test";
import { createRef } from "react";
const { render, screen, fireEvent, waitFor, cleanup, act } =
  await import("@testing-library/react");
import { ComputerViewport } from "../src/client/ComputerViewport";
import { bindViewerKeyboardCleanup } from "../src/client/vnc-keyboard";

const originalMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = originalMedia;
});

function fixture(connected = true, fillAvailable = false) {
  let portrait = true, width = 350, height = 440, availableHeight = 488;
  let mediaChanged = () => {};
  window.matchMedia = (() => ({
    get matches() { return portrait; },
    addEventListener: (_: string, callback: () => void) => { mediaChanged = callback; },
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  const displayRef = createRef<HTMLDivElement>();
  let blurCount = 0;
  const props = { displayRef, connected, hidden: false, fillAvailable, onPan: () => { blurCount++; } };
  const view = render(<ComputerViewport {...props} />);
  const viewport = view.container.querySelector(".chrome-share-screen")!;
  Object.defineProperties(viewport, {
    clientWidth: { get: () => width },
    clientHeight: { get: () => height },
  });
  Object.defineProperty(viewport.parentElement!, "clientHeight", { get: () => availableHeight });
  const canvas = document.createElement("canvas");
  canvas.width = 1600; canvas.height = 1000;
  act(() => {
    displayRef.current!.append(canvas);
    fireEvent(window, new window.Event("resize"));
  });
  return {
    ...view, displayRef, canvas,
    blurCount: () => blurCount,
    state: (changes: Partial<typeof props>) => {
      Object.assign(props, changes);
      view.rerender(<ComputerViewport {...props} />);
    },
    resize: (w: number, h: number, p = true, total = h + 48) => act(() => {
      width = w; height = h; portrait = p; availableHeight = total;
      mediaChanged();
      fireEvent(window, new window.Event("resize"));
    }),
  };
}

test("portrait height fill uses actual remote dimensions, with accessible local panning", async () => {
  const view = fixture();
  const slider = await screen.findByRole("slider", { name: "Pan computer left and right" });
  expect(view.displayRef.current!.style.width).toBe("704px");
  fireEvent.focus(slider);
  fireEvent.pointerDown(slider);
  expect(view.blurCount()).toBe(2);
  fireEvent.change(slider, { target: { value: "100" } });
  expect(view.displayRef.current!.style.transform).toBe("translateX(-354px)");
  expect(slider.getAttribute("aria-valuetext")).toBe("100% from left");
  view.resize(300, 500);
  expect(view.displayRef.current!.style.width).toBe("800px");
  expect(view.displayRef.current!.style.transform).toBe("translateX(-500px)");
  expect(view.canvas.width).toBe(1600);
  expect(view.canvas.height).toBe(1000);
});

test("remote size changes are observed; portrait desktops without overflow and landscape fit", async () => {
  const view = fixture();
  await screen.findByRole("slider");
  act(() => { view.canvas.width = 900; view.canvas.height = 1200; });
  await waitFor(() => expect(screen.queryByRole("slider")).toBeNull());
  expect(view.displayRef.current!.style.width).toBe("100%");
  act(() => { view.canvas.width = 1280; view.canvas.height = 900; });
  await screen.findByRole("slider");
  expect(parseFloat(view.displayRef.current!.style.width)).toBeCloseTo(440 * 1280 / 900);
  view.resize(844, 300, false);
  expect(screen.queryByRole("slider")).toBeNull();
  expect(view.displayRef.current!.style.width).toBe("100%");
  expect(view.displayRef.current!.style.transform).toBe("");
  view.resize(350, 440);
  await screen.findByRole("slider");
});

test("disconnection and hidden viewer remove the slider and reset the next connected pan", async () => {
  const view = fixture(false);
  expect(screen.queryByRole("slider")).toBeNull();
  view.state({ connected: true });
  fireEvent.change(await screen.findByRole("slider"), { target: { value: "80" } });
  view.state({ connected: false });
  expect(screen.queryByRole("slider")).toBeNull();
  view.state({ connected: true });
  expect((await screen.findByRole("slider") as HTMLInputElement).value).toBe("0");
  fireEvent.change(screen.getByRole("slider"), { target: { value: "70" } });
  view.state({ hidden: true });
  expect(view.container.querySelector(".chrome-share-viewer")!.hasAttribute("hidden")).toBe(true);
  expect(screen.queryByRole("slider")).toBeNull();
  view.state({ hidden: false });
  expect((await screen.findByRole("slider") as HTMLInputElement).value).toBe("0");
});

test("flexible viewer stays fitted near the soft-keyboard pan threshold without toggling back", async () => {
  const view = fixture(true, true);
  await screen.findByRole("slider");
  view.resize(350, 202, true, 250);
  expect(screen.queryByRole("slider")).toBeNull();
  // Removing the pan row grows the screen, but must not make it reappear.
  view.resize(350, 250, true, 250);
  expect(screen.queryByRole("slider")).toBeNull();
  expect(view.displayRef.current!.style.width).toBe("100%");
  view.resize(350, 440, true, 488);
  await screen.findByRole("slider");
});

function keyboardFixture() {
  const display = document.createElement("div");
  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0;
  const local = document.createElement("input");
  display.append(canvas);
  document.body.append(display, local);
  let current = true;
  const ups: string[] = [];
  const dispose = bindViewerKeyboardCleanup(display, () => current);
  // noVNC consumes events at the target, so the cleanup must track in capture.
  canvas.addEventListener("keydown", event => event.stopPropagation());
  canvas.addEventListener("keyup", event => {
    ups.push(event.code || String(event.keyCode));
    event.stopPropagation();
  });
  const key = (type: string, code: string, keyCode = 0) =>
    canvas.dispatchEvent(new window.KeyboardEvent(type, { code, keyCode, bubbles: true }));
  canvas.focus();
  return { display, canvas, local, key, ups, dispose,
    revoke: () => { current = false; },
    cleanup: () => { dispose(); display.remove(); local.remove(); },
  };
}

test("canvas blur releases held modifiers and ordinary keys through target keyup, once only", () => {
  const f = keyboardFixture();
  try {
    f.key("keydown", "ShiftLeft");
    f.key("keydown", "KeyW");
    f.key("keydown", "KeyW"); // Autorepeat is still only one held key.
    f.local.focus();
    expect(f.ups).toEqual(["ShiftLeft", "KeyW"]);
    f.canvas.focus(); f.local.focus();
    expect(f.ups).toHaveLength(2);
    f.canvas.focus();
    f.key("keydown", "KeyW"); f.key("keyup", "KeyW");
    f.local.focus();
    expect(f.ups).toEqual(["ShiftLeft", "KeyW", "KeyW"]);
  } finally { f.cleanup(); }
});

test("legacy physical keyCode is preserved on release without retaining typed text", () => {
  const f = keyboardFixture();
  try {
    f.key("keydown", "", 16);
    f.local.focus();
    expect(f.ups).toEqual(["16"]);
  } finally { f.cleanup(); }
});

test("revocation, canvas replacement and disposal never replay held keys into another viewer", () => {
  for (const mode of ["revoke", "replace", "dispose"]) {
    const f = keyboardFixture();
    try {
      f.key("keydown", "ShiftLeft");
      const replacement = document.createElement("canvas");
      let newUps = 0;
      replacement.addEventListener("keyup", () => { newUps++; });
      if (mode === "revoke") f.revoke();
      else if (mode === "replace") f.display.replaceChildren(replacement);
      else f.dispose();
      f.local.focus();
      expect(f.ups).toEqual([]);
      expect(newUps).toBe(0);
    } finally { f.cleanup(); }
  }
});
