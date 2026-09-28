import { timingSafeEqual } from "node:crypto";
import { HttpError } from "./errors";
interface Session {
  id: string;
  csrf: string;
  expires: number;
}
export class ControlSessions {
  private sessions = new Map<string, Session>();
  readonly cookieName = "jelly_control";
  private cookie(req: Request) {
    return req.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(this.cookieName + "="))
      ?.slice(this.cookieName.length + 1);
  }
  get(req: Request): Session | null {
    const id = this.cookie(req);
    const session = id ? this.sessions.get(id) : undefined;
    if (!session || session.expires < Date.now()) return null;
    return session;
  }
  create(req: Request) {
    for (const [id, s] of this.sessions)
      if (s.expires < Date.now()) this.sessions.delete(id);
    const prior = this.get(req);
    const session = prior ?? {
      id: crypto.randomUUID(),
      csrf: crypto.randomUUID(),
      expires: 0,
    };
    session.expires = Date.now() + 24 * 60 * 60 * 1000;
    this.sessions.set(session.id, session);
    return {
      session,
      cookie: `${this.cookieName}=${session.id}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=86400`,
    };
  }
  require(req: Request, csrf = true) {
    const s = this.get(req);
    if (!s)
      throw new HttpError(
        401,
        "Open Jelly again to establish a control session.",
      );
    if (csrf) {
      const value = req.headers.get("x-jelly-csrf") ?? "";
      const a = Buffer.from(value),
        b = Buffer.from(s.csrf);
      if (a.length !== b.length || !timingSafeEqual(a, b))
        throw new HttpError(
          403,
          "Invalid control token. Reload Jelly and try again.",
        );
    }
    return s;
  }
}
