import { Cell, If, onConnected } from "retend";
import { Teleport } from "retend-web";
import type { JSX } from "retend/jsx-runtime";
import { Icon } from "squire-ui";

import classes from "./Chat.module.css";

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;
const EDGE_PADDING = 8;

interface Point {
  x: number;
  y: number;
}
interface Press extends Point {
  id: number;
}

interface HistoryRowMenuProps {
  /** Row content that opens the actions menu on right-click, long-press, or Shift+F10. */
  children: JSX.Children;
  /** "Actions for <chat title>". */
  title: Cell<string>;
  /** Whether deletion is pending. */
  pending: Cell<boolean>;
  error: Cell<Error | null>;
  onRename: () => void;
  onDelete: () => void;
}

function useHistoryMenu() {
  const row = Cell.source<HTMLDivElement | null>(null);
  const content = Cell.source<HTMLDivElement | null>(null);
  const open = Cell.source(false);
  let portalTarget = "body";
  let point: Point = { x: 0, y: 0 };
  let press: Press | null = null;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let suppressClick = false;

  const stopPress = () => {
    clearTimeout(pressTimer);
    pressTimer = undefined;
    press = null;
  };
  const close = () => open.set(false);
  const openAt = (x: number, y: number) => {
    const sidebar = document.getElementById("squire-navigation");
    portalTarget = sidebar?.matches(":modal") ? "#squire-navigation" : "body";
    point = { x, y };
    open.set(true);
  };
  const openAtRow = () => {
    const rect = row.peek()?.getBoundingClientRect();
    if (rect) openAt(rect.left, rect.bottom);
  };
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    stopPress();
    if (event.clientX || event.clientY) openAt(event.clientX, event.clientY);
    else openAtRow();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    openAtRow();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" || !event.isPrimary) return;
    stopPress();
    suppressClick = false;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY };
    pressTimer = setTimeout(() => {
      const start = press;
      if (!start) return;
      suppressClick = true;
      openAt(start.x, start.y);
      pressTimer = undefined;
    }, LONG_PRESS_MS);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!press || press.id !== event.pointerId) return;
    if (
      Math.abs(event.clientX - press.x) > LONG_PRESS_SLOP ||
      Math.abs(event.clientY - press.y) > LONG_PRESS_SLOP
    )
      stopPress();
  };
  const onPointerUp = (event: PointerEvent) => {
    if (press?.id !== event.pointerId) return;
    stopPress();
    if (suppressClick) event.preventDefault();
  };
  const onPointerCancel = () => stopPress();

  const handleMenuKeys = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      row.peek()?.querySelector<HTMLElement>("a")?.focus();
      return;
    }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      content.peek()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  onConnected(row, (element) => {
    // A completed long-press must not activate the link under the menu.
    const interceptClick = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    element.addEventListener("click", interceptClick, true);
    return () => {
      stopPress();
      element.removeEventListener("click", interceptClick, true);
    };
  });
  onConnected(content, (menu) => {
    const view = menu.ownerDocument.defaultView!;
    menu.style.left = `${Math.min(Math.max(point.x, EDGE_PADDING), Math.max(EDGE_PADDING, view.innerWidth - menu.offsetWidth - EDGE_PADDING))}px`;
    menu.style.top = `${Math.min(Math.max(point.y, EDGE_PADDING), Math.max(EDGE_PADDING, view.innerHeight - menu.offsetHeight - EDGE_PADDING))}px`;
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState === "closed") close();
    };
    menu.addEventListener("toggle", onToggle);
    menu.showPopover();
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => menu.removeEventListener("toggle", onToggle);
  });

  return {
    row,
    content,
    open,
    getPortalTarget: () => portalTarget,
    close,
    onContextMenu,
    onKeyDown,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    handleMenuKeys,
  };
}

/** Context menu kept in the mobile sidebar's top-layer dialog, not behind it. */
export function HistoryRowMenu(props: HistoryRowMenuProps) {
  const { children, title, pending, error, onRename, onDelete } = props;
  const menu = useHistoryMenu();
  return (
    <>
      <div
        ref={menu.row}
        class={classes.historyMenuTrigger}
        onContextMenu={menu.onContextMenu}
        onKeyDown={menu.onKeyDown}
        onPointerDown={menu.onPointerDown}
        onPointerMove={menu.onPointerMove}
        onPointerUp={menu.onPointerUp}
        onPointerCancel={menu.onPointerCancel}
      >
        {children}
      </div>
      {If(menu.open, () => (
        <Teleport to={menu.getPortalTarget()}>
          <div
            ref={menu.content}
            popover="auto"
            role="menu"
            aria-label={title}
            class={classes.historyActionsMenu}
            onKeyDown={menu.handleMenuKeys}
          >
            <button
              type="button"
              role="menuitem"
              class={classes.historyMenuItem}
              onClick={() => {
                menu.close();
                onRename();
              }}
            >
              <Icon name="edit" aria-hidden="true" />
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              class={classes.historyMenuItem}
              data-tone="danger"
              disabled={pending}
              onClick={() => {
                menu.close();
                onDelete();
              }}
            >
              <Icon name="trash" aria-hidden="true" />
              Delete chat
            </button>
            {If(error, (failure) => (
              <p class={classes.historyMenuError} role="alert" title={failure.message}>
                {failure.message}
              </p>
            ))}
          </div>
        </Teleport>
      ))}
    </>
  );
}
