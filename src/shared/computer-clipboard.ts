/** Human-only text transfer; RFB clipboard synchronization remains disabled. */
export const COMPUTER_CLIPBOARD_MAX_BYTES = 256 * 1024;
// JSON may spell every ASCII byte as \uXXXX. This limit applies only to clipboard send.
export const COMPUTER_CLIPBOARD_BODY_BYTES =
  COMPUTER_CLIPBOARD_MAX_BYTES * 6 + 1024;
export function validClipboardText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const bytes = new TextEncoder().encode(value);
  return (
    bytes.length <= COMPUTER_CLIPBOARD_MAX_BYTES &&
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) === value
  );
}
export interface ComputerClipboardIdentity {
  controlId: string;
  generation: number;
}
