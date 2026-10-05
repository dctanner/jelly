/** Layout-coordinate bounds of the screen not covered by the keyboard. */
export function visibleViewport() {
  const viewport = window.visualViewport;
  return {
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  };
}

export function observeViewport(update: () => void) {
  const viewport = window.visualViewport;
  window.addEventListener("resize", update);
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  update();
  return () => {
    window.removeEventListener("resize", update);
    viewport?.removeEventListener("resize", update);
    viewport?.removeEventListener("scroll", update);
  };
}

export function viewportInsets() {
  const style = getComputedStyle(document.documentElement);
  const inset = (side: string) =>
    Math.max(
      12,
      parseFloat(style.getPropertyValue(`--safe-area-${side}`)) || 0,
    );
  return {
    top: inset("top"),
    right: inset("right"),
    bottom: inset("bottom"),
    left: inset("left"),
  };
}
