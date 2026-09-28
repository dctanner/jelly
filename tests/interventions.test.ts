import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSudoExecutor } from "../src/server/sudo";
import { startApp } from "./fixtures/app";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "jelly-approval-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function until(fn: () => boolean) {
  const end = Date.now() + 4000;
  while (!fn()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function helper(dir: string, code: string) {
  const path = join(dir, crypto.randomUUID());
  writeFileSync(path, "#!/usr/bin/python3\n" + code, { mode: 0o700 });
  return path;
}
const command = {
  executable: "/usr/bin/id",
  args: ["-u"],
  cwd: "/tmp",
  reason: "Test exact command",
};
test("sudo askpass has a separate secret channel; stdout/stderr are redacted and stdin is EOF", async () => {
  const dir = temp(),
    secret = "test-private-92847",
    password = Buffer.from(secret);
  const fake = helper(
    dir,
    `import os,sys,subprocess\nassert sys.argv[1:4]==['-k','-A','--']\nassert sys.stdin.buffer.read()==b''\nassert '${secret}' not in str(os.environ)\np=subprocess.check_output([os.environ['SUDO_ASKPASS']]).strip()\nsys.stdout.buffer.write(b'ok:'+p)\nsys.stderr.buffer.write(p)\n`,
  );
  const result = await createSudoExecutor(fake)(
    command,
    password,
    new AbortController().signal,
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("ok:[redacted]");
  expect(result.stderr).toBe("[redacted]");
  expect(password.every((b) => b === 0)).toBe(true);
  const nopass = helper(
    dir,
    "import sys\nprint('stdin-bytes='+str(len(sys.stdin.buffer.read())))\n",
  );
  expect(
    (
      await createSudoExecutor(nopass)(
        command,
        Buffer.from(secret),
        new AbortController().signal,
      )
    ).stdout.trim(),
  ).toBe("stdin-bytes=0");
});
test("sudo redacts split Unicode output before applying output limits", async () => {
  const dir = temp();
  const secret = "private-🔒-long";
  const fake = helper(
    dir,
    `import os,subprocess,sys\np=subprocess.check_output([os.environ['SUDO_ASKPASS']]).strip()\nsys.stdout.buffer.write(b'x'*63999+p[:9]);sys.stdout.flush()\nsys.stdout.buffer.write(p[9:])\n`,
  );
  const result = await createSudoExecutor(fake)(
    command,
    Buffer.from(secret),
    new AbortController().signal,
  );
  expect(result.stdout).toHaveLength(64000);
  expect(result.stdout.endsWith("[")).toBe(true);
  expect(result.stdout).not.toContain("private");
});
test("sudo timeout, abort and authentication failures terminate without leaking secrets", async () => {
  const dir = temp(),
    sleep = helper(dir, "import time\ntime.sleep(10)\n");
  expect(
    (
      await createSudoExecutor(sleep, 30)(
        command,
        Buffer.from("private"),
        new AbortController().signal,
      )
    ).timedOut,
  ).toBe(true);
  const controller = new AbortController();
  const job = createSudoExecutor(sleep)(
    command,
    Buffer.from("private"),
    controller.signal,
  );
  controller.abort();
  expect((await job).cancelled).toBe(true);
  const fail = helper(
    dir,
    "import os,subprocess,sys\nsubprocess.check_output([os.environ['SUDO_ASKPASS']])\nprint('Authentication failed',file=sys.stderr)\nsys.exit(1)\n",
  );
  expect(
    (
      await createSudoExecutor(fail)(
        command,
        Buffer.from("private"),
        new AbortController().signal,
      )
    ).exitCode,
  ).toBe(1);
});
async function fixture(ttl = 10000, delay = false) {
  let executions = 0;
  const dir = temp();
  const app = await startApp({
    dataDir: dir,
    configDir: join(dir, "config"),
    port: 0,
    fixtureDelayMs: 1,
    interventionTtlMs: ttl,
    sudoExecutor: async (_command, password, signal) => {
      if (!password.length)
        return {
          exitCode: 1,
          stdout: "",
          stderr: "sudo: a password is required",
          cancelled: false,
          timedOut: false,
        };
      executions++;
      expect(password.toString()).toBe("test-only-password");
      if (delay)
        await new Promise<void>((r) => {
          signal.addEventListener("abort", () => r(), { once: true });
        });
      password.fill(0);
      return {
        exitCode: 0,
        stdout: "0\n",
        stderr: "",
        cancelled: signal.aborted,
        timedOut: false,
      };
    },
  });
  app.service.setMode("api");
  cleanups.push(() => app.close());
  const url = String(app.server.url).replace(/\/$/, "");
  const id = app.store.agents()[0]!.id;
  const req = (
    path: string,
    data?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(url + "/api" + path, {
      method: data === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  return { app, dir, url, id, req, executions: () => executions };
}
async function session(req: Awaited<ReturnType<typeof fixture>>["req"]) {
  const res = await req("/control-session");
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return { cookie, "x-jelly-csrf": (await res.json()).csrf as string };
}
async function requestSudo(f: Awaited<ReturnType<typeof fixture>>) {
  f.app.service.start(f.id, crypto.randomUUID(), "/fixture sudo");
  await until(() =>
    f.app.store.interventions().some((i) => i.status === "pending"),
  );
  return f.app.store.interventions().find((i) => i.status === "pending")!;
}
test("real Pi pauses, session+CSRF approval is single-use, resumes and never persists the password", async () => {
  const f = await fixture(),
    item = await requestSudo(f),
    headers = await session(f.req);
  expect(f.app.store.agent(f.id)?.status).toBe("waiting");
  const path = `/interventions/${item.id}/approve`,
    body = { password: "test-only-password" };
  expect((await f.req(path, body)).status).toBe(401);
  expect((await f.req(path, body, { cookie: headers.cookie })).status).toBe(
    403,
  );
  expect(
    (
      await f.req(path, body, {
        ...headers,
        Origin: "https://attacker.example",
      })
    ).status,
  ).toBe(403);
  expect(f.executions()).toBe(0);
  expect((await f.req(path, body, headers)).status).toBe(200);
  expect((await f.req(path, body, headers)).status).toBe(409);
  await f.app.service.settled();
  expect(f.executions()).toBe(1);
  expect(f.app.store.intervention(item.id)?.status).toBe("completed");
  expect(f.app.store.agent(f.id)?.status).toBe("idle");
  expect(JSON.stringify(f.app.service.snapshot())).not.toContain(
    "test-only-password",
  );
  expect(JSON.stringify(f.app.store.history(f.id))).not.toContain(
    "test-only-password",
  );
  f.app.store.db.exec("PRAGMA wal_checkpoint(FULL)");
  expect(
    readFileSync(join(f.dir, "jelly.sqlite")).includes(
      Buffer.from("test-only-password"),
    ),
  ).toBe(false);
});
test("denial, expiry and stop settle the waiting Pi run and cannot execute later", async () => {
  const f = await fixture(),
    headers = await session(f.req),
    item = await requestSudo(f);
  expect(
    (await f.req(`/interventions/${item.id}/deny`, {}, headers)).status,
  ).toBe(200);
  await f.app.service.settled();
  expect(f.app.store.intervention(item.id)?.status).toBe("denied");
  const stopped = await requestSudo(f);
  await f.app.service.stop(f.id);
  expect(f.app.store.intervention(stopped.id)?.status).toBe("cancelled");
  expect(
    (
      await f.req(
        `/interventions/${stopped.id}/approve`,
        { password: "test-only-password" },
        headers,
      )
    ).status,
  ).toBe(409);
  const exp = await fixture(30);
  const expired = await requestSudo(exp);
  await exp.app.service.settled();
  expect(exp.app.store.intervention(expired.id)?.status).toBe("expired");
  expect(f.executions()).toBe(0);
});
test("stop waits for an executing command to abort before settling the run", async () => {
  const f = await fixture(10000, true),
    headers = await session(f.req),
    item = await requestSudo(f);
  const approval = f.req(
    `/interventions/${item.id}/approve`,
    { password: "test-only-password" },
    headers,
  );
  await until(() => f.executions() === 1);
  await f.app.service.stop(f.id);
  expect((await approval).status).toBe(200);
  expect(f.app.store.intervention(item.id)?.status).toBe("cancelled");
  expect(f.app.store.runs(f.id)[0]?.status).toBe("cancelled");
});
test("startup interrupts stale approvals and rejects their execution", async () => {
  const dir = temp();
  let app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
  const id = app.store.agents()[0]!.id;
  const run = app.store.createRun(
    id,
    "interrupted",
    "request",
    "demo",
    "local-demo",
  );
  const item = app.store.createIntervention(
    "sudo",
    id,
    run.id,
    command as unknown as Record<string, unknown>,
    new Date(Date.now() + 60000).toISOString(),
  );
  await app.close();
  app = await startApp({ dataDir: dir, configDir: join(dir, "config"), port: 0 });
  cleanups.push(() => app.close());
  expect(app.store.intervention(item.id)?.status).toBe("interrupted");
  await expect(
    app.service.interventions.approveSudo(item.id, Buffer.from("secret")),
  ).rejects.toThrow("no longer");
});

test("sudo executes without approval when the OS permits, and ordinary failures are not retried", async () => {
  for (const exitCode of [0, 7]) {
    const dir = temp();
    let executions = 0;
    const app = await startApp({
      dataDir: dir,
      configDir: join(dir, "config"),
      port: 0,
      fixtureDelayMs: 1,
      sudoExecutor: async (_command, password) => {
        executions++;
        expect(password.length).toBe(0);
        return {
          exitCode,
          stdout: "automatic",
          stderr: exitCode ? "command failed" : "",
          cancelled: false,
          timedOut: false,
        };
      },
    });
    try {
      app.service.setMode("api");
      const id = app.store.agents()[0]!.id;
      app.service.start(id, crypto.randomUUID(), "/fixture sudo");
      await app.service.settled();
      expect(executions).toBe(1);
      expect(app.store.interventions()).toHaveLength(0);
      expect(
        app.store.events(0, id).some((e) => e.type === "tool_completed"),
      ).toBe(true);
    } finally {
      await app.close();
    }
  }
});
