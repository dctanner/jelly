import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  Archive,
  Menu,
  Moon,
  Settings2,
  Sun,
  Search,
  FolderPlus,
  FolderCog,
  UserPlus,
} from "lucide-react";

export function AgentListMenu({
  disabled,
  archivedDisabled,
  visible,
  dark,
  onSearch,
  onNewProject,
  onManageProject,
  onAddAgent,
  onArchived,
  onSettings,
  onToggleTheme,
}: {
  disabled: boolean;
  archivedDisabled: boolean;
  visible: boolean;
  dark: boolean;
  onSearch: () => void;
  onNewProject: () => void;
  onManageProject?: () => void;
  onAddAgent?: () => void;
  onArchived: () => void;
  onSettings: () => void;
  onToggleTheme: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstFocus = useRef<"first" | "last">("first");
  const tabbing = useRef(false);
  const id = useId();
  const items = () => [
    ...(root.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    ) ?? []),
  ];
  function focusItem(button: HTMLButtonElement | undefined) {
    if (!button) return;
    // Scroll only the popup, never the horizontally translated page stack.
    button.focus({ preventScroll: true });
    const panel = button.parentElement!;
    if (button.offsetTop < panel.scrollTop) panel.scrollTop = button.offsetTop;
    else if (
      button.offsetTop + button.offsetHeight >
      panel.scrollTop + panel.clientHeight
    )
      panel.scrollTop =
        button.offsetTop + button.offsetHeight - panel.clientHeight;
  }
  function close(restore = false) {
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  }
  function choose(action: () => void) {
    // A modal opened by this action should restore focus to the persistent
    // trigger, not to an item that disappears with the popup.
    close(true);
    action();
  }
  useEffect(() => {
    if (!visible || disabled) setOpen(false);
  }, [visible, disabled]);
  useEffect(() => {
    if (!open) return;
    tabbing.current = false;
    const buttons = items();
    focusItem(firstFocus.current === "last" ? buttons.at(-1) : buttons[0]);
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function navigate(event: KeyboardEvent) {
    if (open && event.key === "Tab") tabbing.current = true;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (!open || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
      return;
    event.preventDefault();
    const buttons = items();
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length;
    focusItem(buttons[next]);
  }
  return (
    <div
      className="agent-list-menu"
      ref={root}
      onKeyDown={navigate}
      onPointerDownCapture={() => {
        tabbing.current = false;
      }}
      onBlur={(event) => {
        if (
          tabbing.current ||
          !event.currentTarget.contains(event.relatedTarget as Node | null)
        )
          setOpen(false);
        tabbing.current = false;
      }}
    >
      <button
        type="button"
        className="icon agent-menu-trigger"
        ref={trigger}
        aria-label="Agent list menu"
        title="Agent list menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
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
        <Menu size={24} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="agent-list-menu-panel"
          role="menu"
          aria-label="Agent list options"
          id={id}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => choose(onSearch)}
          >
            <span>Search</span>
            <Search size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={archivedDisabled}
            onClick={() => choose(onNewProject)}
          >
            <span>New project</span>
            <FolderPlus size={18} aria-hidden="true" />
          </button>
          {onManageProject && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => choose(onManageProject)}
            >
              <span>Manage project</span>
              <FolderCog size={18} aria-hidden="true" />
            </button>
          )}
          {onAddAgent && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={archivedDisabled}
              onClick={() => choose(onAddAgent)}
            >
              <span>Add existing agent</span>
              <UserPlus size={18} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={archivedDisabled}
            onClick={() => choose(onArchived)}
          >
            <span>Archived agents</span>
            <Archive size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => choose(onSettings)}
          >
            <span>Settings</span>
            <Settings2 size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-label={`Switch to ${dark ? "light" : "dark"} mode`}
            onClick={() => choose(onToggleTheme)}
          >
            <span>{dark ? "Light mode" : "Dark mode"}</span>
            {dark ? (
              <Sun size={18} aria-hidden="true" />
            ) : (
              <Moon size={18} aria-hidden="true" />
            )}
          </button>
        </div>
      )}
    </div>
  );
}
