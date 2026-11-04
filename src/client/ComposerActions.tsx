import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Paperclip, Plus, Target } from "lucide-react";
import { GoalsPanel } from "./Goals";
import { useAnchoredPopover } from "./useAnchoredPopover";
import "./ComposerActions.css";

/** Keep the composer trigger mounted so both dialogs can restore focus to it. */
export function ComposerActions({
  agentId,
  disabled,
  onAddFile,
}: {
  agentId?: string;
  disabled: boolean;
  onAddFile: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const firstFocus = useRef<"first" | "last">("first");
  const id = useId();
  const unavailable = disabled || !agentId;
  useAnchoredPopover(open, trigger, panel, "above", "start");
  const items = () => [
    ...(panel.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]',
    ) ?? []),
  ];
  function close(restore = false) {
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  }
  function choose(action: () => void) {
    close(true);
    if (!unavailable) action();
  }
  useEffect(() => {
    if (unavailable) setOpen(false);
  }, [unavailable]);
  useEffect(() => {
    if (!open) return;
    const buttons = items();
    (firstFocus.current === "last" ? buttons.at(-1) : buttons[0])?.focus({
      preventScroll: true,
    });
    const outside = (event: PointerEvent) => {
      if (
        !root.current?.contains(event.target as Node) &&
        !panel.current?.contains(event.target as Node)
      )
        close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function navigate(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === "Tab") {
      // Native tab order should continue from the trigger, not the body portal.
      close(true);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = items();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length;
    buttons[next]?.focus({ preventScroll: true });
  }
  return (
    <div
      className="composer-actions"
      ref={root}
      onKeyDown={navigate}
      onBlur={(event) => {
        if (
          !root.current?.contains(event.relatedTarget as Node | null) &&
          !panel.current?.contains(event.relatedTarget as Node | null)
        )
          close();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="icon composer-upload"
        aria-label="Add to chat"
        title="Add to chat"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={unavailable}
        onClick={() => {
          firstFocus.current = "first";
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (!open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            firstFocus.current = event.key === "ArrowUp" ? "last" : "first";
            setOpen(true);
          }
        }}
      >
        <Plus size={20} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="menu"
            aria-label="Add to chat"
            className="composer-actions-menu floating-popover"
          >
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => choose(onAddFile)}
            >
              <Paperclip size={18} aria-hidden="true" />
              <span>Add File</span>
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => choose(() => setGoalOpen(true))}
            >
              <Target size={18} aria-hidden="true" />
              <span>Goal</span>
            </button>
          </div>,
          document.body,
        )}
      {goalOpen &&
        agentId &&
        createPortal(
          // React events cross portals: goal form submission must not send chat.
          <div onSubmit={(event) => event.stopPropagation()}>
            <GoalsPanel agentId={agentId} onClose={() => setGoalOpen(false)} />
          </div>,
          document.body,
        )}
    </div>
  );
}
