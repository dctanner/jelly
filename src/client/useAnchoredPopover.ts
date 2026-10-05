import { useLayoutEffect, type RefObject } from "react";
import { observeViewport, visibleViewport, viewportInsets } from "./viewport";

export function placePopover(
  anchor: { left: number; right: number; top: number; bottom: number },
  size: { width: number; height: number },
  bounds: { left: number; right: number; top: number; bottom: number },
  preferred: "above" | "below",
) {
  const gap = 8;
  const usableHeight = Math.max(0, bounds.bottom - bounds.top);
  const above = Math.min(
    usableHeight,
    Math.max(0, anchor.top - gap - bounds.top),
  );
  const below = Math.min(
    usableHeight,
    Math.max(0, bounds.bottom - anchor.bottom - gap),
  );
  const upwards =
    preferred === "above"
      ? above >= size.height || above >= below
      : !(below >= size.height || below >= above);
  const height = Math.min(size.height, upwards ? above : below);
  return {
    left: Math.max(
      bounds.left,
      Math.min(anchor.right - size.width, bounds.right - size.width),
    ),
    top: Math.max(
      bounds.top,
      Math.min(
        upwards ? anchor.top - gap - height : anchor.bottom + gap,
        bounds.bottom - height,
      ),
    ),
    maxHeight: upwards ? above : below,
  };
}

/** The panel is portalled to body, outside transformed/clipping page ancestors. */
export function useAnchoredPopover(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLDivElement | null>,
  preferred: "above" | "below",
) {
  useLayoutEffect(() => {
    const element = panel.current;
    if (!open || !anchor.current || !element) return;
    const update = () => {
      if (!anchor.current) return;
      const viewport = visibleViewport();
      const inset = viewportInsets();
      const bounds = {
        left: viewport.left + inset.left,
        right: viewport.left + viewport.width - inset.right,
        top: viewport.top + inset.top,
        bottom: viewport.top + viewport.height - inset.bottom,
      };
      element.style.maxWidth = `${Math.max(0, bounds.right - bounds.left)}px`;
      const position = placePopover(
        anchor.current.getBoundingClientRect(),
        { width: element.offsetWidth, height: element.scrollHeight + 2 },
        bounds,
        preferred,
      );
      element.style.left = `${position.left}px`;
      element.style.top = `${position.top}px`;
      element.style.maxHeight = `${position.maxHeight}px`;
    };
    const unobserve = observeViewport(update);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(anchor.current);
    observer?.observe(element);
    for (
      let parent = anchor.current.parentElement;
      parent;
      parent = parent.parentElement
    )
      observer?.observe(parent);
    // Capturing observes scrolling containers as well as the document.
    document.addEventListener("scroll", update, true);
    return () => {
      unobserve();
      observer?.disconnect();
      document.removeEventListener("scroll", update, true);
    };
  }, [open, anchor, panel, preferred]);
}
