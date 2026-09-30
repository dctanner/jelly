import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Computer } from "../src/server/computer";
import { ControlSessions } from "../src/server/control-session";
import { startApp } from "../src/server/app";

function desktop(computer = new Computer("/unused")) {
  const internal = computer as any;
  let cleanups = 0;
  const pages: any[] = [];
  const page = () => {
    const p = {
      url: "private",
      closed: false,
      goto: async (url: string) => {
        p.url = url;
      },
      close: async () => {
        p.closed = true;
      },
    };
    pages.push(p);
    return p;
  };
  internal.status = "ready";
  internal.cleanup = async () => {
    cleanups++;
  };
  internal.launch = async () => {
    page(); // Simulate a restored private tab: must be closed before ownership changes.
    internal.context = {
      pages: () => pages.filter((p) => !p.closed),
      newPage: async () => page(),
    };
  };
  return { computer, internal, pages, cleanups: () => cleanups };
}

test("expired control cookie can recover without exposing the old desktop or resuming agents", async () => {
  const f = desktop();
  const sessions = new ControlSessions();
  const first = sessions.create(
    new Request("http://localhost/api/control-session"),
  );
  await f.computer.take(first.session.id);
  first.session.expires = Date.now() - 1;
  const replacement = sessions.create(
    new Request("http://localhost/api/control-session", {
      headers: { cookie: first.cookie.split(";")[0]! },
    }),
  );
  expect(replacement.session.id).not.toBe(first.session.id);
  await expect(f.computer.take(replacement.session.id)).rejects.toThrow(
    "Another Jelly window",
  );
  let revoked = false;
  f.computer.attach(() => {
    revoked = true;
  });
  const state = await f.computer.recover(replacement.session.id);
  expect(revoked).toBe(true);
  expect(f.cleanups()).toBe(1);
  expect(f.pages[0].closed).toBe(true);
  expect(f.pages[1].url).toBe("about:blank");
  expect(state).toMatchObject({
    control: "human",
    owned: true,
    status: "ready",
    handoffId: null,
  });
  await expect(f.computer.action("screenshot")).rejects.toThrow("person");
  await expect(f.computer.release(first.session.id)).rejects.toThrow(
    "controlling window",
  );
  await f.computer.release(replacement.session.id);
  expect(f.computer.state().control).toBe("agent");
});

test("recovery is exclusive and failure remains private and retryable", async () => {
  const f = desktop();
  await f.computer.take("lost-cookie");
  let finish!: () => void;
  const normalLaunch = f.internal.launch;
  f.internal.launch = () =>
    new Promise<void>((r) => {
      finish = r;
    });
  const reset = f.computer.recover("replacement");
  while (!finish) await new Promise((r) => setTimeout(r, 0));
  await expect(f.computer.take("intruder")).rejects.toThrow("recovery");
  await expect(f.computer.recover("intruder")).rejects.toThrow("recovery");
  await expect(f.computer.ensure()).rejects.toThrow("recovery");
  await expect(f.computer.action("screenshot")).rejects.toThrow("person");
  // Simulate a launch that cannot provide a context.
  finish();
  await expect(reset).rejects.toThrow("Could not reset");
  expect(f.computer.state()).toMatchObject({
    control: "human",
    owned: false,
    status: "error",
  });
  await expect(f.computer.ensure()).rejects.toThrow("Recover lost control");
  await expect(f.computer.take("replacement")).rejects.toThrow("recovery");
  f.internal.launch = normalLaunch;
  expect((await f.computer.recover("replacement")).owned).toBe(true);
});

test("HTTP recovery requires session, CSRF and explicit destructive confirmation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-recovery-"));
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    authPath: join(dir, "auth.json"),
    port: 0,
  });
  const agentId = app.store.agents()[0]!.id;
  const f = desktop(app.service.computer.get(agentId));
  const post = (headers: Record<string, string>, confirm?: string) =>
    fetch(new URL(`/api/computer/recover?agentId=${agentId}`, app.server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ confirm }),
    });
  try {
    await f.computer.take("lost-cookie");
    expect((await post({})).status).toBe(401);
    const response = await fetch(
      new URL("/api/control-session", app.server.url),
    );
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const csrf = (await response.json()).csrf;
    expect((await post({ cookie }, "discard-private-desktop")).status).toBe(
      403,
    );
    const headers = { cookie, "x-jelly-csrf": csrf };
    expect((await post(headers)).status).toBe(400);
    expect(f.cleanups()).toBe(0);
    const result = await post(headers, "discard-private-desktop");
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      owned: true,
      control: "human",
    });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
