import { CronExpressionParser } from "cron-parser";
import { HttpError } from "./errors";
import type { ScheduleInput, AgentSchedule } from "../shared/schedules";

export const DEFAULT_LATENESS_SECONDS = 86_400;
export function timezone(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 100 ||
    !value ||
    /^[+-]/.test(value)
  )
    throw new HttpError(400, "An explicit IANA timezone is required.");
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions()
      .timeZone;
  } catch {
    throw new HttpError(400, "Invalid IANA timezone.");
  }
}
function wallTime(time: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(time);
  const get = (name: string) =>
    Number(parts.find((p) => p.type === name)!.value);
  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
}
/** The pinned parser rejects an impossible DOM/month pair before considering
 * DOW's OR branch (e.g. February 30 OR Monday). Its specific validation error
 * means every DOM value is impossible in that single month; retain the valid
 * weekday branch rather than rejecting the whole schedule. All field parsing
 * and range validation still belong to cron-parser. */
function parseCron(
  cron: string,
  options: Parameters<typeof CronExpressionParser.parse>[1],
) {
  try {
    return CronExpressionParser.parse(cron, options);
  } catch (error) {
    const fields = cron.split(" ");
    if (
      !(error instanceof Error) ||
      error.message !== "Invalid explicit day of month definition" ||
      fields.length !== 5 ||
      fields[2] === "*" ||
      fields[4] === "*"
    )
      throw error;
    // Validate all original fields without the impossible month/day combination.
    CronExpressionParser.parse(
      [fields[0], fields[1], fields[2], "*", fields[4]].join(" "),
      options,
    );
    return CronExpressionParser.parse(
      [fields[0], fields[1], "*", fields[3], fields[4]].join(" "),
      options,
    );
  }
}
/** cron-parser owns parsing/OR semantics. Filter its gap normalization and second
 * fold instants explicitly: our calendar contract skips gaps and uses the first fold. */
export function cronInstant(
  cron: string,
  zone: string,
  from: number,
  direction: "next" | "prev" = "next",
): string {
  try {
    const parse = (currentDate: number) =>
      parseCron(cron, {
        tz: zone,
        currentDate,
        ...(direction === "next"
          ? { endDate: from + 8 * 366 * 86_400_000 }
          : { startDate: from - 8 * 366 * 86_400_000 }),
      });
    let expression = parse(from);
    for (let i = 0; i < 32; i++) {
      const candidate = expression[direction]();
      const t = candidate.getTime();
      if (
        !expression.fields.hour.values.some(
          (value) => value === candidate.getHours(),
        ) ||
        !expression.fields.minute.values.some(
          (value) => value === candidate.getMinutes(),
        )
      )
        continue;
      const wall = wallTime(t, zone);
      const prior = t - 36 * 3_600_000;
      const offset = wall - t,
        priorOffset = wallTime(prior, zone) - prior;
      if (
        priorOffset > offset &&
        wallTime(t - (priorOffset - offset), zone) === wall
      ) {
        // Jump over the entire repeated interval, including every-minute crons.
        // Searching candidates one-by-one would both be unbounded and choose an
        // older first-fold minute instead of the latest eligible minute.
        let low = prior,
          high = t;
        while (high - low > 1000) {
          const middle = Math.floor((low + high) / 2000) * 1000;
          if (wallTime(middle, zone) - middle === offset) high = middle;
          else low = middle;
        }
        expression = parse(
          direction === "prev" ? high : high + priorOffset - offset - 1,
        );
        continue;
      }
      return new Date(t).toISOString();
    }
  } catch {
    /* Convert library errors to the stable validation contract. */
  }
  throw new HttpError(
    400,
    "Cron has no matching time within the bounded eight-year search.",
  );
}
export function validateSchedule(
  input: Record<string, unknown>,
  now: number,
): ScheduleInput & { catchUp: "latest" | "none"; maxLatenessSeconds: number } {
  const text = (key: string, max: number) => {
    const value = input[key];
    if (typeof value !== "string" || !value.trim() || value.length > max)
      throw new HttpError(400, `${key} must contain 1–${max} characters.`);
    return value;
  };
  const title = text("title", 120),
    prompt = text("prompt", 24_000),
    zone = timezone(input.timezone);
  const catchUp = input.catchUp === undefined ? "latest" : input.catchUp,
    maxLatenessSeconds =
      input.maxLatenessSeconds === undefined
        ? DEFAULT_LATENESS_SECONDS
        : input.maxLatenessSeconds;
  if (catchUp !== "latest" && catchUp !== "none")
    throw new HttpError(400, "catchUp must be latest or none.");
  if (
    typeof maxLatenessSeconds !== "number" ||
    !Number.isInteger(maxLatenessSeconds) ||
    maxLatenessSeconds < 60 ||
    maxLatenessSeconds > DEFAULT_LATENESS_SECONDS
  )
    throw new HttpError(400, "Maximum lateness must be 60–86400 seconds.");
  const common = {
    title,
    prompt,
    timezone: zone,
    catchUp: catchUp as "latest" | "none",
    maxLatenessSeconds,
  };
  if (input.kind === "once") {
    const runAt = text("runAt", 64);
    if (
      input.cron != null ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(
        runAt,
      ) ||
      !Number.isFinite(Date.parse(runAt))
    )
      throw new HttpError(
        400,
        "One-off time must be an absolute ISO timestamp with an offset.",
      );
    // Date.parse normalizes invalid calendar days; reject them before accepting intent.
    const [year, month, day] = runAt.slice(0, 10).split("-").map(Number) as [
      number,
      number,
      number,
    ];
    if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate())
      throw new HttpError(400, "Invalid calendar date.");
    if (Date.parse(runAt) <= now)
      throw new HttpError(
        400,
        "Choose a future time; use ordinary chat for now.",
      );
    return { ...common, kind: "once", runAt: new Date(runAt).toISOString() };
  }
  if (input.kind !== "cron" || input.runAt != null)
    throw new HttpError(400, "Choose once or cron timing, not both.");
  const cron = text("cron", 120).trim().replace(/\s+/g, " ");
  // Only standard five-field syntax, including conventional month/day names.
  if (
    cron.split(" ").length !== 5 ||
    !/^[\d*,/\- A-Za-z]+$/.test(cron) ||
    /[A-Za-z]/.test(
      cron.replace(
        /\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|SUN|MON|TUE|WED|THU|FRI|SAT)\b/gi,
        "",
      ),
    )
  )
    throw new HttpError(
      400,
      "Use standard five-field cron, without seconds or commands.",
    );
  cronInstant(cron, zone, now);
  return { ...common, kind: "cron", cron };
}
export function previewSchedule(
  schedule: Pick<AgentSchedule, "kind" | "runAt" | "cron" | "timezone">,
  from: number,
): string[] {
  if (schedule.kind === "once") return schedule.runAt ? [schedule.runAt] : [];
  const times: string[] = [];
  for (let i = 0; i < 3; i++) {
    const next = cronInstant(schedule.cron!, schedule.timezone, from);
    times.push(next);
    from = Date.parse(next);
  }
  return times;
}
