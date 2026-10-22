await import("./dom");
import { test, expect, afterEach } from "bun:test";
import { createRef } from "react";
import { ComputerClipboard } from "../src/client/ComputerClipboard";
const { render, screen, fireEvent, waitFor, cleanup } =
  await import("@testing-library/react");
const fetchOriginal = globalThis.fetch;
const clipboardOriginal = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
const itemOriginal = globalThis.ClipboardItem;
afterEach(() => {
  cleanup();
  globalThis.fetch = fetchOriginal;
  if (clipboardOriginal)
    Object.defineProperty(navigator, "clipboard", clipboardOriginal);
  else delete (navigator as any).clipboard;
  globalThis.ClipboardItem = itemOriginal;
});
const gate = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
function fixture(clipboard: object = {}) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
  const calls: any[] = [],
    keys: any[] = [];
  let response = async (direction: string) =>
    direction === "receive" ? { text: "雪\n🪼" } : { ok: true };
  globalThis.fetch = (async (url, options) => {
    if (String(url).endsWith("control-session"))
      return Response.json({ csrf: "fixture" });
    const body = JSON.parse(String(options?.body));
    calls.push({ url, body });
    return Response.json(await response(String(url).split("/").at(-1)!));
  }) as typeof fetch;
  const connection = {
    current: {
      focus() {},
      sendKey(...args: any[]) {
        keys.push(args);
      },
    },
  };
  const display = createRef<HTMLDivElement>();
  let identity = { controlId: "take", generation: 3 },
    connected = true;
  const panel = () => (
    <>
      <div ref={display} data-testid="viewer" tabIndex={0} />
      <ComputerClipboard
        identity={identity}
        connected={connected}
        connection={connection}
        screen={display}
      />
    </>
  );
  const view = render(panel());
  return {
    calls,
    keys,
    connection,
    display,
    view,
    response(fn: typeof response) {
      response = fn;
    },
    change(next: typeof identity, live = true) {
      identity = next;
      connected = live;
      view.rerender(panel());
    },
  };
}
test("clipboard is never read on mount, options or reconnect; Unicode send-only and empty text are deliberate", async () => {
  let reads = 0;
  const f = fixture({
    readText: async () => {
      reads++;
      return "雪\n🪼";
    },
  });
  expect(reads).toBe(0);
  expect(f.calls).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Text options" }));
  fireEvent.change(screen.getByLabelText("Text to computer"), {
    target: { value: "雪\n🪼" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send without pasting" }));
  await screen.findByText(/Not pasted/);
  expect(f.calls[0].body).toEqual({
    controlId: "take",
    generation: 3,
    text: "雪\n🪼",
  });
  expect(f.keys).toHaveLength(0);
  expect(reads).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Send without pasting" }));
  await waitFor(() => expect(f.calls).toHaveLength(2));
  expect(f.calls[1].body.text).toBe("");
  f.change({ controlId: "new", generation: 4 });
  expect(reads).toBe(0);
});
test("permission denial and HTTP without APIs offer editable manual fallback, preserve failed drafts and never leak errors", async () => {
  const f = fixture({
    readText: async () => {
      throw new Error("secret native error");
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Paste to computer" }));
  await screen.findByText(/Paste access is unavailable/);
  fireEvent.change(screen.getByLabelText("Text to computer"), {
    target: { value: "keep\n🪼" },
  });
  f.response(async () => {
    throw new Error("secret native error");
  });
  fireEvent.click(screen.getByRole("button", { name: "Send & paste" }));
  await screen.findByText(/Transfer was not confirmed/);
  expect(
    (screen.getByLabelText("Text to computer") as HTMLTextAreaElement).value,
  ).toBe("keep\n🪼");
  expect(screen.queryByText(/secret native/)).toBeNull();
  expect(f.keys).toHaveLength(0);
  f.response(async () => ({ ok: true }));
  fireEvent.click(screen.getByRole("button", { name: "Send & paste" }));
  await screen.findByText(/Paste shortcut sent/);
  expect(f.keys.some((k) => k[0] === 0x76 && k[2])).toBe(true);
  const paste = f.keys.findIndex(k => k[0] === 0x76 && k[2]);
  for (const alt of [0xffe9, 0xffea])
    expect(f.keys.slice(0, paste).some(k => k[0] === alt && k[2] === false)).toBe(true);
});
test("late navigator promise and late server ACK cannot paste into a replacement viewer", async () => {
  for (const stage of ["navigator", "server"]) {
    const pending = gate<string>();
    const f = fixture({
      readText: () =>
        stage === "navigator" ? pending.promise : Promise.resolve("private"),
    });
    if (stage === "server")
      f.response(async () => {
        await pending.promise;
        return { ok: true };
      });
    fireEvent.click(screen.getByRole("button", { name: "Paste to computer" }));
    if (stage === "server")
      await waitFor(() => expect(f.calls).toHaveLength(1));
    f.change({ controlId: "replacement", generation: 8 });
    pending.resolve("private");
    await new Promise((r) => setTimeout(r, 10));
    expect(f.keys).toHaveLength(0);
    if (stage === "navigator") expect(f.calls).toHaveLength(0);
    f.view.unmount();
  }
});
test("manual receive distinguishes empty text from no supported text and clears on disconnect", async () => {
  const f = fixture();
  f.response(async () => ({ text: "" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy from computer" }));
  await screen.findByText(/contains empty text/);
  expect(
    (screen.getByLabelText("Text from computer") as HTMLTextAreaElement).value,
  ).toBe("");
  f.change({ controlId: "take", generation: 3 }, false);
  expect(screen.queryByLabelText("Text from computer")).toBeNull();
  expect(
    (
      screen.getByRole("button", {
        name: "Copy from computer",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  f.change({ controlId: "take", generation: 3 });
  f.response(async () => {
    throw new Error("no text");
  });
  fireEvent.click(screen.getByRole("button", { name: "Copy from computer" }));
  await screen.findByText(/Could not receive text/);
  expect(screen.queryByLabelText("Text from computer")).toBeNull();
});
test("Safari-style promised ClipboardItem is written in the gesture, never before; stale reads reject", async () => {
  let written: Promise<Blob> | undefined;
  globalThis.ClipboardItem = class {
    constructor(public items: any) {}
  } as any;
  const pending = gate<{ text: string }>();
  const f = fixture({
    write: async (items: any[]) => {
      written = items[0].items["text/plain"];
      await written;
    },
  });
  f.response(() => pending.promise);
  expect(written).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Copy from computer" }));
  expect(written).toBeDefined();
  f.change({ controlId: "new", generation: 4 });
  pending.resolve({ text: "stale" });
  await expect(written!).rejects.toThrow();
  expect(screen.queryByLabelText("Text from computer")).toBeNull();
});
test("focused viewer paste consumes real event text without permissions, supports terminal shortcut and rejects files/oversize", async () => {
  let reads = 0;
  const f = fixture({
    readText: async () => {
      reads++;
      return "wrong";
    },
  });
  fireEvent.keyDown(f.display.current!, {
    code: "KeyV",
    key: "v",
    ctrlKey: true,
    shiftKey: true,
  });
  fireEvent.paste(f.display.current!, {
    clipboardData: {
      types: ["text/plain"],
      files: [],
      getData: () => "雪\n🪼",
    },
  });
  await screen.findByText(/Paste shortcut sent/);
  expect(reads).toBe(0);
  expect(f.calls[0].body.text).toBe("雪\n🪼");
  expect(f.keys.some((k) => k[0] === 0xffe1 && k[2])).toBe(true);
  fireEvent.paste(f.display.current!, {
    clipboardData: { types: ["Files"], files: [{}] },
  });
  await screen.findByText(/Only text can be transferred/);
  fireEvent.paste(f.display.current!, {
    clipboardData: {
      types: ["text/plain"],
      files: [],
      getData: () => "🪼".repeat(65537),
    },
  });
  await screen.findByText(/Use valid Unicode text up to/);
  expect(f.calls).toHaveLength(1);
});

test("promised copy preserves Unicode/newlines and empty text, permission denial retains a manual result", async () => {
  globalThis.ClipboardItem = class {
    constructor(public items: any) {}
  } as any;
  for (const value of ["雪\n🪼", ""]) {
    let copied: string | undefined;
    const f = fixture({
      write: async (items: any[]) => {
        copied = await (await items[0].items["text/plain"]).text();
      },
    });
    f.response(async () => ({ text: value }));
    fireEvent.click(screen.getByRole("button", { name: "Copy from computer" }));
    await waitFor(() => expect(copied).toBe(value));
    await screen.findByText(
      value ? "Copied to this device." : "Empty text copied to this device.",
    );
    expect(screen.queryByLabelText("Text from computer")).toBeNull();
    f.view.unmount();
  }
  const f = fixture({
    write: async () => {
      throw new Error("denied");
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Copy from computer" }));
  await screen.findByLabelText("Text from computer");
  expect(
    (screen.getByLabelText("Text from computer") as HTMLTextAreaElement).value,
  ).toBe("雪\n🪼");
  f.view.unmount();
});

test("modern clipboard read rejects non-text without clearing the computer; busy disables duplicate transfers and disconnect clears drafts", async () => {
  const f = fixture({ read: async () => [{ types: ["image/png"] }] });
  fireEvent.click(screen.getByRole("button", { name: "Paste to computer" }));
  await screen.findByText(/Only text can be transferred/);
  expect(f.calls).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Text options" }));
  fireEvent.change(screen.getByLabelText("Text to computer"), {
    target: { value: "private draft" },
  });
  const pending = gate<{ ok: boolean }>();
  f.response(() => pending.promise);
  fireEvent.click(screen.getByRole("button", { name: "Send & paste" }));
  await waitFor(() => expect(f.calls).toHaveLength(1));
  expect(
    (
      screen.getByRole("button", {
        name: "Copy from computer",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  f.change({ controlId: "take", generation: 3 }, false);
  pending.resolve({ ok: true });
  await new Promise((r) => setTimeout(r, 5));
  expect(f.keys).toHaveLength(0);
  f.change({ controlId: "take", generation: 4 });
  fireEvent.click(screen.getByRole("button", { name: "Text options" }));
  expect(
    (screen.getByLabelText("Text to computer") as HTMLTextAreaElement).value,
  ).toBe("");
});

test("readText-only browsers never mistake unsupported clipboard data for a deliberate empty send", async () => {
  const f = fixture({ readText: async () => "" });
  fireEvent.click(screen.getByRole("button", { name: "Paste to computer" }));
  await screen.findByText(/empty or unreadable clipboard text/);
  expect(f.calls).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Send without pasting" }));
  await screen.findByText(/Not pasted/);
  expect(f.calls[0].body.text).toBe("");
});
