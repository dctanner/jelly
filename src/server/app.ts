import { DEFAULT_AGENT_NAME } from "../shared/agent-names";
import { AVATARS } from "../shared/avatars";
import { directories, effectiveCwd } from "./directories";
import { uploadFile } from "./uploads";
import { readToolImage } from "./tool-images";
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
export interface AppOptions {
  dataDir: string;
  sudoExecutor?: SudoExecutor;
  interventionTtlMs?: number;
  authPath?: string;
  configDir?: string;
  chatgptLogin?: ChatGPTLogin;
  loginTtlMs?: number;
  port?: number;
  allowedOrigins?: string[];
  staticDir?: string;
}
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
async function body(req: Request) {
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
        if (size > 64000) {
          await reader.cancel();
          throw new HttpError(413, "Request is too large.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Invalid JSON object.");
  }
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
    const service = new JellyService(
      store,
      await Harness.create(
        dataDir,
        options.authPath,
        options.configDir,
      ),
      options,
    );
    cleanup = () => service.close();
    const controls = new ControlSessions();
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
      path: string;
      generation: number;
      session: string;
      socket?: Socket;
      detach?: () => void;
    }
    const server = Bun.serve<VncData>({
      websocket: {
        open(ws) {
          if (
            !service.computer.validConnection(
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
          ws.data.detach = service.computer.attach(close);
          socket.on("data", (chunk) => {
            if (ws.send(chunk, true) === -1) socket.pause();
          });
          socket.on("error", close);
          socket.on("close", close);
        },
        message(ws, message) {
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
      async fetch(req) {
        const url = new URL(req.url);
        try {
          if (req.headers.has("x-jelly-managed-browser"))
            throw new HttpError(
              403,
              "The managed browser cannot access Jelly control.",
            );
          const allowedHosts = new Set([
            `127.0.0.1:${server.port}`,
            `localhost:${server.port}`,
            ...(options.allowedOrigins ?? []).map(
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
              ...(options.allowedOrigins ?? []),
            ]);
            if (origin && !allowed.has(origin))
              throw new HttpError(403, "This origin is not allowed.");
            if (req.headers.get("sec-fetch-site") === "cross-site")
              throw new HttpError(403, "Cross-site requests are not allowed.");
            if (
              req.method === "GET" &&
              url.pathname === "/api/control-session"
            ) {
              const { session, cookie } = controls.create(req);
              return Response.json(
                { csrf: session.csrf },
                {
                  headers: {
                    "Set-Cookie": cookie,
                    "Cache-Control": "no-store",
                  },
                },
              );
            }
            if (
              req.method === "GET" &&
              url.pathname === "/api/computer/socket"
            ) {
              if (!origin || !allowed.has(origin))
                throw new HttpError(403, "A same-origin browser is required.");
              const session = controls.require(req, false);
              const connection = service.computer.consume(
                url.searchParams.get("ticket") ?? "",
                session.id,
              );
              if (server.upgrade(req, { data: connection })) return;
              throw new HttpError(400, "WebSocket upgrade required.");
            }
            if (req.method === "GET" && url.pathname === "/api/computer")
              return json(
                service.computer.state(controls.require(req, false).id),
              );
            if (
              req.method === "POST" &&
              url.pathname.startsWith("/api/computer/")
            ) {
              const session = controls.require(req),
                action = url.pathname.slice("/api/computer/".length);
              if (action === "start") {
                await service.computer.ensure();
                return json(service.computer.state(session.id));
              }
              if (action === "take")
                return json(await service.computer.take(session.id));
              if (action === "recover") {
                const input = await body(req);
                if (input.confirm !== "discard-private-desktop")
                  throw new HttpError(400, "Confirm that the private tabs and clipboard will be discarded.");
                const handoff = service.computer.state().handoffId;
                // recover() synchronously revokes old ownership before cancelling the handoff.
                const recovery = service.computer.recover(session.id);
                if (handoff) service.interventions.cancel(handoff);
                return json(await recovery);
              }
              if (action === "release") {
                const id = await service.computer.release(session.id);
                if (id && store.intervention(id)?.status === "pending")
                  service.interventions.completeLogin(id);
                return json(service.computer.state(session.id));
              }
              if (action === "clipboard") {
                const input = await body(req);
                if (input.operation !== "read" && input.operation !== "write")
                  throw new HttpError(400, "Clipboard operation must be read or write.");
                return json(await service.computer.clipboard(session.id, input.operation, input.text));
              }
              if (action === "ticket") {
                const input = await body(req);
                if (input.mode !== "view" && input.mode !== "control")
                  throw new HttpError(400, "Invalid access mode.");
                return json(
                  await service.computer.ticket(session.id, input.mode),
                );
              }
            }
            const intervention = url.pathname.match(
              /^\/api\/interventions\/([^/]+)\/(approve|deny)$/,
            );
            if (req.method === "POST" && intervention) {
              controls.require(req);
              const [, id, action] = intervention;
              if (action === "deny") {
                const item = service.interventions.deny(id!);
                if (item.kind === "browser_login")
                  service.computer.cancelLogin(id!);
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
                return json(connections.status(session.id));
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
              return json({ ok: true, instanceId: store.instance().id });
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
                  controls.get(req)?.id,
                ),
              );
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
            if (req.method === "GET" && url.pathname.startsWith("/api/rendered-files/")) {
              controls.require(req, false);
              const file = await service.harness.files.read(url.pathname);
              if (!file) throw new HttpError(404, "Rendered file not found.");
              if (url.searchParams.get("preview") === "1" && file.metadata.kind === "text") {
                const text = new TextDecoder().decode(file.bytes);
                const preview = text.slice(0, 16000).split("\n").slice(0, 200).join("\n");
                return json({ text: preview, truncated: preview.length < text.length });
              }
              return new Response(new Uint8Array(file.bytes), { headers: {
                "Content-Type": file.metadata.mimeType,
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'; sandbox",
                "Content-Disposition": `${file.metadata.kind === "text" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.metadata.name)}`,
              } });
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
                !["auto", "chatgpt", "api"].includes(String(input.mode))
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
            pathname === "/" ? join(staticDir, "index.html") : target,
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
    });
    cleanup = async () => {
      connections.close();
      for (const finish of [...streams]) finish();
      // Abort tools/handoffs while closing HTTP: an in-flight request may itself
      // be waiting for one of those tools, so neither shutdown can await the other.
      const outcomes = await Promise.allSettled([
        server.stop(true),
        service.close(),
      ]);
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    };
    service.computer.protectOrigins([
      server.url.origin,
      `http://localhost:${server.port}`,
      ...(options.allowedOrigins ?? []),
    ]);
    let closing: Promise<void> | undefined;
    return {
      server,
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
