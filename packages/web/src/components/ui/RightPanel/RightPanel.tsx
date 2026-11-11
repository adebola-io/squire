import { Cell, For, If, onConnected, type SourceCell } from "retend";
import { JSX } from "retend/jsx-runtime";
import { FadeScroll, Icon } from "squire-ui";

import { LoadingState } from "@/components/ui/LoadingState";
import { errorMessage } from "@/utils/misc";

import classes from "./RightPanel.module.css";

/**
 * Wait for panel CSS animations and transitions. Abort obsolete waits when the selection
 * changes.
 */
function waitForPanelMotion(element: HTMLElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let frame = 0;
    const done = () => {
      cancelAnimationFrame(frame);
      signal.removeEventListener("abort", done);
      resolve();
    };
    if (signal.aborted) {
      done();
      return;
    }
    signal.addEventListener("abort", done, { once: true });
    frame = requestAnimationFrame(() => {
      if (signal.aborted || !element.isConnected) {
        done();
        return;
      }
      // Apply `data-open` before querying active animations.
      void getComputedStyle(element).width;
      const surface = element.querySelector("[data-right-panel-surface]");
      const animations = [element, surface]
        .flatMap((node) => node?.getAnimations() ?? [])
        .filter((animation) => animation.playState === "running");
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(done);
    });
  });
}

interface RightPanelProps {
  children: JSX.Children;
  open: Cell<boolean>;
  title: Cell<string>;
  onClose: () => void;
  element: SourceCell<HTMLDialogElement | null>;
}

