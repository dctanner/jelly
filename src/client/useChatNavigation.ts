import { useEffect, type RefObject } from "react";

/** An in-app back gesture starts inside the page, leaving Safari's edge alone. */
export function useChatNavigation(
  root: RefObject<HTMLDivElement | null>,
  mobile: boolean,
  listOpen: boolean,
  onBack: () => void,
) {
  useEffect(() => {
    const app = root.current;
    if (!app || !mobile || listOpen) return;
    let gesture: {
      x: number;
      y: number;
      start: number;
      distance: number;
      active: boolean;
    } | null = null;
    const clear = () => {
      delete app.dataset.swiping;
      app.style.removeProperty("--back-progress");
      gesture = null;
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 1 || app.querySelector("dialog[open]"))
        return;
      const touch = event.touches[0]!;
      // iOS Safari owns the extreme edge. Also leave controls/text selection alone.
      if (
        touch.clientX < 24 ||
        touch.clientX > 64 ||
        (event.target as HTMLElement).closest(
          "button, input, textarea, select, a, pre",
        )
      )
        return;
      gesture = {
        x: touch.clientX,
        y: touch.clientY,
        start: performance.now(),
        distance: 0,
        active: false,
      };
    };
    const move = (event: TouchEvent) => {
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (!gesture.active && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        clear();
        return;
      }
      if (!gesture.active && dx > 12 && dx > Math.abs(dy) * 1.4)
        gesture.active = true;
      if (!gesture.active) return;
      event.preventDefault();
      gesture.distance = Math.max(0, dx);
      app.dataset.swiping = "true";
      app.style.setProperty(
        "--back-progress",
        String(Math.min(1, gesture.distance / app.clientWidth)),
      );
    };
    const end = () => {
      const completed =
        gesture?.active &&
        (gesture.distance > app.clientWidth * 0.33 ||
          (gesture.distance > 60 &&
            gesture.distance / Math.max(1, performance.now() - gesture.start) >
              0.5));
      clear();
      if (completed) onBack();
    };
    app.addEventListener("touchstart", start, { passive: true });
    app.addEventListener("touchmove", move, { passive: false });
    app.addEventListener("touchend", end);
    app.addEventListener("touchcancel", clear);
    return () => {
      clear();
      app.removeEventListener("touchstart", start);
      app.removeEventListener("touchmove", move);
      app.removeEventListener("touchend", end);
      app.removeEventListener("touchcancel", clear);
    };
  }, [root, mobile, listOpen, onBack]);
}
