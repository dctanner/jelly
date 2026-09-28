import { useLayoutEffect, type RefObject } from "react";

/** Keep programmatic focus for accessibility without touch-only focus rings. */
export function useInputModality(root: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const app = root.current;
    if (!app) return;
    app.dataset.inputModality = "pointer";
    const pointer = () => {
      app.dataset.inputModality = "pointer";
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.metaKey || event.altKey || event.ctrlKey) return;
      if (
        ["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
          event.key,
        )
      )
        app.dataset.inputModality = "keyboard";
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", keyboard, true);
      delete app.dataset.inputModality;
    };
  }, [root]);
}
