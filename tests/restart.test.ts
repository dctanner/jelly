import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Snapshot } from "../src/shared/types";

for (const transport of ["tcp", "tls"]) {
  test(`server startup prevents Bun's fatal multi-address ${transport} timer`, async () => {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/runtime-network.ts", transport],
      {
        cwd: resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("Handled connect failure; process survived; loopback connection passed.");
    } finally {
      clearTimeout(timeout);
      child.kill();
    }
  }, 20000);
}

async function launch(dir: string) {
  const child = Bun.spawn(["bun", "tests/fixtures/server.ts"], {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      JELLY_DATA_DIR: dir,
      JELLY_CONFIG_DIR: join(dir, "config"),
      JELLY_AUTH_FILE: join(dir, "auth.json"),
      JELLY_PORT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let log = "";
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    while (true) {
      const part = await reader.read();
      if (part.done)
        throw new Error(
          `Server failed: ${log} ${await new Response(child.stderr).text()}`,
        );
      log += new TextDecoder().decode(part.value);
      const match = log.match(/Jelly server: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) return { child, url: match[1]! };
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}
test("a fresh process recovers SQLite identity, profiles, transcript and interrupted work after a crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jelly-restart-"));
  let process = await launch(dir);
  let authenticatedUrl = "";
  let authorization: Record<string, string> = {};
  const request = async (path: string, method = "GET", data?: unknown) => {
    if (authenticatedUrl !== process.url) {
      const bootstrap = await fetch(process.url + "/api/control-session");
      authorization = {
        cookie: bootstrap.headers.get("set-cookie")!.split(";")[0]!,
        "x-jelly-csrf": (await bootstrap.json()).csrf,
      };
      authenticatedUrl = process.url;
    }
    const r = await fetch(process.url + path, {
      method,
      headers: { "Content-Type": "application/json", ...authorization },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    expect(r.ok).toBe(true);
    return r.json();
  };
  const state = () => request("/api/state") as Promise<Snapshot>;
  async function waitFor(predicate: (s: Snapshot) => boolean) {
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      const s = await state();
      if (predicate(s)) return s;
      await Bun.sleep(10);
    }
    throw new Error("Timed out waiting for persisted run");
  }
  try {
    const initial = await state();
    const id = initial.agents[0]!.id;
    await request("/api/config", "PUT", { mode: "api" });
    await request(`/api/agents/${id}`, "PATCH", {
      name: "Persistent Jelly",

      instructions: "Remember the context",
      color: "#a4c8e8",
    });
    await request(`/api/agents/${id}/messages`, "POST", {
      text: "Remember the word marmalade",
      requestId: "first",
    });
    await waitFor((s) => s.runs[0]?.status === "completed");
    await request(`/api/agents/${id}/messages`, "POST", {
      text: "Interrupt this run",
      requestId: "interrupted",
    });
    await waitFor((s) =>
      s.events.some(
        (e) => e.type === "tool_started" && e.runId === s.runs[1]?.id,
      ),
    );
    process.child.kill("SIGKILL");
    await process.child.exited;
    process = await launch(dir);
    const recovered = await state();
    expect(recovered.instance.id).toBe(initial.instance.id);
    expect(recovered.agents[0]?.id).toBe(id);
    expect(recovered.agents[0]?.name).toBe("Persistent Jelly");
    expect(recovered.agents[0]?.instructions).toBe("Remember the context");
    expect(recovered.config.mode).toBe("api");
    expect(recovered.runs[0]?.status).toBe("completed");
    expect(recovered.runs[1]?.status).toBe("interrupted");
    expect(recovered.agents[0]?.status).toBe("interrupted");
    expect(
      recovered.events.some(
        (e) =>
          e.type === "message" && e.data.text === "Remember the word marmalade",
      ),
    ).toBe(true);
    expect(recovered.events.at(-1)?.type).toBe("run_interrupted");
    await request(`/api/agents/${id}/messages`, "POST", {
      text: "Continue after restart",
      requestId: "third",
    });
    const continued = await waitFor((s) => s.runs[2]?.status === "completed");
    expect(
      continued.events.filter((e) => e.type === "message").at(-1)?.data.text,
    ).toContain("3 saved user messages");
    expect(continued.agents[0]?.status).toBe("idle");
  } finally {
    process.child.kill("SIGTERM");
    await process.child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 45000);

test("idle restart readiness uses public health, not unauthenticated private state", async () => {
  const script = await Bun.file(
    new URL("../scripts/restart-when-idle.sh", import.meta.url),
  ).text();
  expect(script).toContain('"$tailnet/api/health"');
  expect(script).not.toContain("box.tailbfab3f.ts.net");
  expect(script).not.toContain("/api/state");
});

test("restart helper discovers canonical private origins without restart, live registry access or public/credential-bearing URLs", async () => {
  const root = mkdtempSync(join(tmpdir(), "jelly-restart-origin-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "bin"));
    const helper = join(root, "scripts", "restart-when-idle.sh");
    writeFileSync(
      helper,
      await Bun.file(
        new URL("../scripts/restart-when-idle.sh", import.meta.url),
      ).text(),
      { mode: 0o700 },
    );
    const status = join(root, "status.json");
    writeFileSync(
      join(root, "bin", "tailscale"),
      '#!/bin/bash\n/bin/cat "$JELLY_RESTART_TEST_STATUS"\n',
      { mode: 0o700 },
    );
    const discover = async (value: unknown, port = "5173") => {
      writeFileSync(status, JSON.stringify(value));
      const child = Bun.spawn(
        [
          "bash",
          "-c",
          'systemctl() { echo "RESTART FORBIDDEN" >&2; return 99; }; source "$1"; private_tailnet_origin "$2"',
          "test",
          helper,
          port,
        ],
        {
          env: {
            ...process.env,
            PATH: `${join(root, "bin")}:${process.env.PATH}`,
            JELLY_RESTART_TEST_STATUS: status,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      return {
        code: await child.exited,
        output: (await new Response(child.stdout).text()).trim(),
        error: await new Response(child.stderr).text(),
      };
    };
    const connected = {
      BackendState: "Running",
      TailscaleIPs: ["100.64.0.2"],
      Self: { DNSName: "fixture.tailtest.ts.net." },
    };
    expect(await discover(connected)).toEqual({
      code: 0,
      output: "http://fixture.tailtest.ts.net:5173",
      error: "",
    });
    expect(await discover({ ...connected, Self: {} }, "5432")).toEqual({
      code: 0,
      output: "http://100.64.0.2:5432",
      error: "",
    });
    expect(
      await discover({
        ...connected,
        Self: {},
        TailscaleIPs: ["fd7a:115c:a1e0::1234"],
      }),
    ).toEqual({
      code: 0,
      output: "http://[fd7a:115c:a1e0::1234]:5173",
      error: "",
    });
    expect(
      (
        await discover({
          ...connected,
          Self: { DNSName: "public.example.com" },
        })
      ).output,
    ).toBe("http://100.64.0.2:5173");
    for (const value of [
      { ...connected, BackendState: "NeedsLogin" },
      {
        ...connected,
        TailscaleIPs: ["192.168.1.1", "8.8.8.8", "100.63.0.1", "fd12::1"],
      },
      { ...connected, TailscaleIPs: ["fd7a:115c:a1e0::1234%unsafe"] },
    ])
      expect(await discover(value)).toEqual({ code: 1, output: "", error: "" });
    for (const port of [
      "0",
      "65536",
      "abc",
      "5173?token=fixture",
      "https://public.example.com",
    ])
      expect(await discover(connected, port)).toEqual({
        code: 1,
        output: "",
        error: "",
      });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS restart defaults follow the installed LaunchDaemon and reject a different checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "jelly-restart-launchd-"));
  try {
    mkdirSync(join(root, "scripts"));
    const helper = join(root, "scripts", "restart-when-idle.sh");
    writeFileSync(
      helper,
      await Bun.file(
        new URL("../scripts/restart-when-idle.sh", import.meta.url),
      ).text(),
    );
    const plist = join(root, "service.plist");
    const defaults = async (overrides: Record<string, unknown> = {}) => {
      const write = Bun.spawnSync(
        [
          "/usr/bin/python3",
          "-c",
          "import json, plistlib, sys; plistlib.dump(json.load(sys.stdin), open(sys.argv[1], 'wb'))",
          plist,
        ],
        {
          stdin: Buffer.from(
            JSON.stringify({
              Label: "com.jelly.server",
              WorkingDirectory: root,
              EnvironmentVariables: {
                JELLY_PORT: "3100",
                JELLY_DATA_DIR: "instance data",
                PRIVATE_TOKEN: "must-never-be-printed",
              },
              ...overrides,
            }),
          ),
        },
      );
      expect(write.exitCode).toBe(0);
      const child = Bun.spawn(
        [
          "/bin/bash",
          "-c",
          'source "$1"; macos_restart_defaults "$2"',
          "test",
          helper,
          plist,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, output: output.trim(), error };
    };
    expect(await defaults()).toEqual({
      code: 0,
      output: `3100\n${join(realpathSync(root), "instance data")}`,
      error: "",
    });
    expect(await defaults({ EnvironmentVariables: {} })).toEqual({
      code: 0,
      output: `5173\n${join(realpathSync(root), ".jelly")}`,
      error: "",
    });
    for (const overrides of [
      { Label: "com.other.server" },
      { WorkingDirectory: join(root, "other-checkout") },
      { EnvironmentVariables: { JELLY_DATA_DIR: "bad\npath" } },
    ]) {
      const result = await defaults(overrides);
      expect(result.code).toBe(1);
      expect(result.output).toBe("");
      expect(result.error).toContain("Cannot read Jelly settings");
      expect(result.error).not.toContain("must-never-be-printed");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function idleRestartFixture(
  options: {
    platform?: string;
    uid?: string;
    busy?: boolean;
    hold?: "repo" | "data";
    release?: boolean;
    missingDatabase?: boolean;
    denied?: boolean;
    loaded?: boolean;
    healthy?: boolean;
    active?: boolean;
    port?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "jelly-restart-helper-"));
  const data = join(root, "instance data");
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  mkdirSync(data);
  const helper = join(root, "scripts", "restart-when-idle.sh");
  writeFileSync(
    helper,
    await Bun.file(
      new URL("../scripts/restart-when-idle.sh", import.meta.url),
    ).text(),
  );
  if (!options.missingDatabase) {
    const db = new Database(join(data, "jelly.sqlite"));
    db.exec("CREATE TABLE runs (status TEXT NOT NULL)");
    db.query("INSERT INTO runs (status) VALUES (?)").run(
      options.busy ? "running" : "completed",
    );
    db.close();
  }
  if (options.hold) {
    const holds = join(
      options.hold === "repo" ? join(root, ".jelly") : data,
      "restart-holds",
    );
    mkdirSync(holds, { recursive: true });
    writeFileSync(join(holds, "fixture"), "owner-managed hold");
  }
  writeFileSync(
    join(root, "bin", "tailscale"),
    `#!/bin/bash
printf '%s\\n' '{"BackendState":"Running","TailscaleIPs":["100.64.0.2"],"Self":{"DNSName":"fixture.tailtest.ts.net."}}'
`,
    { mode: 0o700 },
  );
  const log = join(root, "commands.log");
  // Source a copy, then replace every service/mutation command before running its loop.
  // No fake command delegates to the host's real launchctl, sudo, systemctl or curl.
  const wrapper = `
source "$1"
uname() { printf '%s\\n' "$JELLY_RESTART_TEST_PLATFORM"; }
id() { printf '%s\\n' "$JELLY_RESTART_TEST_UID"; }
macos_restart_defaults() { printf '%s\\n' 3100 "$JELLY_RESTART_TEST_DATA"; }
# Use a fixed busy count for the 360-poll timeout test; transition tests use real SQLite.
if [ "$JELLY_RESTART_TEST_STAY_BUSY" = 1 ]; then
  active_restart_runs() { printf '%s\\n' 1; }
fi
record() { printf '%s\\n' "$*" >> "$JELLY_RESTART_TEST_LOG"; }
launchctl() {
  record launchctl "$@"
  if [ "$1" = print ]; then
    [ "$JELLY_RESTART_TEST_LOADED" = 1 ] || return 1
    if [ "$JELLY_RESTART_TEST_ACTIVE" = 1 ]; then
      printf 'system/com.jelly.server = {\\n\\tstate = running\\n}\\n'
    else
      printf 'system/com.jelly.server = {\\n\\tstate = waiting\\n}\\n'
    fi
  fi
}
sudo() {
  record sudo "$@"
  [ "$JELLY_RESTART_TEST_DENIED" = 0 ] || return 1
  [ "$1" = -n ] || return 99
  shift
  "$@"
}
systemctl() {
  record systemctl "$@"
  if [ "$2" = is-active ] && [ "$4" = jelly.service ]; then
    [ "$JELLY_RESTART_TEST_ACTIVE" = 1 ]
  fi
}
curl() { record curl "$@"; [ "$JELLY_RESTART_TEST_HEALTHY" = 1 ]; }
sleep() {
  record sleep "$@"
  if [ "$1" = 5 ] && [ "$JELLY_RESTART_TEST_RELEASE" = 1 ]; then
    /bin/rm -f "$repo/.jelly/restart-holds/fixture" "$JELLY_RESTART_TEST_DATA/restart-holds/fixture"
    /usr/bin/python3 -c 'import sqlite3, sys; db=sqlite3.connect(sys.argv[1]); db.execute("UPDATE runs SET status=?", ("completed",)); db.commit(); db.close()' "$JELLY_RESTART_TEST_DATA/jelly.sqlite"
  fi
}
restart_main
`;
  try {
    const platform = options.platform ?? "Darwin";
    const child = Bun.spawn(["/bin/bash", "-c", wrapper, "test", helper], {
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
        // Linux normally uses repo/.jelly; this also covers its data-dir override.
        JELLY_DATA_DIR: platform === "Linux" ? data : undefined,
        JELLY_RESTART_PORT: options.port,
        JELLY_RESTART_TEST_PLATFORM: platform,
        JELLY_RESTART_TEST_UID: options.uid ?? "501",
        JELLY_RESTART_TEST_DATA: data,
        JELLY_RESTART_TEST_LOG: log,
        JELLY_RESTART_TEST_RELEASE: options.release ? "1" : "0",
        JELLY_RESTART_TEST_STAY_BUSY:
          options.busy && !options.release ? "1" : "0",
        JELLY_RESTART_TEST_DENIED: options.denied ? "1" : "0",
        JELLY_RESTART_TEST_LOADED: options.loaded === false ? "0" : "1",
        JELLY_RESTART_TEST_HEALTHY: options.healthy === false ? "0" : "1",
        JELLY_RESTART_TEST_ACTIVE: options.active === false ? "0" : "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      code,
      output,
      error,
      commands: existsSync(log)
        ? (await Bun.file(log).text()).trim().split("\n")
        : [],
      databaseExists: existsSync(join(data, "jelly.sqlite")),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const platform of ["Darwin", "Linux"]) {
  test(`idle helper waits for running agents before restarting ${platform} and verifies both HTTP origins`, async () => {
    const result = await idleRestartFixture({
      platform,
      busy: true,
      release: true,
    });
    expect(result.code).toBe(0);
    expect(result.error).toBe("");
    expect(result.output).toContain(
      "Verified Jelly on loopback and private Tailscale",
    );
    const restart =
      platform === "Darwin"
        ? "launchctl kickstart -k system/com.jelly.server"
        : "systemctl --user reload-or-restart jelly.service";
    expect(result.commands.indexOf("sleep 5")).toBeLessThan(
      result.commands.indexOf(restart),
    );
    expect(
      result.commands.filter((command) => command === restart),
    ).toHaveLength(1);
    if (platform === "Darwin") {
      expect(result.commands).toContain(
        "sudo -n launchctl kickstart -k system/com.jelly.server",
      );
      expect(
        result.commands.some((command) => command.startsWith("systemctl")),
      ).toBe(false);
    } else {
      expect(result.commands).toContain(
        "systemctl --user stop jelly-dev.service",
      );
      expect(
        result.commands.indexOf("systemctl --user daemon-reload"),
      ).toBeLessThan(result.commands.indexOf(restart));
      expect(
        result.commands.some((command) => command.startsWith("launchctl")),
      ).toBe(false);
    }
    const port = platform === "Darwin" ? 3100 : 5173;
    expect(
      result.commands
        .filter((command) => command.startsWith("curl "))
        .map((command) => command.split(" ").at(-1)),
    ).toEqual([
      `http://127.0.0.1:${port}/`,
      `http://127.0.0.1:${port}/api/health`,
      `http://fixture.tailtest.ts.net:${port}/`,
      `http://fixture.tailtest.ts.net:${port}/api/health`,
    ]);
  });

  test(`idle helper leaves ${platform} running when agents stay busy`, async () => {
    const result = await idleRestartFixture({ platform, busy: true });
    expect(result.code).toBe(1);
    expect(result.error).toContain(
      "remained busy for 30 minutes; no restart performed",
    );
    expect(
      result.commands.filter((command) => command === "sleep 5"),
    ).toHaveLength(360);
    expect(
      result.commands.some((command) =>
        /kickstart|reload-or-restart|^sudo |^curl /.test(command),
      ),
    ).toBe(false);
  });
}

for (const hold of ["repo", "data"] as const) {
  test(`macOS idle helper respects ${hold} restart holds even with no running agents`, async () => {
    const held = await idleRestartFixture({ hold });
    expect(held.code).toBe(1);
    expect(
      held.commands.some((command) => /kickstart|^sudo |^curl /.test(command)),
    ).toBe(false);
    const released = await idleRestartFixture({
      hold,
      release: true,
      uid: "0",
    });
    expect(released.code).toBe(0);
    expect(released.commands.indexOf("sleep 5")).toBeLessThan(
      released.commands.indexOf(
        "launchctl kickstart -k system/com.jelly.server",
      ),
    );
    expect(
      released.commands.some((command) => command.startsWith("sudo ")),
    ).toBe(false);
  });
}

test("macOS idle helper fails safely for absent state, invalid settings and denied restart privileges", async () => {
  for (const options of [
    { missingDatabase: true },
    { loaded: false },
    { port: "65536" },
    { platform: "FreeBSD" },
  ]) {
    const result = await idleRestartFixture(options);
    expect(result.code).toBe(1);
    expect(
      result.commands.some((command) =>
        /kickstart|^sudo |^curl /.test(command),
      ),
    ).toBe(false);
    if ("missingDatabase" in options) expect(result.databaseExists).toBe(false);
  }
  const denied = await idleRestartFixture({ denied: true });
  expect(denied.code).toBe(1);
  expect(denied.error).toContain("noninteractive sudo");
  expect(denied.commands).toContain(
    "sudo -n launchctl kickstart -k system/com.jelly.server",
  );
  expect(
    denied.commands.some((command) =>
      /^(launchctl kickstart|curl) /.test(command),
    ),
  ).toBe(false);
});

test("macOS idle helper never claims readiness for a failed HTTP probe or a stopped launchd service", async () => {
  for (const options of [{ healthy: false }, { active: false }]) {
    const result = await idleRestartFixture(options);
    expect(result.code).toBe(1);
    expect(result.error).toContain("readiness verification failed");
    expect(result.output).not.toContain("Verified");
    expect(
      result.commands.filter(
        (command) =>
          command === "launchctl kickstart -k system/com.jelly.server",
      ),
    ).toHaveLength(1);
    expect(
      result.commands.filter((command) => command === "sleep 2"),
    ).toHaveLength(30);
  }
  const override = await idleRestartFixture({ port: "5432" });
  expect(override.code).toBe(0);
  expect(
    override.commands.some((command) =>
      command.endsWith("http://127.0.0.1:5432/api/health"),
    ),
  ).toBe(true);
});
