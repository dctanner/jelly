import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent,
} from "react";
import { ChevronLeft, X } from "lucide-react";
import { observeViewport, visibleViewport } from "./viewport";

export function Modal({
  title,
  children,
  onClose,
  beforeClose,
  kind = "modal",
  className = "",
  dismissible = true,
  detent = "content",
  dirty = false,
  actions,
  onBack,
  backDiscards = false,
  cancelLabel,
  focusHeading = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  beforeClose?: () => Promise<boolean>;
  kind?: "modal" | "dropdown" | "panel";
  className?: string;
  dismissible?: boolean;
  detent?: "content" | "medium" | "large";
  dirty?: boolean;
  actions?: ReactNode;
  onBack?: () => void;
  backDiscards?: boolean;
  cancelLabel?: string;
  focusHeading?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closing = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null);
  const drag = useRef<{ y: number; time: number; delta: number } | null>(null);
  const lastTitle = useRef(title);
  const dragged = useRef(false);
  const discardFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current!;
    const prior = document.activeElement as HTMLElement;
    if (focusHeading) heading.current?.setAttribute("autofocus", "");
    el.showModal();
    if (focusHeading) heading.current?.focus({ preventScroll: true });
    void el.offsetWidth;
    el.classList.add("is-open");
    el.dataset.open = "true";
    const resize = () => {
      const viewport = visibleViewport();
      el.style.setProperty("--sheet-viewport-height", `${viewport.height}px`);
      el.style.setProperty("--sheet-viewport-width", `${viewport.width}px`);
      el.style.setProperty("--sheet-viewport-left", `${viewport.left}px`);
      el.style.setProperty("--sheet-viewport-top", `${viewport.top}px`);
      el.style.setProperty(
        "--sheet-keyboard-inset",
        `${Math.max(0, window.innerHeight - viewport.height - viewport.top)}px`,
      );
    };
    const unobserve = observeViewport(resize);
    return () => {
      clearTimeout(timer.current);
      unobserve();
      el.close();
      if (prior?.isConnected) prior.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (lastTitle.current === title) return;
    lastTitle.current = title;
    if (body.current) body.current.scrollTop = 0;
    heading.current?.focus({ preventScroll: true });
  }, [title]);
  async function finishClose() {
    if (closing.current || !dismissible) return;
    closing.current = true;
    if (beforeClose) {
      try {
        if (!(await beforeClose())) {
          closing.current = false;
          return;
        }
      } catch {
        closing.current = false;
        return;
      }
    }
    const el = ref.current;
    if (!el?.isConnected) return;
    el.classList.remove("is-open");
    el.classList.add("is-closing");
    el.dataset.open = "false";
    const mobile = window.matchMedia("(max-width: 767px)").matches;
    const duration = mobile
      ? 240
      : parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            `--${kind === "panel" ? "panel" : kind}-close-dur`,
          ),
        ) || 150;
    timer.current = setTimeout(onClose, duration);
  }
  function request(action: () => void = () => { void finishClose(); }, checkDirty = true) {
    if (!dismissible) return;
    if (checkDirty && dirty) {
      discardFocus.current = document.activeElement as HTMLElement;
      setDiscardAction(() => action);
    } else action();
  }
  function keepEditing() {
    setDiscardAction(null);
    window.requestAnimationFrame(() => {
      if (discardFocus.current?.isConnected)
        discardFocus.current.focus({ preventScroll: true });
    });
  }
  function startDrag(event: PointerEvent<HTMLElement>) {
    if (
      !window.matchMedia("(max-width: 767px)").matches ||
      !dismissible ||
      discardAction
    )
      return;
    if ((event.target as HTMLElement).closest("button:not(.sheet-grabber)"))
      return;
    dragged.current = false;
    drag.current = { y: event.clientY, time: performance.now(), delta: 0 };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function moveDrag(event: PointerEvent<HTMLElement>) {
    if (!drag.current) return;
    drag.current.delta = event.clientY - drag.current.y;
    ref.current!.dataset.dragging = "true";
    ref.current!.style.setProperty(
      "--sheet-drag",
      `${Math.max(0, drag.current.delta)}px`,
    );
  }
  function endDrag(cancelled = false) {
    const gesture = drag.current;
    if (!gesture) return;
    drag.current = null;
    delete ref.current!.dataset.dragging;
    ref.current!.style.removeProperty("--sheet-drag");
    if (cancelled) return;
    dragged.current = Math.abs(gesture.delta) >= 6;
    if (!dragged.current) return;
    if (gesture.delta < -40) setExpanded(true);
    else if (
      gesture.delta > 100 ||
      (gesture.delta > 35 &&
        gesture.delta / Math.max(1, performance.now() - gesture.time) > 0.55)
    ) {
      if (expanded && detent === "medium") setExpanded(false);
      else request();
    }
  }
  return (
    <dialog
      ref={ref}
      className={`${kind === "panel" ? "t-panel-slide" : `t-${kind}`} native-sheet ${className}`}
      data-detent={detent}
      data-expanded={expanded}
      data-origin="top-left"
      onCancel={(event) => {
        event.preventDefault();
        if (discardAction) keepEditing();
        else request();
      }}
      aria-label={title}
      onClick={(event) => {
        if (event.target !== ref.current) return;
        const r = ref.current.getBoundingClientRect();
        if (
          event.clientX < r.left ||
          event.clientX > r.right ||
          event.clientY < r.top ||
          event.clientY > r.bottom
        )
          request();
      }}
    >
      <div
        className="sheet-handle"
        inert={!!discardAction}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={() => endDrag()}
        onPointerCancel={() => endDrag(true)}
      >
        <button
          type="button"
          className="sheet-grabber"
          aria-label={expanded ? "Collapse sheet" : "Expand sheet"}
          aria-expanded={expanded}
          onClick={(event) => {
            if (event.detail === 0 || !dragged.current) setExpanded(!expanded);
            dragged.current = false;
          }}
        >
          <span />
        </button>
      </div>
      <div
        className="modal-heading"
        inert={!!discardAction}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={() => endDrag()}
        onPointerCancel={() => endDrag(true)}
      >
        {onBack ? (
          <button
            type="button"
            className="sheet-nav"
            aria-label="Back"
            onClick={() => request(onBack, backDiscards)}
          >
            <ChevronLeft size={20} />
            Back
          </button>
        ) : cancelLabel ? (
          <button
            type="button"
            className="sheet-nav"
            onClick={() => request()}
            disabled={!dismissible}
          >
            {cancelLabel}
          </button>
        ) : (
          <span />
        )}
        <h2 ref={heading} tabIndex={-1}>
          {title}
        </h2>
        {actions ??
          (cancelLabel && !onBack ? (
            <span aria-hidden="true" />
          ) : (
            <button
              type="button"
              className="icon"
              aria-label="Close dialog"
              onClick={() => request()}
              disabled={!dismissible}
            >
              <X size={20} />
            </button>
          ))}
      </div>
      <div
        className="modal-body sheet-page"
        inert={!!discardAction}
        ref={body}
        key={title}
      >
        {children}
      </div>
      {discardAction && (
        <div
          className="sheet-discard"
          role="alertdialog"
          aria-label="Discard changes?"
          aria-modal="true"
        >
          <strong>Discard changes?</strong>
          <p>Your unsaved changes will be lost.</p>
          <button
            type="button"
            className="primary"
            autoFocus
            onClick={keepEditing}
          >
            Keep editing
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              const action = discardAction;
              setDiscardAction(null);
              action();
            }}
          >
            Discard changes
          </button>
        </div>
      )}
    </dialog>
  );
}
