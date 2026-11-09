/**
 * Test-only ChromePort that speaks the extension's v9 relay protocol directly over
 * raw CDP (flattened sessions), so the engine can be exercised without the extension.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { ChromePort, ChromePortEvent, TabInfo } from "../../src/server/browser/types";

export class DirectChromePort implements ChromePort {
  private ws!: WebSocket;
  private proc!: ChildProcess;
  private dir = mkdtempSync(join(tmpdir(), "jelly-engine-"));
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(e: ChromePortEvent) => void>();
  private tabTargets = new Map<number, string>(); // tabId → targetId
  private rootSessions = new Map<number, string>(); // tabId → root sessionId
  private sessionTab = new Map<string, { tabId: number; root: boolean }>();
  private nextTab = 1;
  calls: string[] = [];

  async start(headless = true) {
    const exe = process.env.JELLY_EXTENSION_BROWSER_PATH ?? chromium.executablePath();
    this.proc = spawn(exe, [
      `--user-data-dir=${join(this.dir, "profile")}`, "--remote-debugging-port=0", "--no-first-run",
      "--no-default-browser-check", "--site-per-process", ...(headless ? ["--headless=new"] : []), "about:blank",
    ], { stdio: "ignore" });
    const file = join(this.dir, "profile", "DevToolsActivePort");
    for (let i = 0; i < 200 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
    const [port, path] = readFileSync(file, "utf8").trim().split("\n");
    this.ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise<void>((resolve, reject) => { this.ws.onopen = () => resolve(); this.ws.onerror = () => reject(new Error("ws")); });
    this.ws.onmessage = (m) => this.receive(JSON.parse(String(m.data)));
    await this.send("Target.setDiscoverTargets", { discover: true });
  }

  async stop() {
    try { this.ws.close(); } catch {}
    this.proc.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    rmSync(this.dir, { recursive: true, force: true });
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private receive(msg: any) {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      return;
    }
    if (!msg.sessionId) {
      if (msg.method === "Target.targetDestroyed") {
        for (const [tabId, targetId] of this.tabTargets)
          if (targetId === msg.params.targetId) { this.tabTargets.delete(tabId); this.emit({ type: "tabRemoved", tabId }); }
      }
      if (msg.method === "Target.targetCreated" && msg.params.targetInfo.type === "page" && msg.params.targetInfo.openerId) {
        const opener = [...this.tabTargets].find(([, t]) => t === msg.params.targetInfo.openerId);
        if (opener) {
          const tabId = this.nextTab++;
          this.tabTargets.set(tabId, msg.params.targetInfo.targetId);
          this.emit({ type: "tabAdded", tab: { id: tabId, title: "", url: msg.params.targetInfo.url, origin: "agent" } });
        }
      }
      return;
    }
    const owner = this.sessionTab.get(msg.sessionId);
    if (!owner) return;
    if (msg.method === "Target.attachedToTarget")
      this.sessionTab.set(msg.params.sessionId, { tabId: owner.tabId, root: false });
    this.emit({ type: "cdpEvent", tabId: owner.tabId, ...(owner.root ? {} : { sessionId: msg.sessionId }), method: msg.method, params: msg.params });
  }

  private emit(e: ChromePortEvent) { for (const l of this.listeners) l(e); }
  onEvent(listener: (e: ChromePortEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  private async info(tabId: number): Promise<TabInfo> {
    const { targetInfo } = await this.send("Target.getTargetInfo", { targetId: this.tabTargets.get(tabId) });
    return { id: tabId, title: targetInfo.title, url: targetInfo.url, origin: "agent", mark: null };
  }

  async call(method: string, p: Record<string, any> = {}): Promise<any> {
    this.calls.push(method);
    switch (method) {
      case "createTab": {
        const { targetId } = await this.send("Target.createTarget", { url: "about:blank", background: true });
        const tabId = this.nextTab++;
        this.tabTargets.set(tabId, targetId);
        return { tab: await this.info(tabId) };
      }
      case "listTabs":
        return { tabs: await Promise.all([...this.tabTargets.keys()].map((id) => this.info(id))) };
      case "closeTab":
        await this.send("Target.closeTarget", { targetId: this.tabTargets.get(p.tabId) });
        return { ok: true };
      case "attach": {
        if (this.rootSessions.has(p.tabId)) return { ok: true };
        const { sessionId } = await this.send("Target.attachToTarget", { targetId: this.tabTargets.get(p.tabId), flatten: true });
        this.rootSessions.set(p.tabId, sessionId);
        this.sessionTab.set(sessionId, { tabId: p.tabId, root: true });
        return { ok: true };
      }
      case "cdp": {
        if (!this.rootSessions.has(p.tabId)) await this.call("attach", { tabId: p.tabId });
        const session = p.sessionId ?? this.rootSessions.get(p.tabId);
        const run = this.send(p.method, p.params ?? {}, session);
        const timeout = p.timeoutMs ?? 10000;
        return Promise.race([run, new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out running CDP command "${p.method}"`)), timeout))]);
      }
      case "cdpBatch": {
        const results = [];
        for (const [i, c] of (p.commands as any[]).entries()) {
          try { results.push(await this.call("cdp", { tabId: p.tabId, sessionId: p.sessionId, method: c.method, params: c.params })); }
          catch (e) { throw new Error(`Command ${i} "${c.method}" failed: ${(e as Error).message}`); }
        }
        return { results };
      }
      case "name": case "markTab": case "showTab": case "detach":
        return { ok: true };
      default:
        throw new Error(`DirectChromePort: unsupported ${method}`);
    }
  }
}
