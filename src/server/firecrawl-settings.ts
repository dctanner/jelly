import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { FirecrawlStatus } from "../shared/types";
import { HttpError } from "./errors";

/** Separate from public config, SQLite activity and model-provider credentials. */
export class FirecrawlSettings {
  private readonly path: string;
  constructor(
    private readonly dataDir: string,
    private readonly environmentKey = () => process.env.FIRECRAWL_API_KEY,
  ) {
    this.path = join(dataDir, "firecrawl.json");
  }
  private stored(): { apiKey: string | null } | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new HttpError(500, "Could not read Firecrawl settings.");
    }
    try {
      const value = JSON.parse(raw);
      if (
        value?.version !== 1 ||
        (value.apiKey !== null && !this.validKey(value.apiKey))
      ) throw new Error();
      return value;
    } catch {
      // Never echo file contents, and never silently fall back after corruption.
      throw new HttpError(500, "Firecrawl settings could not be read. Save the key again in Settings → Firecrawl.");
    }
  }
  private validKey(value: unknown): value is string {
    return typeof value === "string" && /^fc-[A-Za-z0-9_-]{16,1021}$/.test(value);
  }
  apiKey(): string | undefined {
    const saved = this.stored();
    // A persisted removal disables legacy fallback, even after a restart.
    return saved ? saved.apiKey ?? undefined : this.environmentKey()?.trim() || undefined;
  }
  status(): FirecrawlStatus {
    const saved = this.stored();
    const key = saved ? saved.apiKey : this.environmentKey()?.trim();
    return {
      configured: !!key,
      source: key ? saved ? "settings" : "environment" : null,
    };
  }
  private persist(apiKey: string | null) {
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, apiKey }) + "\n");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.path);
      fd = openSync(this.dataDir, "r");
      fsyncSync(fd);
    } catch {
      throw new HttpError(500, "Could not save Firecrawl settings. Reload Settings before trying again.");
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      try { rmSync(temporary, { force: true }); } catch {}
    }
    return this.status();
  }
  save(value: unknown) {
    if (typeof value !== "string" || !this.validKey(value.trim()))
      throw new HttpError(400, "Enter a valid Firecrawl API key beginning with fc-.");
    return this.persist(value.trim());
  }
  importEnvironment() {
    // A stale Settings tab must not overwrite a saved or intentionally removed key.
    if (this.stored() !== undefined)
      throw new HttpError(409, "Firecrawl settings have changed. Reload before replacing the key.");
    const key = this.environmentKey()?.trim();
    if (!key) throw new HttpError(409, "No Firecrawl key is configured in the server environment.");
    return this.save(key);
  }
  remove() {
    return this.persist(null);
  }
}
