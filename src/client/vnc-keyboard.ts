/** noVNC listens for keyup on its canvas but releases keys on window blur only.
 * Route releases through that same handler on local canvas blur, so both the
 * remote keys and noVNC's pressed-key map are cleared before using local controls.
 */
export function bindViewerKeyboardCleanup(display: HTMLElement, isCurrent: () => boolean) {
  let owner: HTMLCanvasElement | null = null;
  const pressed = new Map<string, KeyboardEventInit>();
  const identity = (event: KeyboardEvent) =>
    event.code && event.code !== "Unidentified" ? event.code : `${event.keyCode}:${event.location}`;
  const canvasTarget = (event: Event) => {
    const canvas = display.querySelector("canvas");
    return canvas && event.target === canvas ? canvas : null;
  };
  const down = (event: KeyboardEvent) => {
    const canvas = canvasTarget(event);
    if (!canvas || !isCurrent()) return;
    if (owner !== canvas) { pressed.clear(); owner = canvas; }
    // Physical key identity only; never retain typed text or entire DOM events.
    pressed.set(identity(event), { code: event.code, keyCode: event.keyCode, location: event.location });
  };
  const up = (event: KeyboardEvent) => {
    if (event.target === owner) pressed.delete(identity(event));
  };
  const blur = (event: FocusEvent) => {
    if (!owner || event.target !== owner) return;
    const canvas = owner;
    const keys = [...pressed.values()];
    pressed.clear();
    owner = null;
    for (const key of keys) {
      if (!isCurrent() || !canvas.isConnected || display.querySelector("canvas") !== canvas) break;
      // Key-up only, on the originating canvas. Do not synthesize global blur,
      // call private noVNC methods, reconnect, or release into a newer viewer.
      canvas.dispatchEvent(new window.KeyboardEvent("keyup", {
        ...key, bubbles: true, cancelable: true,
      }));
    }
  };
  display.addEventListener("keydown", down, true);
  display.addEventListener("keyup", up, true);
  display.addEventListener("blur", blur, true);
  return () => {
    pressed.clear();
    owner = null;
    display.removeEventListener("keydown", down, true);
    display.removeEventListener("keyup", up, true);
    display.removeEventListener("blur", blur, true);
  };
}
