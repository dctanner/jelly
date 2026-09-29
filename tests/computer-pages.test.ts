import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "playwright-core";
import { Computer } from "../src/server/computer";

class TestPage extends EventEmitter {
  closed = false;
  visited: string[] = [];
  isClosed() {
    return this.closed;
  }
  close() {
    this.closed = true;
    this.emit("close");
  }
  async goto(url: string) {
    if (this.closed) throw new Error("Target page has been closed");
    this.visited.push(url);
    return { status: () => 200 };
  }
  url() {
    return this.visited.at(-1) ?? "about:blank";
  }
  async screenshot() {
    if (this.closed) throw new Error("Target page has been closed");
    return Buffer.from("test-image");
  }
}

function fixture() {
  const computer = new Computer("/unused");
  // Exercise page lifecycle and public actions without launching a desktop.
  const internals = computer as unknown as {
    status: string;
    context: BrowserContext;
    page?: TestPage;
    trackPage(page: Page): void;
  };
  const pages: TestPage[] = [];
  let created = 0;
  function add(opener?: TestPage) {
    const page = new TestPage();
    pages.push(page);
    internals.trackPage(page as unknown as Page);
    opener?.emit("popup", page);
    return page;
  }
  internals.status = "ready";
  internals.context = {
    pages: () => pages.filter((page) => !page.closed),
    newPage: async () => {
      created++;
      return add();
    },
  } as unknown as BrowserContext;
  return { computer, internals, add, created: () => created };
}

const target = "https://example.com/campaigns";

test("closed login popup returns to its opener, not another surviving tab", async () => {
  const f = fixture();
  const opener = f.add();
  f.add();
  const popup = f.add(opener);
  popup.close();
  expect(f.internals.page).toBe(opener);
  expect(await f.computer.action("screenshot")).toEqual({
    image: Buffer.from("test-image").toString("base64"),
  });
  expect(await f.computer.action("open", { url: target })).toEqual({
    url: target,
    status: 200,
  });
  expect(opener.visited).toEqual([target]);
  expect(f.created()).toBe(0);
});

test("closing an older popup does not steal selection from a newer tab", () => {
  const f = fixture();
  const opener = f.add();
  const popup = f.add(opener);
  const newest = f.add();
  popup.close();
  expect(f.internals.page).toBe(newest);
});

test("closed opener falls back to another surviving tab", async () => {
  const f = fixture();
  const opener = f.add();
  const other = f.add();
  const popup = f.add(opener);
  opener.close();
  popup.close();
  await f.computer.action("open", { url: target });
  expect(other.visited).toEqual([target]);
  expect(f.created()).toBe(0);
});

test("action recovers a stale closed page even without a close event", async () => {
  const f = fixture();
  const live = f.add();
  const stale = f.add();
  stale.closed = true;
  await f.computer.action("screenshot");
  await f.computer.action("open", { url: target });
  expect(f.internals.page).toBe(live);
  expect(live.visited).toEqual([target]);
  expect(f.created()).toBe(0);
});

test("login handoff also recovers a stale page and still blocks agent actions", async () => {
  const f = fixture();
  const live = f.add();
  f.add().closed = true;
  await f.computer.reserveLogin("login-test", target);
  expect(live.visited).toEqual([target]);
  await expect(f.computer.action("screenshot")).rejects.toThrow("person");
  f.computer.cancelLogin("login-test");
  await f.computer.action("screenshot");
  expect(f.created()).toBe(0);
});

test("creates a page only if no live pages remain in the context", async () => {
  const f = fixture();
  f.add().close();
  expect(f.created()).toBe(0);
  await f.computer.action("open", { url: target });
  await f.computer.action("screenshot");
  expect(f.created()).toBe(1);
  expect(f.internals.page?.visited).toEqual([target]);
});

test("page recovery never bypasses human control", async () => {
  const f = fixture();
  f.add().close();
  await f.computer.take("human-session");
  await expect(f.computer.action("open", { url: target })).rejects.toThrow(
    "person",
  );
  expect(f.created()).toBe(0);
  await f.computer.release("human-session");
  await f.computer.action("open", { url: target });
  expect(f.created()).toBe(1);
});

test("human takeover while a replacement page is opening prevents navigation", async () => {
  const f = fixture();
  let finish!: (page: Page) => void;
  let started!: () => void;
  const opening = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.internals.context.newPage = () =>
    new Promise<Page>((resolve) => {
      finish = resolve;
      started();
    });
  const action = f.computer.action("open", { url: target });
  const failed = action.catch((error: unknown) => error);
  await opening;
  const takeover = f.computer.take("human-session");
  const page = f.add();
  finish(page as unknown as Page);
  const error = await failed;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("person");
  await takeover;
  expect(page.visited).toEqual([]);
  await f.computer.release("human-session");
});

test("clipboard requests queued behind return-to-agent cannot use expired human ownership", async () => {
  const f = fixture();
  f.add();
  await f.computer.take("owner");
  await expect(f.computer.clipboard("other", "read")).rejects.toThrow("controlling window");
  const returning = f.computer.release("owner");
  const stale = f.computer.clipboard("owner", "read");
  await returning;
  await expect(stale).rejects.toThrow("controlling window");
  expect(f.computer.state().control).toBe("agent");
});
