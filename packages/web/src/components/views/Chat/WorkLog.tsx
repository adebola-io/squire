import { Cell, For, If, onConnected } from "retend";
import { useIntersectionObserver } from "retend-utils/hooks";
import { FadeScroll } from "squire-ui";

import { attachLogMotion } from "./workLogMotion";
import type { InlineWorkState, LogEntry } from "./workLogState";
import { LogStepItem } from "./WorkLogStep";

import classes from "./WorkLog.module.css";

interface InlineWorkProps {
  work: InlineWorkState;
  open: Cell<boolean>;
}

interface LogSlotProps {
  initial: LogEntry;
  index: Cell<number>;
  entries: Cell<LogEntry[]>;
  loadingEarlier: Cell<boolean>;
  onShowEarlier: () => void;
}

/** Preserve tool rows across status and duration updates. */
function LogSlot(props: LogSlotProps) {
  const { initial, index, entries, loadingEarlier, onShowEarlier } = props;
  const current = Cell.derived(() => {
    const next = entries.get()[index.get()];
    return next?.key === initial.key ? next : initial;
  });
  return (
    <LogStepItem entry={current} loadingEarlier={loadingEarlier} onShowEarlier={onShowEarlier} />
  );
}

/** Collapsible execution log. */
export function InlineWork(props: InlineWorkProps) {
  const { work, open } = props;
  const { entries, executing, showEarlier, loadingEarlier } = work;
  // Latch: the log stays mounted after its first open so the disclosure can animate shut.
  const everOpened = Cell.source(open.get());
  const scrollerRef = Cell.source<HTMLElement | null>(null);
  const sentinelRef = Cell.source<HTMLElement | null>(null);
  const listRef = Cell.source<HTMLElement | null>(null);
  const snappable = Cell.source(true);
  const hidden = Cell.derived(() => !open.get());
  const snap = Cell.derived(() => String(snappable.get()));

  open.listen((expanded) => {
    if (expanded) everOpened.set(true);
  });

  onConnected(scrollerRef, (scroller) => {
    requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight;
    });
  });

  // New steps rise in; while following the end, earlier steps glide up to make room.
  onConnected(listRef, (list) => {
    const scroller = scrollerRef.get() ?? list.closest<HTMLElement>(`.${classes.logScroll}`);
    if (scroller === null) return;
    return attachLogMotion({
      scroller,
      list,
      following: () => snappable.get(),
      visible: () => open.get(),
    });
  });

  useIntersectionObserver(
    sentinelRef,
    ([entry]) => {
      snappable.set(entry.isIntersecting);
    },
    () => ({ root: scrollerRef.get(), threshold: 0 }),
  );

  return (
    <section class={classes.inlineWork}>
      <div class={classes.logDisclosure} data-open={open}>
        <div class={classes.logDisclosureInner} inert={hidden}>
          {If(everOpened, () => (
            <FadeScroll ref={scrollerRef} class={classes.logScroll} data-snap={snap}>
              <div class={classes.logContent}>
                <ol
                  ref={listRef}
                  class={classes.steps}
                  data-executing={executing}
                  aria-label="Execution log"
                >
                  {For(
                    entries,
                    (entry, index) => (
                      <LogSlot
                        initial={entry}
                        index={index}
                        entries={entries}
                        loadingEarlier={loadingEarlier}
                        onShowEarlier={showEarlier}
                      />
                    ),
                    { key: "key" },
                  )}
                </ol>
              </div>
              <div ref={sentinelRef} class={classes.logSentinel} />
            </FadeScroll>
          ))}
        </div>
      </div>
    </section>
  );
}
