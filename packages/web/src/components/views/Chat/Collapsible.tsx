import { Cell, If } from "retend";
import { useResizeObserver } from "retend-utils/hooks";
import type { JSX } from "retend/jsx-runtime";

import classes from "./Chat.module.css";

interface CollapsibleProps {
  children: JSX.Children;
}

/**
 * Clamp long messages to `--chat-collapse-height` and show the expansion control only on
 * overflow. Resize observations run after layout and before paint, so the control is already in
 * place on the first frame.
 */
export function Collapsible(props: CollapsibleProps) {
  const { children } = props;
  const bodyRef = Cell.source<HTMLElement | null>(null);
  const contentRef = Cell.source<HTMLElement | null>(null);
  const expanded = Cell.source(false);
  const overflows = Cell.source(false);
  const collapsed = Cell.derived(() => {
    return !expanded.get();
  });
  const toggleLabel = Cell.derived(() => {
    if (expanded.get()) {
      return "Show less";
    }
    return "Show more";
  });

  const toggle = () => {
    expanded.set(!expanded.get());
  };

  // Compare full content height with the clipped body. Retain the result while expanded so the
  // collapse control remains available.
  useResizeObserver([contentRef, bodyRef], () => {
    const content = contentRef.get();
    const body = bodyRef.get();
    if (content !== null && body !== null && !expanded.get()) {
      overflows.set(content.offsetHeight > body.clientHeight + 1);
    }
  });

  return (
    <div class={classes.collapsible}>
      <div
        ref={bodyRef}
        class={classes.collapsibleBody}
        data-collapsed={collapsed}
        data-overflows={overflows}
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {If(overflows, () => {
        return (
          <button type="button" class={classes.showMore} onClick={toggle} aria-expanded={expanded}>
            {toggleLabel}
          </button>
        );
      })}
    </div>
  );
}
