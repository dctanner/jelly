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

// Additive pause diagnostics; unknown/older peers never imply native handoff.
const pauseReasons = {
  requested: "An explicit automation pause was requested.",
  native_handoff: "A native desktop private handoff paused automation.",
  settlement: "The task is settling.",
  navigation_denied: "A browser navigation event failed destination policy.",
  debugger_detached: "The browser debugger was detached unexpectedly.",
  debugger_attach_failed: "Debugger attachment failed; cleanup is required.",
  cleanup_failed: "Debugger cleanup failed or is uncertain.",
  tab_replaced: "Chrome replaced a leased tab; authority was not transferred.",
  popup_denied: "A popup destination or its adoption failed policy checks.",
} as const;
export type ChromePauseReason = keyof typeof pauseReasons;
export function chromePauseReason(value: unknown): ChromePauseReason | undefined {
  return typeof value === "string" && Object.hasOwn(pauseReasons, value)
    ? value as ChromePauseReason : undefined;
}
// Fixed diagnostic schema/build marker, not a pairing protocol or authority grant.
export const CHROME_NAVIGATION_DIAGNOSTIC_REVISION = "internal_v2" as const;
const navigationEvents = ["committed", "history", "fragment"] as const;
const navigationFrames = ["main", "child", "unknown"] as const;
const navigationDestinations = [
  "inherited_blank", "inherited_srcdoc", "protected_origin", "credentials",
  "url_too_long", "invalid_url", "invalid_policy", "data", "blob", "file",
  "chromium_error_document", "chromium_error_variant", "chrome_error_other",
  "chrome_internal", "extension_self", "extension_other", "devtools",
  "browser_internal", "about_other", "other_nonweb", "unknown",
] as const;
export interface ChromeNavigationDiagnostic {
  event: typeof navigationEvents[number];
  frame: typeof navigationFrames[number];
  destination: typeof navigationDestinations[number];
  revision?: typeof CHROME_NAVIGATION_DIAGNOSTIC_REVISION;
}
/** Copy only fixed enum values; never carry a URL, origin, token or raw error. */
export function chromeNavigationDiagnostic(value: unknown): ChromeNavigationDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (!navigationEvents.includes(v.event as ChromeNavigationDiagnostic["event"]) ||
      !navigationFrames.includes(v.frame as ChromeNavigationDiagnostic["frame"]) ||
      !navigationDestinations.includes(v.destination as ChromeNavigationDiagnostic["destination"]))
    return undefined;
  return {
    event: v.event, frame: v.frame, destination: v.destination,
    ...(v.revision === CHROME_NAVIGATION_DIAGNOSTIC_REVISION ? { revision: v.revision } : {}),
  } as ChromeNavigationDiagnostic;
}
export function chromePauseError(value: unknown, diagnostic?: unknown): string {
  const reason = chromePauseReason(value);
  const navigation = reason === "navigation_denied" ? chromeNavigationDiagnostic(diagnostic) : undefined;
  const classification = navigation ? ` Navigation classification: event=${navigation.event}, frame=${navigation.frame}, destination=${navigation.destination}.` : "";
  const detail = reason === "navigation_denied"
    ? `${classification} Diagnostic revisions: backend=${CHROME_NAVIGATION_DIAGNOSTIC_REVISION}, worker=${navigation?.revision ?? "unreported"}.`
    : "";
  return `Chrome automation paused [${reason ?? "unknown"}]: ${reason ? pauseReasons[reason] : "The pause cause was not reported by the connected extension."}${detail} Finish any native private handoff or ask the operator to repair the affected session; browser_reconnect cannot bypass this boundary. Human computer-control status and observation refusals alone do not pause automation.`;
}

export function chromeOperationError(value: unknown): string {
  const reason = chromeFailureReason(value);
  if (reason)
    return `Chrome observation blocked [${reason}]: ${reasons[reason]} No operation was replayed.`;
  return "Chrome operation unavailable or revoked. Re-observe before retrying; mutations are never replayed.";
}
