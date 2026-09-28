import { useLayoutEffect, type RefObject } from "react";

/** iOS leaves vh/dvh at full screen height when its keyboard opens. */
export function useKeyboardViewport(
  ref: RefObject<HTMLDivElement | null>,
  conversation: RefObject<HTMLDivElement | null>,
) {
  useLayoutEffect(() => {
    const app = ref.current;
    const viewport = window.visualViewport;
    if (!app || !viewport) return;
    const mobile = window.matchMedia("(max-width: 767px)");
    let keyboardOpen = false;
    let anchorFrame: number | undefined;
    let anchoredChat: HTMLDivElement | null = null;
    const pinBottom = (chat: HTMLDivElement) => {
      // Scroll the chat only, never the document (scrollIntoView can pan iOS).
      chat.scrollTo({ top: chat.scrollHeight, behavior: "instant" });
    };
    const reset = () => {
      delete app.dataset.keyboardOpen;
      app.style.removeProperty("--keyboard-viewport-height");
      app.style.removeProperty("--keyboard-viewport-top");
    };
    const update = () => {
      const chat = conversation.current;
      // Measure before changing the app height. After the viewport shrinks, a
      // chat that WAS at the bottom would otherwise look scrolled up.
      const followBottom =
        chat &&
        (chat === anchoredChat ||
          chat.scrollHeight - chat.clientHeight - chat.scrollTop <= 48);
      const wasKeyboardOpen = keyboardOpen;
      const focused = document.activeElement;
      const editing =
        !!focused &&
        app.contains(focused) &&
        focused.matches('input, textarea, [contenteditable="true"]');
      const layoutHeight = Math.max(
        window.innerHeight,
        document.documentElement.clientHeight,
      );
      // Ignore pinch zoom and browser chrome changes. Keep tracking through blur
      // until the keyboard finishes closing; iOS may also pan the viewport.
      keyboardOpen =
        mobile.matches &&
        Math.abs(viewport.scale - 1) < 0.01 &&
        (editing || keyboardOpen) &&
        layoutHeight - viewport.height > 80;
      if (!keyboardOpen) {
        reset();
      } else {
        app.dataset.keyboardOpen = "true";
        app.style.setProperty(
          "--keyboard-viewport-height",
          `${viewport.height}px`,
        );
        app.style.setProperty(
          "--keyboard-viewport-top",
          `${viewport.offsetTop}px`,
        );
      }
      if (followBottom && (keyboardOpen || wasKeyboardOpen)) {
        if (anchorFrame !== undefined) window.cancelAnimationFrame(anchorFrame);
        anchoredChat = chat;
        pinBottom(chat);
        // Re-pin after the composer ResizeObserver has adjusted textarea height
        // and chat padding. Instant scrolling keeps pace with keyboard animation.
        anchorFrame = window.requestAnimationFrame(() => {
          if (conversation.current === chat) pinBottom(chat);
          anchorFrame = window.requestAnimationFrame(() => {
            if (conversation.current === chat) pinBottom(chat);
            anchoredChat = null;
            anchorFrame = undefined;
          });
        });
      }
    };
    const releaseAnchor = () => {
      // A deliberate gesture takes priority over a pending layout correction.
      if (anchorFrame !== undefined) window.cancelAnimationFrame(anchorFrame);
      anchorFrame = undefined;
      anchoredChat = null;
    };
    app.addEventListener("touchmove", releaseAnchor, { passive: true });
    app.addEventListener("wheel", releaseAnchor, { passive: true });
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    mobile.addEventListener("change", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      mobile.removeEventListener("change", update);
      app.removeEventListener("touchmove", releaseAnchor);
      app.removeEventListener("wheel", releaseAnchor);
      releaseAnchor();
      reset();
    };
  }, [ref, conversation]);
}
