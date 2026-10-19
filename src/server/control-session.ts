import { timingSafeEqual } from "node:crypto";
import { HttpError } from "./errors";
interface Session {
  id: string;
  csrf: string;
  expires: number;
}
const names = new Set(["jelly_control", "__Host-jelly_control"]);
export class ControlSessions {
  private sessions = new Map<string, Session>();
  readonly cookieName = "jelly_control";
  constructor(private readonly allowedOrigins: string[] = []) {}
  private secure(req: Request) {
    return (
      new URL(req.url).protocol === "https:" ||
      this.allowedOrigins.some((origin) => {
        const url = new URL(origin);
        return (
          url.protocol === "https:" && url.host === req.headers.get("host")
        );
      })
    );
  }
  private cookie(req: Request) {
    const cookies = (req.headers.get("cookie") ?? "")
      .split(";")
      .map((pair) => {
        const at = pair.indexOf("=");
        return {
          name: (at < 0 ? pair : pair.slice(0, at)).trim(),
          value: at < 0 ? "" : pair.slice(at + 1).trim(),
        };
      })
      .filter((cookie) => names.has(cookie.name));
    if (cookies.length > 1)
      throw new HttpError(
        400,
        "Ambiguous control cookies. Clear conflicting path/domain cookies and reopen Jelly.",
      );
    const expected = this.secure(req)
      ? "__Host-jelly_control"
      : this.cookieName;
    return cookies[0]?.name === expected ? cookies[0].value : undefined;
  }
  get(req: Request): Session | null {
    const id = this.cookie(req);
    const session = id ? this.sessions.get(id) : undefined;
    if (!session || session.expires < Date.now()) return null;
    return session;
  }
  valid(id: string) {
    const session = this.sessions.get(id);
    return !!session && session.expires >= Date.now();
  }
  create(req: Request) {
    for (const [id, session] of this.sessions)
      if (session.expires < Date.now()) this.sessions.delete(id);
    // HTTPS never adopts an unprefixed HTTP/legacy credential. Retire its known paths.
    const prior = this.get(req);
    const session = prior ?? {
      id: crypto.randomUUID(),
      csrf: crypto.randomUUID(),
      expires: 0,
    };
    session.expires = Date.now() + 24 * 60 * 60 * 1000;
    this.sessions.set(session.id, session);
    const secure = this.secure(req);
    return {
      session,
      cookie: secure
        ? `__Host-jelly_control=${session.id}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`
        : `${this.cookieName}=${session.id}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=86400`,
      retiredCookies: secure
        ? ["/api", "/"].map(
            (path) =>
              `jelly_control=; Secure; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=0`,
          )
        : [],
    };
  }
  require(req: Request, csrf = true) {
    const session = this.get(req);
    if (!session)
      throw new HttpError(
        401,
        "Open Jelly again to establish a control session.",
      );
    if (csrf) {
      const a = Buffer.from(req.headers.get("x-jelly-csrf") ?? ""),
        b = Buffer.from(session.csrf);
      if (a.length !== b.length || !timingSafeEqual(a, b))
        throw new HttpError(
          403,
          "Invalid control token. Reload Jelly and try again.",
        );
    }
    return session;
  }
}
