import type { ClaudeStatusCheck } from "./claude-code";
import "./runtime-network";
import { COMPUTER_CLIPBOARD_BODY_BYTES } from "../shared/computer-clipboard";
import { tailnetAddresses } from "../shared/network";
import { DEFAULT_AGENT_NAME } from "../shared/agent-names";
import { AVATARS } from "../shared/avatars";
import { createDirectory, directories, effectiveCwd } from "./directories";
import { uploadFile } from "./uploads";
import { readToolImage } from "./tool-images";
import { isHtmlFile } from "../shared/rendered-files";
import { mediaResponse } from "./media-files";
import { acquireInstance } from "./instance-lock";
import {
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
  type ModelId,
  type Effort,
} from "../shared/models";
import { Connections, type ChatGPTLogin } from "./connections";
import { connect, type Socket } from "node:net";
import { ControlSessions } from "./control-session";
import type { SudoExecutor } from "./sudo";
import { join, resolve, sep } from "node:path";
import type { Activity, Mode } from "../shared/types";
import { Store } from "./store";
import { Harness } from "./harness";
import { HttpError, JellyService } from "./service";
import { APP_ICON_MAX_BYTES } from "./apps-icons";
import type { DesktopSessions } from "./desktop-sessions";
export interface AppOptions {
  dataDir: string;
  sudoExecutor?: SudoExecutor;
  interventionTtlMs?: number;
  authPath?: string;
  configDir?: string;
  chatgptLogin?: ChatGPTLogin;
  claudeStatusCheck?: ClaudeStatusCheck;
  loginTtlMs?: number;
  port?: number;
  allowedOrigins?: string[];
  listenAddresses?: string[];
  staticDir?: string;
  desktopOptions?: Omit<ConstructorParameters<typeof DesktopSessions>[1], "isRunActive" | "notify" | "canAdmit">;
}
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
async function body(req: Request, maxBytes = 64000, fatalUtf8 = false) {
  if (!req.headers.get("content-type")?.includes("application/json"))
    throw new HttpError(415, "Send JSON with Content-Type: application/json.");
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new HttpError(413, "Request is too large.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  try {
    const bytes = Buffer.concat(chunks);
    const raw = fatalUtf8 ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : bytes.toString("utf8");
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Invalid JSON object.");
  }
}
async function iconBody(req: Request) {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) throw new HttpError(415, "Upload PNG, JPEG, or WebP with its matching image Content-Type.");
  if (Number(req.headers.get("content-length")) > APP_ICON_MAX_BYTES) throw new HttpError(413, "App icons must be at most 1 MiB.");
  const reader = req.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > APP_ICON_MAX_BYTES) { await reader.cancel(); throw new HttpError(413, "App icons must be at most 1 MiB."); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
  }
  return { bytes: Buffer.concat(chunks), contentType };
}
function text(value: unknown, name: string, max: number, empty = false) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.trim())
  )
    throw new HttpError(
      400,
      `${name} must be ${empty ? "at most" : "between 1 and"} ${max} characters.`,
    );
  return value.trim();
}
function profile(input: Record<string, unknown>, creating = false) {
  if (input.nameEdited !== undefined && typeof input.nameEdited !== "boolean")
    throw new HttpError(400, "Invalid name edit flag.");
  const color = input.color ?? "#b5bafc";
  if (typeof color !== "string" || !/^#[a-fA-F0-9]{6}$/.test(color))
    throw new HttpError(400, "Choose a valid avatar color.");
  if (
    input.avatarId !== undefined &&
    !AVATARS.includes(input.avatarId as never)
  )
    throw new HttpError(400, "Choose a valid sea avatar.");
  return {
    avatarId: input.avatarId as string | undefined,
    name: text(creating && input.name === undefined ? DEFAULT_AGENT_NAME : input.name, "Name", 60),
    nameEdited: input.nameEdited as boolean | undefined,
    instructions: text(input.instructions ?? "", "Instructions", 12000, true),
    color,
  };
}
export async function startApp(options: AppOptions) {
  const dataDir = resolve(options.dataDir);
  const releaseInstance = acquireInstance(dataDir);
  let cleanup = async () => {};
  try {
    const store = new Store(
      join(dataDir, "jelly.sqlite"),
      join(dataDir, "workspaces"),
    );
    cleanup = async () => store.close();
    const harness = await Harness.create(dataDir, options.authPath, options.configDir, options.claudeStatusCheck);
    // One bounded check on startup makes restored Claude agents ready without
    // visiting Settings. Snapshots remain synchronous and never spawn probes.
    await harness.claude.refresh();
    await harness.runtime.refresh({ providers: ["claude-code"], allowNetwork: false });
    const service = new JellyService(store, harness, options);
    cleanup = () => service.close();
    const controls = new ControlSessions(options.allowedOrigins);
    service.chromeShare.ownerValid = id => controls.valid(id);
    const connections = new Connections(
      service.harness.auth,
      (mode) => service.setMode(mode),
      options.chatgptLogin,
      options.loginTtlMs,
    );
    const streams = new Set<() => void>();
    const staticDir = resolve(
      options.staticDir ?? join(import.meta.dir, "../../dist"),
    );
    interface VncData {
      endpoint: import("./vnc-endpoint").VncEndpoint;
      path: string;
      generation: number;
      session: string;
      socket?: Socket;
      detach?: () => void;
    }
    const addresses = tailnetAddresses(options.listenAddresses ?? []);
    const listenerOrigins = [...(options.allowedOrigins ?? [])];
    const listeners: Bun.Server<VncData>[] = [];
    const listenerOptions = {
      websocket: {
        open(ws) {
          if (
            !ws.data.endpoint.validConnection(
              ws.data.generation,
              ws.data.session,
            )
          ) {
            ws.close(1008);
            return;
          }
          const socket = connect(ws.data.path);
          ws.data.socket = socket;
          const close = () => {
            socket.destroy();
            ws.close();
            ws.data.detach?.();
          };
          ws.data.detach = ws.data.endpoint.attach(close);
          socket.on("data", (chunk) => {
            if (!ws.data.endpoint.validConnection(ws.data.generation, ws.data.session)) { close(); return; }
            if (ws.send(chunk, true) === -1) socket.pause();
          });
          socket.on("error", close);
          socket.on("close", close);
        },
        message(ws, message) {
          if (!ws.data.endpoint.validConnection(ws.data.generation, ws.data.session)) {
            ws.data.socket?.destroy(); ws.close(1008); return;
          }
          if (typeof message === "string" || message.byteLength > 1024 * 1024) {
            ws.close(1008);
            return;
          }
          const socket = ws.data.socket;
          if (socket && !socket.destroyed) {
            if (socket.writableLength > 1024 * 1024) {
              socket.destroy();
              ws.close(1008);
              return;
            }
            socket.write(message);
          }
        },
        drain(ws) {
          ws.data.socket?.resume();
        },
        close(ws) {
          ws.data.detach?.();
          ws.data.socket?.destroy();
        },
        maxPayloadLength: 1024 * 1024,
        backpressureLimit: 4 * 1024 * 1024,
        closeOnBackpressureLimit: true,
        idleTimeout: 120,
      },
      hostname: "127.0.0.1",
      port: options.port ?? 3100,
      idleTimeout: 0,
      // Uploads stream to disk; JSON requests retain their own 64 KB limit.
      maxRequestBodySize: Number.MAX_SAFE_INTEGER,
      async fetch(req: Request, server: Bun.Server<VncData>) {
        const url = new URL(req.url);
        try {
          const allowedHosts = new Set([
            `127.0.0.1:${server.port}`,
            `localhost:${server.port}`,
            ...listenerOrigins.map(
              (origin) => new URL(origin).host,
            ),
          ]);
          if (!allowedHosts.has(req.headers.get("host") ?? ""))
            throw new HttpError(403, "Unrecognized host.");
          if (url.pathname.startsWith("/api/")) {
            const origin = req.headers.get("origin");
            const allowed = new Set([
              `http://127.0.0.1:${server.port}`,
              `http://localhost:${server.port}`,
              ...listenerOrigins,
            ]);
            if (origin && !allowed.has(origin))
              throw new HttpError(403, "This origin is not allowed.");
            if (["cross-site", "same-site"].includes(req.headers.get("sec-fetch-site") ?? "") && (!origin || !allowed.has(origin)))
              throw new HttpError(403, "Cross-origin requests are not allowed, including same-host app ports.");
            const controlCookies = (req.headers.get("cookie") ?? "").split(";").map(pair => pair.trim().split("=", 1)[0]);
            if (controlCookies.filter(cookie => [controls.cookieName, "jelly_control", "__Host-jelly_control"].includes(cookie ?? "")).length > 1)
              throw new HttpError(400, "Ambiguous control cookies. Clear conflicting path/domain cookies and reopen Jelly.");
            if (req.method === "OPTIONS") throw new HttpError(405, "Cross-origin preflight is not supported.");
            const bootstrap = req.method === "GET" && url.pathname === "/api/control-session";
            if (bootstrap) {
              const mode = req.headers.get("sec-fetch-mode");
              const destination = req.headers.get("sec-fetch-dest");
              if ((mode && !["cors", "same-origin"].includes(mode)) || (destination && destination !== "empty"))
                throw new HttpError(403, "Establish control through Jelly's same-origin API, not navigation, frames or resources.");
            } else if (url.pathname !== "/api/health" || req.method !== "GET") {
              // One policy for every private read, mutation and future route;
              // route-local checks remain useful for connection/ticket binding.
              controls.require(req, !["GET", "HEAD"].includes(req.method));
            }
            if (
              req.method === "GET" &&
              url.pathname === "/api/control-session"
            ) {
              const { session, cookie, retiredCookies } = controls.create(req);
              const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
              headers.append("Set-Cookie", cookie);
              for (const retired of retiredCookies) headers.append("Set-Cookie", retired);
              return Response.json(
                { csrf: session.csrf },
                {
                  headers,
                },
              );
            }
            if (req.method === "GET" && url.pathname === "/api/chrome/share/socket") {
              if (!origin || !allowed.has(origin)) throw new HttpError(403, "A same-origin browser is required.");
              const session = controls.require(req, false);
              const connection = service.chromeShare.consume(url.searchParams.get("ticket") ?? "", session.id);
              if (server.upgrade(req, { data: { ...connection, endpoint: service.chromeShare } })) return;
              throw new HttpError(400, "WebSocket upgrade required.");
            }
            if (req.method === "GET" && url.pathname === "/api/chrome/share")
              return json(service.chromeShare.state(controls.require(req, false).id));
            if (req.method === "POST" && url.pathname.startsWith("/api/chrome/share/")) {
              const session = controls.require(req);
              const operation = url.pathname.slice("/api/chrome/share/".length);
              const input = await body(req, operation === "clipboard/send" ? COMPUTER_CLIPBOARD_BODY_BYTES : 64000,
                operation === "clipboard/send" || operation === "clipboard/receive");
              if (operation === "clipboard/send" || operation === "clipboard/receive")
                return json(await service.chromeShare.transferClipboard(session.id, input, operation === "clipboard/send"));
              if (operation === "take-owned") {
                if (Object.keys(input).some(k => k !== "agentId")) throw new HttpError(400, "Only the installed owned desktop may be selected.");
                const agentId = input.agentId == null ? null : text(input.agentId, "Agent ID", 100);
                if (agentId && !store.agent(agentId)) throw new HttpError(404, "Agent not found.");
                if (agentId && service.chrome.state(agentId).task) throw new HttpError(409, "Use this agent’s pinned computer; close its browser session before changing computers.");
                return json(await service.chromeShare.takeOwned(session.id, agentId));
              }
              if (operation === "take") {
                const agentId = input.agentId == null ? null : text(input.agentId, "Agent ID", 100);
                if (agentId && !store.agent(agentId)) throw new HttpError(404, "Agent not found.");
                const task = service.chrome.state(agentId ?? undefined).task;
                const profile = task?.profile ?? store.browserSelection().chromeProfile;
                const live = service.chrome.bridge.profiles().find(p => p.id === profile);
                if (!live || input.profile !== profile || input.profileGeneration !== live.generation)
                  throw new HttpError(409, "Selected Chrome profile changed. Refresh before consenting.");
                return json(await service.chromeShare.take(session.id, agentId, live.id, live.generation));
              }
              if (operation === "ticket") return json(service.chromeShare.ticket(session.id, input.generation));
              if (operation === "reconnect") return json(await service.chromeShare.reconnect(session.id, input.generation, input.controlId));
              if (operation === "release") {
                const next = await service.chromeShare.release(session.id, input.generation, input.cleanupOnly === true, input.controlId);
                await service.finishDesktopPrivacy();
                return json(next);
              }
              throw new HttpError(404, "Chrome share route not found.");
            }
            if (url.pathname === "/api/apps" || url.pathname.startsWith("/api/apps/")) {
              controls.require(req, req.method !== "GET");
              if (req.method === "GET" && url.pathname === "/api/apps") {
                await service.apps.capabilities();
                return json(service.apps.list({
                  q: url.searchParams.get("q") ?? undefined,
                  after: url.searchParams.get("after") ?? undefined,
                  limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
                }));
              }
              if (req.method === "GET" && url.pathname === "/api/apps/capabilities") return json(await service.apps.capabilities());
              if (req.method === "POST" && url.pathname === "/api/apps/register") return json(service.apps.register(await body(req)));
              const route = url.pathname.match(/^\/api\/apps\/([^/]+)(?:\/(star|launch|remove|icon))?$/);
              if (route) {
                const [, id, action] = route;
                if (req.method === "GET" && !action) return json(service.apps.get(id!));
                if (req.method === "GET" && action === "icon") {
                  const icon = service.apps.icon(id!);
                  return new Response(new Uint8Array(icon.bytes), { headers: { "Content-Type": icon.contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" } });
                }
                if (req.method === "POST" && action === "icon") return json(await service.apps.setIcon(id!, await iconBody(req)));
                if (req.method === "POST") {
                  const input = await body(req);
                  if (action === "star") {
                    if (typeof input.starred !== "boolean") throw new HttpError(400, "starred must be a boolean.");
                    return json(service.apps.setStarred(id!, input.starred));
                  }
                  if (action === "launch") return json(service.apps.recordLaunch(id!, text(input.navigationId, "Navigation ID", 128)));
                  if (action === "remove") {
                    if (Object.keys(input).length) throw new HttpError(400, "Removal only unregisters metadata; no options are supported.");
                    return json(service.apps.remove(id!));
                  }
                }
              }
              throw new HttpError(404, "Apps API route not found.");
            }
            if (url.pathname === "/api/desktop" && req.method === "GET")
              return json(service.desktopStatus());
            if (url.pathname.startsWith("/api/desktop/") && req.method === "POST") {
              const operation = url.pathname.slice("/api/desktop/".length);
              const input = await body(req);
              if (!["pause", "stop"].includes(operation) && service.chromeShare.state().status !== "idle")
                throw new HttpError(409, "Finish computer viewer cleanup before using native desktop controls.");
              if (operation === "settings") return json(await service.desktop.configure(input));
              if (operation === "connect") { await service.desktop.connect(); return json(service.desktopStatus()); }
              if (operation === "pause") { await service.pauseDesktopForPrivacy(); return json(service.desktopStatus()); }
              if (operation === "stop") { await service.desktop.stop(); return json(service.desktopStatus()); }
              if (operation === "handback") return json(await service.finishDesktopPrivacy());
              if (operation === "resume" || operation === "foreground") {
                const agentId = text(input.agentId, "Agent ID", 100);
                const runId = text(input.runId, "Run ID", 100);
                if (!store.agent(agentId)) throw new HttpError(404, "Agent not found.");
                if (operation === "resume")
                  return json(await service.resumeDesktop(agentId, runId, typeof input.handoffId === "string" ? input.handoffId : undefined));
                if (typeof input.durationMs !== "number" || !Number.isInteger(input.durationMs) ||
                    input.durationMs < 1000 || input.durationMs > 60000)
                  throw new HttpError(400, "Foreground grants last 1–60 seconds.");
                if (service.desktopStatus().handoff || service.desktopStatus().browserPrivate)
                  throw new HttpError(409, "Private control blocks foreground grants.");
                await service.desktop.grantForeground(agentId, runId, input.durationMs);
                return json(service.desktopStatus());
              }
              throw new HttpError(404, "Desktop control route not found.");
            }
            if (url.pathname === "/api/chrome" && req.method === "GET") {
              controls.require(req, false);
              return json(service.chromeStatus(url.searchParams.get("agentId") ?? undefined));
            }
            if (url.pathname.startsWith("/api/chrome/") && req.method === "POST") {
              controls.require(req);
              const operation = url.pathname.slice("/api/chrome/".length);
              const input = await body(req);
              if (operation === "settings") return json(service.setConfig({ chromeProfile: input.chromeProfile as string }));
              const agentId = text(input.agentId, "Agent ID", 100);
              if (!store.agent(agentId)) throw new HttpError(404, "Agent not found.");
              if (operation === "close" && ["running", "waiting"].includes(store.agent(agentId)!.status)) throw new HttpError(409, "Stop or finish the run before resetting its pinned Chrome session.");
              if (operation === "done") {
                if (input.handoff !== null && typeof input.handoff !== "string") throw new HttpError(400, "A matching browser request is required.");
                await service.completeBrowserControl(agentId, input.handoff as string | null);
              } else {
                if (!["close", "disconnect"].includes(operation)) throw new HttpError(400, "Unsupported Chrome control.");
                await service.chrome.control(agentId, operation);
                if (operation === "close") service.browsers.releasePin(agentId);
              }
              return json(service.chromeStatus(agentId));
            }
            const intervention = url.pathname.match(
              /^\/api\/interventions\/([^/]+)\/(approve|deny)$/,
            );
            if (req.method === "POST" && intervention) {
              controls.require(req);
              const [, id, action] = intervention;
              if (action === "deny") {
                const request = service.interventions.deny(id!);
                if (request.kind === "browser_login") {
                  if (service.chrome.state(request.agentId).task?.handoff === request.id)
                    service.chrome.done(request.agentId, request.id);
                  await service.finishBrowserPrivacy(request.agentId);
                }
                return json({ ok: true });
              }
              const input = await body(req);
              if (typeof input.password !== "string")
                throw new HttpError(
                  400,
                  "Enter a password or leave the field empty for passwordless sudo.",
                );
              const password = Buffer.from(input.password);
              delete input.password;
              return json(
                await service.interventions.approveSudo(id!, password),
              );
            }
            if (req.method === "POST" && url.pathname === "/api/mcps/status") {
              controls.require(req);
              return json(await service.harness.mcps.status());
            }
            if (
              req.method === "POST" &&
              url.pathname.startsWith("/api/auth/")
            ) {
              const session = controls.require(req);
              if (url.pathname === "/api/auth/status")
                return json({ ...connections.status(session.id), ...await service.harness.claude.refresh() });
              if (url.pathname === "/api/auth/claude-code/refresh")
                return json(await service.harness.claude.refresh(true));
              if (url.pathname === "/api/auth/api-key") {
                const input = await body(req);
                try {
                  return json(await connections.saveKey(input.key));
                } finally {
                  delete input.key;
                }
              }
              if (url.pathname === "/api/auth/chatgpt/start")
                return json(connections.start(session.id));
              if (url.pathname === "/api/auth/chatgpt/cancel") {
                const input = await body(req);
                return json(connections.cancel(session.id, input.id));
              }
              if (url.pathname === "/api/auth/remove") {
                const input = await body(req);
                if (
                  input.provider !== "openai" &&
                  input.provider !== "openai-codex"
                )
                  throw new HttpError(400, "Unknown provider.");
                return json(await connections.remove(input.provider));
              }
            }
            if (req.method === "GET" && url.pathname === "/api/health")
              return json({ ok: true });
            if (req.method === "GET" && url.pathname === "/api/state") {
              if (
                url.searchParams.has("selection") &&
                (url.searchParams.get("selection") !== "none" ||
                  url.searchParams.has("agentId"))
              )
                throw new HttpError(400, "Invalid selection.");
              return json(
                service.snapshot(
                  url.searchParams.get("selection") === "none"
                    ? null
                    : (url.searchParams.get("agentId") ?? undefined),
                ),
              );
            }
            const subagentView = url.pathname.match(/^\/api\/agents\/([^/]+)\/runs\/([^/]+)\/subagents(?:\/([^/]+)\/transcript)?$/);
            if (req.method === "GET" && subagentView) {
              controls.require(req, false);
              const [, agentId, runId, childId] = subagentView;
              if (!childId) return json(service.subagents.snapshot(agentId!, runId!));
              const rawBefore = url.searchParams.get("before");
              if (rawBefore !== null && (!/^\d+$/.test(rawBefore) || !Number.isSafeInteger(Number(rawBefore))))
                throw new HttpError(400, "Invalid transcript cursor.");
              return json(await service.subagents.transcript(agentId!, runId!, childId, rawBefore === null ? undefined : Number(rawBefore)));
            }
            if (req.method === "GET" && url.pathname === "/api/events") {
              const cursor =
                req.headers.get("last-event-id") ??
                url.searchParams.get("after") ??
                "0";
              if (
                !/^\d+$/.test(cursor) ||
                !Number.isSafeInteger(Number(cursor))
              )
                throw new HttpError(400, "Invalid event cursor.");
              const after = Number(cursor);

              const encoder = new TextEncoder();
              let cleanup = () => {};
              const stream = new ReadableStream<Uint8Array>(
                {
                  start(controller) {
                    let closed = false;
                    let last = after;
                    let timer: ReturnType<typeof setInterval>;
                    let unsubscribe = () => {};
                    const finish = () => {
                      if (closed) return;
                      closed = true;
                      clearInterval(timer);
                      unsubscribe();
                      req.signal.removeEventListener("abort", finish);
                      streams.delete(finish);
                      try {
                        controller.close();
                      } catch {}
                    };
                    const send = (value: string) => {
                      if (closed) return;
                      try {
                        if ((controller.desiredSize ?? 1) <= 0) {
                          finish();
                          return;
                        }
                        controller.enqueue(encoder.encode(value));
                      } catch {
                        finish();
                      }
                    };
                    const publish = (event: Activity) => {
                      if (event.id <= last) return;
                      last = event.id;
                      send(
                        `id: ${event.id}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`,
                      );
                    };
                    cleanup = finish;
                    streams.add(finish);
                    req.signal.addEventListener("abort", finish, {
                      once: true,
                    });
                    if (after < store.replayFloor() || after > store.cursor()) {
                      send(
                        `event: reset\ndata: ${JSON.stringify({ cursor: store.cursor(), reason: "Reload the current snapshot." })}\n\n`,
                      );
                      finish();
                      return;
                    }
                    // Replay bounded batches without yielding before subscription.
                    while (!closed) {
                      const batch = store.events(last);
                      for (const event of batch) publish(event);
                      if (batch.length < 512) break;
                    }
                    if (closed) return;
                    unsubscribe = service.subscribe(publish);
                    send(": connected\n\n");
                    if (closed) return;
                    timer = setInterval(() => send(": heartbeat\n\n"), 15000);
                    if (req.signal.aborted) finish();
                  },
                  cancel() {
                    cleanup();
                  },
                },
                {
                  highWaterMark: 1024 * 1024,
                  size: (chunk) => chunk?.byteLength ?? 0,
                },
              );
              return new Response(stream, {
                headers: {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache, no-transform",
                  Connection: "keep-alive",
                  "X-Accel-Buffering": "no",
                },
              });
            }
            if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/api/rendered-files/")) {
              controls.require(req, false);
              const file = await service.harness.files.read(url.pathname);
              if (!file) throw new HttpError(404, "Rendered file not found.");
              if (url.searchParams.get("preview") === "1" && file.metadata.kind === "text") {
                const text = new TextDecoder().decode(file.bytes);
                const preview = text.slice(0, 16000).split("\n").slice(0, 200).join("\n");
                return json({ text: preview, truncated: preview.length < text.length });
              }
              const download = url.searchParams.get("download") === "1";
              const html = !download && url.searchParams.get("inline") === "1" && isHtmlFile(file.metadata);
              const headers = new Headers({
                "Content-Type": html ? "text/html; charset=utf-8" : file.metadata.mimeType,
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": html
                  ? "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts"
                  : "default-src 'none'; sandbox",
                "Referrer-Policy": "no-referrer",
                "Content-Disposition": `${download || (file.metadata.kind === "text" && !html) ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.metadata.name)}`,
              });
              if (file.metadata.kind === "audio" || file.metadata.kind === "video")
                return mediaResponse(req, file.bytes, headers);
              headers.set("Content-Length", String(file.bytes.length));
              return new Response(req.method === "HEAD" ? null : new Uint8Array(file.bytes), { headers });
            }
            if (req.method === "GET" && url.pathname.startsWith("/api/tool-images/")) {
              controls.require(req, false);
              const image = readToolImage(store, url.pathname);
              if (!image) throw new HttpError(404, "Image attachment not found.");
              return new Response(new Uint8Array(image.bytes), { headers: {
                "Content-Type": image.mimeType,
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'; sandbox",
                "Content-Disposition": `inline; filename="image.${image.extension}"`,
              } });
            }
            if (req.method === "GET" && url.pathname.startsWith("/api/images/")) {
              controls.require(req, false);
              const bytes = await service.harness.images.read(url.pathname);
              if (!bytes) throw new HttpError(404, "Generated image not found.");
              return new Response(new Uint8Array(bytes), { headers: {
                "Content-Type": "image/png",
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'; sandbox",
                "Content-Disposition": 'inline; filename="generated-image.png"',
              } });
            }
            const upload = url.pathname.match(
              /^\/api\/agents\/([^/]+)\/uploads$/,
            );
            if (req.method === "POST" && upload) {
              controls.require(req);
              const agent = store.agent(upload[1]!);
              if (!agent) throw new HttpError(404, "Agent not found.");
              const directory = url.searchParams.get("directory");
              if (directory === agent.cwd) effectiveCwd(agent);
              return json(
                await uploadFile(req, directory, url.searchParams.get("name")),
                201,
              );
            }
            if (req.method === "POST" && url.pathname === "/api/directories") {
              controls.require(req);
              const input = await body(req);
              return json({ path: createDirectory(input.parent, input.name) }, 201);
            }
            if (req.method === "GET" && url.pathname === "/api/directories") {
              controls.require(req, false);
              return json(
                directories(
                  url.searchParams.get("path") ?? undefined,
                  url.searchParams.get("cursor") ?? "",
                  url.searchParams.get("hidden") === "true",
                ),
              );
            }
            if (url.pathname === "/api/projects") {
              if (req.method === "GET") return json(store.projects());
              if (req.method === "POST") {
                controls.require(req);
                return json(service.saveProject(null, await body(req)), 201);
              }
            }
            const projectMatch = url.pathname.match(
              /^\/api\/projects\/([^/]+)$/,
            );
            if (projectMatch) {
              controls.require(req);
              if (req.method === "PATCH")
                return json(
                  service.saveProject(projectMatch[1]!, await body(req)),
                );
              if (req.method === "DELETE")
                return json(service.deleteProject(projectMatch[1]!));
            }
            if (
              req.method === "GET" &&
              url.pathname === "/api/agents/archived"
            ) {
              const scope = url.searchParams.get("scope") ?? "all",
                projectId = url.searchParams.get("projectId");
              if (
                !["all", "ungrouped", "project"].includes(scope) ||
                (scope === "project" ? !projectId : !!projectId)
              )
                throw new HttpError(400, "Invalid archive scope.");
              return json(
                store.archivedAgents(
                  url.searchParams.get("after") ?? "",
                  50,
                  scope,
                  projectId,
                ),
              );
            }
            if (req.method === "POST" && url.pathname === "/api/agents") {
              const input = await body(req);
              if ("cwd" in input || "managedCwd" in input)
                throw new HttpError(
                  400,
                  "The working directory is inherited from the project.",
                );
              if (
                input.projectId !== undefined &&
                input.projectId !== null &&
                (typeof input.projectId !== "string" || !input.projectId)
              )
                throw new HttpError(400, "Invalid project.");
              return json(
                service.createAgent({
                  ...profile(input, true),
                  projectId: input.projectId as string | null | undefined,
                }),
                201,
              );
            }
            if (req.method === "PUT" && url.pathname === "/api/config") {
              const input = await body(req);
              if (
                input.mode !== undefined &&
                !["auto", "chatgpt", "api", "claude-code"].includes(String(input.mode))
              )
                throw new HttpError(400, "Unknown connection mode.");
              if (
                input.model !== undefined &&
                !MODEL_OPTIONS.some((m) => m.id === input.model)
              )
                throw new HttpError(400, "Unknown model.");
              if (
                input.effort !== undefined &&
                !EFFORT_OPTIONS.some((e) => e.id === input.effort)
              )
                throw new HttpError(400, "Unknown reasoning effort.");
              return json(
                service.setConfig({
                  agentId: input.agentId === undefined ? undefined : text(input.agentId, "Agent ID", 100),
                  mode: input.mode as Mode | undefined,
                  model: input.model as ModelId | undefined,
                  effort: input.effort as Effort | undefined,
                }),
              );
            }
            const match = url.pathname.match(
              /^\/api\/agents\/([^/]+)(?:\/(messages|stop|archive|restore|history|project|steer|fresh-session))?$/,
            );
            if (match) {
              const [, id, action] = match;
              if (req.method === "POST" && action === "fresh-session") {
                controls.require(req);
                const input = await body(req);
                return json(service.freshSession(id!, text(input.requestId, "Request ID", 100)), 202);
              }
              if (req.method === "PATCH" && action === "project") {
                controls.require(req);
                return json(
                  service.moveAgent(id!, (await body(req)).projectId),
                );
              }
              if (req.method === "GET" && action === "history") {
                const before = url.searchParams.get("before");
                if (
                  before !== null &&
                  (!/^\d+$/.test(before) ||
                    !Number.isSafeInteger(Number(before)) ||
                    Number(before) < 1)
                )
                  throw new HttpError(400, "Invalid history cursor.");
                return json(
                  service.historyPage(
                    id!,
                    before === null ? undefined : Number(before),
                  ),
                );
              }
              if (
                req.method === "POST" &&
                (action === "archive" || action === "restore")
              )
                return json(service.archiveAgent(id!, action === "archive"));
              if (req.method === "PATCH" && !action) {
                const input = await body(req);
                const existing = store.agent(id!);
                if (!existing) throw new HttpError(404, "Agent not found.");
                return json(service.updateAgent(id!, profile({ ...existing, ...input })));
              }
              if (req.method === "POST" && action === "messages") {
                const input = await body(req);
                const prompt = text(input.text, "Message", 24000);
                const requestId = text(input.requestId, "Request ID", 100);
                if (
                  input.mode !== undefined &&
                  input.mode !== "queue" &&
                  input.mode !== "steer"
                )
                  throw new HttpError(
                    400,
                    "Message mode must be queue or steer.",
                  );
                return json(
                  service.start(id!, requestId, prompt, input.mode ?? "queue"),
                  202,
                );
              }
              if (req.method === "POST" && action === "steer") {
                const input = await body(req);
                return json(
                  service.steer(id!, text(input.messageId, "Message ID", 100)),
                );
              }
              if (req.method === "POST" && action === "stop") {
                await service.stop(id!);
                return json({ ok: true });
              }
            }
            throw new HttpError(404, "API route not found.");
          }
          if (req.method !== "GET" && req.method !== "HEAD")
            throw new HttpError(405, "Method not allowed.");
          const pathname = decodeURIComponent(url.pathname);
          const target = resolve(staticDir, "." + pathname);
          if (target !== staticDir && !target.startsWith(staticDir + sep))
            throw new HttpError(404, "Not found.");
          const file = Bun.file(
            pathname === "/" || /^\/(?:apps|agents)(?:\/[^/]+(?:\/[^/]+)*)?\/?$/.test(pathname) ? join(staticDir, "index.html") : target,
          );
          if (!(await file.exists()))
            throw new HttpError(
              404,
              "Not found. Run bun run build to build the web client.",
            );
          return new Response(req.method === "HEAD" ? null : file, {
            headers: {
              "Content-Type": file.type,
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "frame-ancestors 'none'; frame-src http: https:",
              "X-Frame-Options": "DENY",
              "Referrer-Policy": "no-referrer",
              "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), fullscreen=()",
              "Cache-Control": pathname.startsWith("/assets/")
                ? "public, max-age=31536000, immutable"
                : "no-cache",
            },
          });
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Unexpected server error",
            },
            error instanceof HttpError ? error.status : 500,
          );
        }
      },
    } satisfies Bun.ServeOptions<VncData>;
    const server = Bun.serve<VncData>(listenerOptions);
    listeners.push(server);
    cleanup = async () => {
      connections.close();
      for (const finish of [...streams]) finish();
      // Abort tools/handoffs while closing HTTP: an in-flight request may itself
      // be waiting for one of those tools, so neither shutdown can await the other.
      const outcomes = await Promise.allSettled([
        ...listeners.map(listener => listener.stop(true)),
        service.close(),
      ]);
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    };
    listenerOrigins.push(...addresses.map(host => `http://${host.includes(":") ? `[${host}]` : host}:${server.port}`));
    for (const hostname of addresses) {
      listeners.push(Bun.serve<VncData>({ ...listenerOptions, hostname, port: server.port }));
    }
    service.apps.configureOrigins([server.url.origin, `http://localhost:${server.port}`, ...listenerOrigins]);
    service.chrome.protectOrigins([server.url.origin, `http://localhost:${server.port}`, ...listenerOrigins]);
    let closing: Promise<void> | undefined;
    return {
      server,
      servers: listeners,
      service,
      store,
      close() {
        return (closing ??= cleanup().finally(releaseInstance));
      },
    };
  } catch (error) {
    try {
      await cleanup();
    } finally {
      releaseInstance();
    }
    throw error;
  }
}
