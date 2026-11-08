// Pause diagnostics still emitted by the v9 extension. Unknown/older peers
// never imply native handoff.
const pauseReasons = {
  requested: "An explicit automation pause was requested.",
  native_handoff: "A native desktop private handoff paused automation.",
  settlement: "The task is settling.",
  cleanup_failed: "Debugger cleanup failed or is uncertain.",
} as const;
export type ChromePauseReason = keyof typeof pauseReasons;
export function chromePauseReason(value: unknown): ChromePauseReason | undefined {
  return typeof value === "string" && Object.hasOwn(pauseReasons, value)
    ? (value as ChromePauseReason)
    : undefined;
}
export function chromePauseError(value: unknown): string {
  const reason = chromePauseReason(value);
  return `Chrome automation paused [${reason ?? "unknown"}]: ${reason ? pauseReasons[reason] : "The pause cause was not reported by the connected extension."} Finish any sign-in/native private handoff using its existing human control, then resume.`;
}
