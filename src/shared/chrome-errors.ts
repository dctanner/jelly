// Fixed diagnostics only: never forward page text, selectors, URLs or native errors.
const reasons = {
  origin_changed: "The document origin changed.",
  unsupported_embed: "The page contains an unsupported object/embed.",
  dom_limit: "The document exceeds the 10,000-element inspection limit.",
  shadow_inspection_unavailable:
    "Chrome shadow-root inspection is unavailable.",
  shadow_root: "The page contains an unsupported author shadow root.",
  secret_field: "The page contains a field classified as secret.",
  unsupported_frame:
    "The page contains a hidden, clipped or unsupported frame.",
  screenshot_form_content:
    "Screenshot blocked by nonempty or editable form content.",
  stale_reference: "The element reference is stale or unavailable.",
  unsupported_operation: "The requested page operation is unsupported.",
} as const;

export type ChromeFailureReason = keyof typeof reasons;

export function chromeFailureReason(
  value: unknown,
): ChromeFailureReason | undefined {
  return typeof value === "string" && Object.hasOwn(reasons, value)
    ? (value as ChromeFailureReason)
    : undefined;
}

export class ChromeObservationError extends Error {
  constructor(readonly reason: ChromeFailureReason) {
    super(reasons[reason]);
  }
}

export function chromeOperationError(value: unknown): string {
  const reason = chromeFailureReason(value);
  if (reason)
    return `Chrome observation blocked [${reason}]: ${reasons[reason]} No operation was replayed.`;
  return "Chrome operation unavailable or revoked. Re-observe before retrying; mutations are never replayed.";
}