export function RightPanel(props: RightPanelProps) {
  const { children, open, title, onClose, element } = props;
  const width = Cell.source("var(--squire-right-panel-width)");
  // Update width directly during dragging.
  const resizing = Cell.source(false);

  const onCancel = (event: Event) => {
    event.preventDefault();
    onClose();
  };

  const startResize = (event: PointerEvent) => {
    const handle = event.currentTarget as HTMLElement;
    const panel = handle.parentElement as HTMLElement;
    const right = panel.getBoundingClientRect().right;
    resizing.set(true);
    const move = (event: PointerEvent) => {
      width.set(`${Math.min(Math.max(right - event.clientX, 360), 720)}px`);
    };
    const stop = () => {
      resizing.set(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  onConnected(element, (dialog) => {
    const mobile = window.matchMedia("(max-width: 48rem)");
    const controller = new AbortController();
    const sync = () => {
      if (mobile.matches) {
        if (open.get()) {
          if (!dialog.matches(":modal")) {
            if (dialog.open) dialog.close();
            dialog.showModal();
          }
        } else if (dialog.open) {
          // Keep the sheet in the top layer until its closing animation finishes.
          void waitForPanelMotion(dialog, controller.signal).then(() => {
            if (!controller.signal.aborted && !open.get() && dialog.open) dialog.close();
          });
        }
      } else if (!dialog.open || dialog.matches(":modal")) {
        if (dialog.open) dialog.close();
        dialog.show();
      }
    };
    sync();
    mobile.addEventListener("change", sync);
    const stopWatching = open.listen(sync);
    return () => {
      controller.abort();
      mobile.removeEventListener("change", sync);
      stopWatching();
    };
  });

  // Animate the outer layout width while keeping the inner surface at a fixed width.
  return (
    <dialog
      ref={element}
      class={classes.rightPanel}
      aria-label={title}
      onCancel={onCancel}
      data-right-panel
      data-open={open}
      data-resizing={resizing}
      style={{ "--right-panel-width": width }}
    >
      <div class={classes.rightPanelSurface} data-right-panel-surface>
        <div class={classes.rightPanelResizeHandle} onPointerDown={startResize} />
        <div class={classes.rightPanelHeader}>
          <button
            type="button"
            class={classes.rightPanelBackBtn}
            onClick={onClose}
            aria-label="Back to conversation"
          >
            <Icon name="arrow" aria-hidden="true" />
          </button>
          <span class={classes.rightPanelTitle}>{title}</span>
          <button
            type="button"
            class={classes.rightPanelCloseBtn}
            onClick={onClose}
            title="Close panel"
            aria-label="Close panel"
          >
            <Icon name="cancel" aria-hidden="true" />
          </button>
        </div>
        <FadeScroll class={classes.rightPanelContent}>{children}</FadeScroll>
      </div>
    </dialog>
  );
}

/** Identity of the prepared content, independent of its DOM. */
export interface PanelContent {
  key: string;
  title: string;
  prepare: (signal: AbortSignal) => Promise<unknown>;
  render: (prepared: unknown) => JSX.Template;
}

/** Bind the prepared data type to its renderer. */
export function preparedPanel<T>(
  key: string,
  prepare: (signal: AbortSignal) => Promise<T>,
  render: (prepared: T) => JSX.Template,
  title = "Tool details",
): PanelContent {
  return { key, title, prepare, render: (prepared) => render(prepared as T) };
}

interface SidePanelProps {
  /** Selected panel content; null when closed. */
  content: Cell<PanelContent | null>;
  onClose: () => void;
}

/**
 * Open the panel before preparing its content. Keep the previous body until replacement content
 * is ready or the closing animation finishes.
 */
export function SidePanel(props: SidePanelProps) {
  const { content, onClose } = props;
  const element = Cell.source<HTMLDialogElement | null>(null);
  const animationReady = Cell.source(false);
  const shownKey = Cell.source<string | null>(null);
  const selectedKey = Cell.derived(() => content.get()?.key ?? null);
  const selectedTitle = Cell.derived(() => content.get()?.title ?? "Tool details");
  const isOpen = Cell.derived(() => selectedKey.get() !== null);

  const present = Cell.derivedAsync(async (get, signal) => {
    if (get(isOpen)) return true;
    const panel = get(element);
    if (panel !== null) await waitForPanelMotion(panel, signal);
    return false;
  });

  const slots = Cell.derivedAsync(async (get) => ((await get(present)) ? [{ key: "panel" }] : []));

  const bodies = Cell.derivedAsync(async (get, signal) => {
    const key = get(selectedKey);
    if (key === null) {
      animationReady.set(false);
      // Preserve the last body for the entire closing animation.
      await get(present);
      if (!signal.aborted) shownKey.set(null);
      return [];
    }
    const panel = get(element);
    if (panel === null) return [];

    // Start expensive preparation after the opening animation finishes.
    await waitForPanelMotion(panel, signal);
    if (signal.aborted) return [];
    animationReady.set(true);
    const current = content.peek();
    if (current?.key !== key) return [];
    try {
      const data = await current.prepare(signal);
      if (signal.aborted) return [];
      shownKey.set(key);
      return [{ key, render: () => current.render(data) }];
    } catch (error) {
      if (signal.aborted) return [];
      const message = errorMessage(error);
      shownKey.set(key);
      return [
        {
          key,
          render: () => (
            <LoadingState
              region
              label="Could not load panel details"
              error={Cell.source<string | null>(message)}
              onRetry={() => bodies.revalidate()}
            />
          ),
        },
      ];
    }
  });
  const showLoading = Cell.derived(
    () => isOpen.get() && animationReady.get() && shownKey.get() === null && bodies.pending.get(),
  );
  const switching = Cell.derived(
    () =>
      shownKey.get() !== null && selectedKey.get() !== null && shownKey.get() !== selectedKey.get(),
  );

  return For(
    slots,
    () => (
      <RightPanel element={element} open={isOpen} title={selectedTitle} onClose={onClose}>
        {If(showLoading, () => (
          <LoadingState region label="Loading details…" />
        ))}
        {For(
          bodies,
          (body) => (
            <div class={classes.rightPanelBody} inert={switching}>
              {body.render()}
            </div>
          ),
          { key: "key" },
        )}
      </RightPanel>
    ),
    { key: "key" },
  );
}
