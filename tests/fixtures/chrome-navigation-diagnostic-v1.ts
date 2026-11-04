// Frozen pre-internal_v2 validator, copied from shared/chrome-errors.ts for
// wire-compatibility regression tests. Do not import the current allowlists:
// unknown categories were dropped, never rewritten to browser_internal.
const navigationEvents = ["committed", "history", "fragment"];
const navigationFrames = ["main", "child", "unknown"];
const navigationDestinations = [
  "inherited_blank", "inherited_srcdoc", "protected_origin", "credentials",
  "url_too_long", "invalid_url", "invalid_policy", "data", "blob", "file",
  "chromium_error_document", "browser_internal", "about_other", "other_nonweb", "unknown",
];
export function legacyChromeNavigationDiagnostic(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (!navigationEvents.includes(v.event as string) ||
      !navigationFrames.includes(v.frame as string) ||
      !navigationDestinations.includes(v.destination as string))
    return undefined;
  return { event: v.event, frame: v.frame, destination: v.destination };
}
