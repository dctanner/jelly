// Disposable stable-Chrome qualification only. Never uses an owner's bus/profile/display.
import { chromium } from "playwright-core";
import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, chmodSync, lstatSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { OWNED_BUS_PROXY, ownedBusProxyArgs, ownedBusProxyAlive, ownedProcess } from "../src/server/owned-chrome-desktop";
const fixture = process.env.FIXTURE_ROOT!;
if (!fixture?.startsWith("/tmp/jelly-os-auth-") || process.env.DBUS_SESSION_BUS_ADDRESS?.split(",")[0] !== `unix:path=${fixture}/runtime/bus`)
    throw new Error("Private fixture required");
const dir = mkdtempSync(join(fixture, "picker-"));
const children: ReturnType<typeof spawn>[] = [];
let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
async function until(fn: () => Promise<boolean> | boolean) { const end = Date.now() + 15000; while (!await fn()) {
    if (Date.now() > end)
        throw new Error(`Timeout: ${fn}`);
    await Bun.sleep(50);
} }
async function cmd(args: string[], env: Record<string, string | undefined>) { const p = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" }); const out = await new Response(p.stdout).text(); if (await p.exited)
    throw new Error(await new Response(p.stderr).text()); return out.trim(); }
async function display() {
    const p = spawn(resolve(".jelly/runtime/usr/bin/Xvfb"), ["-displayfd", "3", "-screen", "0", "1280x900x24", "-nolisten", "tcp", "-ac"], { env: { PATH: "/usr/bin:/bin", LD_LIBRARY_PATH: resolve(".jelly/runtime/usr/lib/x86_64-linux-gnu") }, stdio: ["ignore", "ignore", "ignore", "pipe"] });
    children.push(p);
    return await new Promise<string>((ok, no) => { const timer = setTimeout(() => no(new Error("Xvfb timeout")), 5000); p.stdio[3]!.once("data", b => { clearTimeout(timer); ok(":" + b.toString().trim()); }); });
}
const site = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response("Synthetic cookie fixture", { headers: { "Set-Cookie": "picker_fixture=retained; Path=/; Max-Age=3600; SameSite=Lax" } }) });
try {
    const owned = await display(), other = await display();
    const env = { PATH: "/usr/bin:/bin", HOME: join(dir, "home"), LANG: "C.UTF-8", DISPLAY: owned, XDG_SESSION_TYPE: "x11", DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${fixture}/absent-system` };
    mkdirSync(env.HOME, { mode: 0o700 });
    const wm = spawn("/usr/bin/openbox", ["--sm-disable"], { env, stdio: "ignore" });
    children.push(wm);
    const proxyDir = mkdtempSync(join(dir, "bus-")), path = join(proxyDir, "socket");
    const proxy = spawn(OWNED_BUS_PROXY, ownedBusProxyArgs(process.env.DBUS_SESSION_BUS_ADDRESS!, path), { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore" });
    children.push(proxy);
    await until(() => { try {
        return lstatSync(path).isSocket();
    }
    catch {
        return false;
    } });
    chmodSync(path, 0o600);
    const s = lstatSync(path, { bigint: true }), record = { process: ownedProcess(proxy.pid!), path, socket: [String(s.dev), String(s.ino), String(s.ctimeNs)] };
    expect(ownedBusProxyAlive(record, dir)).toBe(true);
    const browserEnv = { ...env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${path}` };
    const busCall = (bus: string, method: string, ...args: string[]) => cmd(["/usr/bin/gdbus", "call", "--address", bus, "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", `org.freedesktop.DBus.${method}`, ...args], env);
    expect(await busCall(process.env.DBUS_SESSION_BUS_ADDRESS!, "NameHasOwner", "org.freedesktop.portal.Desktop")).toContain("true");
    expect(await busCall(browserEnv.DBUS_SESSION_BUS_ADDRESS, "NameHasOwner", "org.freedesktop.portal.Desktop")).toContain("false");
    expect(await busCall(browserEnv.DBUS_SESSION_BUS_ADDRESS, "NameHasOwner", "org.freedesktop.secrets")).toContain("true");
    const owner = (await busCall(browserEnv.DBUS_SESSION_BUS_ADDRESS, "GetNameOwner", "org.freedesktop.secrets")).match(/'(:[0-9.]+)'/)![1]!;
    expect(await cmd(["/usr/bin/gdbus", "call", "--address", browserEnv.DBUS_SESSION_BUS_ADDRESS, "--dest", owner, "--object-path", "/org/freedesktop/secrets/collection/login", "--method", "org.freedesktop.DBus.Properties.Get", "org.freedesktop.Secret.Collection", "Locked"], env)).toContain("false");
    await expect(busCall(browserEnv.DBUS_SESSION_BUS_ADDRESS, "StartServiceByName", "org.freedesktop.portal.Desktop", "0")).rejects.toThrow();
    // This deliberately activation-free fixture has no .service files. The real
    // bus's ServiceUnknown reply proves forwarding (not proxy AccessDenied).
    await expect(busCall(browserEnv.DBUS_SESSION_BUS_ADDRESS, "StartServiceByName", "org.freedesktop.secrets", "0")).rejects.toThrow("was not provided by any .service files");
    let signals = "";
    const monitor = spawn("/usr/bin/gdbus", ["monitor", "--address", browserEnv.DBUS_SESSION_BUS_ADDRESS, "--dest", "org.freedesktop.secrets"], { env, stdio: ["ignore", "pipe", "ignore"] });
    children.push(monitor);
    monitor.stdout!.on("data", b => { signals += b.toString(); });
    await until(() => signals.includes("is owned by"));
    await cmd(["/usr/bin/gdbus", "call", "--address", browserEnv.DBUS_SESSION_BUS_ADDRESS, "--dest", "org.freedesktop.secrets", "--object-path", "/org/freedesktop/secrets/collection/login", "--method", "org.freedesktop.DBus.Properties.Set", "org.freedesktop.Secret.Collection", "Label", "<'Synthetic fixture login'>"], env);
    await until(() => signals.includes("PropertiesChanged"));
    monitor.kill("SIGTERM");
    // Playwright's basic-store/default automation switches are explicitly removed.
    const launch = () => chromium.launchPersistentContext(join(dir, "profile"), { executablePath: "/usr/bin/google-chrome", headless: false, env: browserEnv, ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain", "--disable-extensions", "--enable-automation"], args: ["--ozone-platform=x11", "--no-first-run"], chromiumSandbox: true });
    browser = await launch();
    console.log("Stable Chrome fixture", await cmd(["/usr/bin/google-chrome", "--version"], env));
    const page = browser.pages()[0]!;
    await (await browser.newCDPSession(page)).send("Page.setInterceptFileChooserDialog", { enabled: false });
    await page.goto(site.url.href);
    await page.goto("chrome://extensions");
    await page.locator("extensions-manager extensions-toolbar #devMode").click();
    async function windows(display: string) { try {
        return await cmd(["/usr/bin/xdotool", "search", "--onlyvisible", "--name", "Select the extension directory"], { ...env, DISPLAY: display });
    }
    catch {
        return "";
    } }
    await page.getByRole("button", { name: "Load unpacked", exact: true }).click();
    await until(async () => !!await windows(owned));
    expect(await windows(other)).toBe("");
    await cmd(["/usr/bin/xdotool", "key", "Escape"], env);
    await until(async () => !await windows(owned));
    const extension = join(dir, "synthetic-extension");
    mkdirSync(extension);
    writeFileSync(join(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Synthetic picker extension", version: "1.0" }));
    await page.getByRole("button", { name: "Load unpacked", exact: true }).click();
    await until(async () => !!await windows(owned));
    await cmd(["/usr/bin/xdotool", "windowactivate", "--sync", (await windows(owned)).split("\n")[0]!], env);
    await Bun.sleep(300);
    await cmd(["/usr/bin/xdotool", "key", "ctrl+l"], env);
    await Bun.sleep(200);
    await cmd(["/usr/bin/xdotool", "type", "--clearmodifiers", extension], env);
    // Native GTK Open button in the fixed 1280x900 disposable display. Enter
    // in the location entry alone did not accept the folder on this GTK build.
    await cmd(["/usr/bin/xdotool", "mousemove", "1155", "832", "click", "1"], env);
    await Bun.sleep(500);
    if (await windows(owned))
        await cmd(["/usr/bin/xdotool", "key", "alt+o"], env);
    await until(async () => !await windows(owned));
    await page.getByText("Synthetic picker extension", { exact: true }).waitFor();
    await browser.close();
    // Check only the synthetic row's encryption tag, never print key material.
    await cmd(["/usr/bin/python3", "-c", "import pathlib,sqlite3,sys; p=pathlib.Path(sys.argv[1]); db=next(x for x in (p/'Network/Cookies',p/'Cookies') if x.exists()); c=sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True); row=c.execute(\"select value,substr(encrypted_value,1,3) from cookies where name='picker_fixture' and host_key='127.0.0.2'\").fetchone(); assert row == ('',b'v11'), 'Expected Secret Service encrypted synthetic cookie'", join(dir, "profile/Default")], env);
    browser = await launch();
    expect((await browser.cookies(site.url.href)).some(c => c.name === "picker_fixture" && c.value === "retained")).toBe(true);
    await browser.close();
    browser = undefined;
    expect(ownedBusProxyAlive({ ...record, process: { ...record.process, start: "0" } }, dir)).toBe(false);
    chmodSync(path, 0o666);
    expect(ownedBusProxyAlive(record, dir)).toBe(false);
    chmodSync(path, 0o600);
    expect(ownedBusProxyAlive(record, dir)).toBe(false); // ctime changed
    const changed = lstatSync(path, { bigint: true });
    record.socket = [String(changed.dev), String(changed.ino), String(changed.ctimeNs)];
    expect(ownedBusProxyAlive(record, dir)).toBe(true);
    renameSync(path, path + ".original");
    writeFileSync(path, "synthetic replacement", { mode: 0o600 });
    expect(ownedBusProxyAlive(record, dir)).toBe(false);
    rmSync(path);
    renameSync(path + ".original", path);
    proxy.kill("SIGTERM");
    await until(() => !ownedBusProxyAlive(record, dir));
    console.log("PASS stable Chrome: genuine native Load unpacked picker visible only on owned X11; cancel, synthetic selection, persisted cookie across browser restart, proxy death refused");
}
finally {
    await browser?.close();
    site.stop(true);
    for (const child of children.reverse()) {
        child.kill("SIGTERM");
        await new Promise<void>(done => { if (child.exitCode !== null || child.signalCode)
            done();
        else
            child.once("exit", () => done()); });
    }
    rmSync(dir, { recursive: true, force: true });
}
