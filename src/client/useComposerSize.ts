import { useLayoutEffect, type RefObject } from "react";
import { observeViewport, visibleViewport } from "./viewport";

export function composerBudget(
  mainHeight: number,
  viewportHeight: number,
  reserved: number,
) {
  return Math.max(0, mainHeight - reserved - viewportHeight / 4);
}

export function useComposerSize(
  ref: RefObject<HTMLTextAreaElement | null>,
  draft: string,
  agentId: string | undefined,
  notice: unknown,
  connected: unknown,
  archived: boolean,
) {
  useLayoutEffect(() => {
    const input = ref.current;
    const main = input?.closest("main");
    const wrap = input?.closest<HTMLElement>(".composer-wrap");
    if (!input || !main || !wrap) return;
    const set = (element: HTMLElement, property: string, value: string) => {
      if (element.style.getPropertyValue(property) !== value)
        element.style.setProperty(property, value);
    };
    const resize = () => {
      const composerHeight = wrap.getBoundingClientRect().height;
      set(main, "--composer-height", `${composerHeight}px`);
      const conversation = main.querySelector<HTMLElement>(".conversation");
      const mainTop = main.getBoundingClientRect().top;
      const headerBottom =
        main.querySelector(".conversation-header")?.getBoundingClientRect()
          .bottom ?? mainTop;
      const style = conversation ? getComputedStyle(conversation) : null;
      // The conversation's offset includes flow banners and their margins.
      // Count its bottom gap, but not the composer inset, exactly once.
      const reserved =
        Math.max(
          headerBottom - mainTop,
          (conversation?.getBoundingClientRect().top ?? mainTop) -
            mainTop +
            (parseFloat(style?.paddingTop || "0") || 0),
        ) +
        Math.max(
          0,
          (parseFloat(style?.paddingBottom || "0") || 0) - composerHeight,
        );
      // Main is already resized by useKeyboardViewport. Don't interpret a
      // deliberate pinch zoom as a request to resize the user's draft.
      const viewportHeight =
        Math.abs((window.visualViewport?.scale ?? 1) - 1) < 0.01
          ? Math.min(main.clientHeight, visibleViewport().height)
          : main.clientHeight;
      const budget = composerBudget(
        main.clientHeight,
        viewportHeight,
        reserved,
      );
      set(wrap, "max-height", `${budget}px`);
      // scrollHeight still includes notices/toolbar when the wrapper is capped.
      const chrome = Math.max(
        0,
        wrap.scrollHeight - input.getBoundingClientRect().height,
      );
      const available = Math.max(44, budget - chrome);
      set(input, "height", "44px");
      const height = Math.min(available, Math.max(44, input.scrollHeight));
      set(input, "height", `${height}px`);
      set(input, "overflow-y", input.scrollHeight > height ? "auto" : "hidden");
      wrap.dataset.constrained = String(wrap.scrollHeight > budget + 1);
      set(
        main,
        "--composer-height",
        `${wrap.getBoundingClientRect().height}px`,
      );
    };
    const unobserve = observeViewport(resize);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(main);
    observer?.observe(wrap);
    for (const child of main.children) observer?.observe(child);
    // A capped wrapper may not resize when its notices or toolbar change.
    for (const child of wrap.querySelectorAll<HTMLElement>(
      ":scope > *, .composer-footer",
    ))
      observer?.observe(child);
    return () => {
      unobserve();
      observer?.disconnect();
    };
  }, [ref, draft, agentId, notice, connected, archived]);
}
