/**
 * Motion for the work log. While the reader follows the end, any change that would move the
 * steps on screen (a new step, streaming reasoning growing its row, a tool row gaining its
 * second line, a step being replaced) glides from the old position instead of jumping. Steps
 * that have never been on screen before rise in. Prepended pages ("Show earlier") and
 * collapsed logs update without motion.
 */

/** How long steps take to glide into their new place. */
const GLIDE_MS = 320;
/** How long a new step takes to fade and rise in. */
const ENTER_MS = 260;
/** Delay between steps that arrive in the same update. */
const STAGGER_MS = 60;
/** Extra distance a new step rises on top of the glide. */
const ENTER_OFFSET_PX = 6;
/** Movements smaller than this land without a glide. */
const MIN_GLIDE_PX = 0.5;
/**
 * After the log appears or the window returns, late layout (the first scroll to the end,
 * reasoning text loading, the transcript revealing) settles at the end without motion.
 */
const SETTLE_MS = 800;
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

interface LogMotionOptions {
  scroller: HTMLElement;
  /** The step list; it must be positioned so step offsets are measured against it. */
  list: HTMLElement;
  /** Whether the reader was following the end of the log before the change. */
  following: () => boolean;
  /** Whether the log is open; a collapsed log updates without motion. */
  visible: () => boolean;
}

/** Read how far a running glide has got, so the next change continues from there. */
function currentOffset(list: HTMLElement) {
  const { transform } = getComputedStyle(list);
  return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
}

export function attachLogMotion(options: LogMotionOptions) {
  const { scroller, list, following, visible } = options;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  // Steps that have been laid out before; a row the list re-attaches is not new.
  const seen = new WeakSet<Element>();
  // Offsets within the list from the last settled layout. They ignore transforms and scrolling,
  // and nothing outside the log changes them.
  const tops = new WeakMap<Element, number>();
  let scrollTop = scroller.scrollTop;
  let glide: Animation | null = null;
  let settleUntil = 0;

  const settle = () => {
    settleUntil = performance.now() + SETTLE_MS;
    glide?.cancel();
    glide = null;
  };
  const toEnd = () => {
    if (following()) scroller.scrollTop = scroller.scrollHeight;
  };

  const steps = () => {
    return [...list.children].filter((child): child is HTMLElement => {
      return child instanceof HTMLElement;
    });
  };

  const remember = () => {
    scrollTop = scroller.scrollTop;
    for (const step of steps()) {
      seen.add(step);
      tops.set(step, step.offsetTop);
    }
  };

  const glideFrom = (delta: number) => {
    const from = currentOffset(list) + delta;
    glide?.cancel();
    glide = list.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], {
      duration: GLIDE_MS,
      easing: EASE_OUT,
    });
  };

  const enter = (step: Element, order: number) => {
    step.animate(
      [
        { opacity: 0, transform: `translateY(${ENTER_OFFSET_PX}px)` },
        { opacity: 1, transform: "none" },
      ],
      { duration: ENTER_MS, delay: order * STAGGER_MS, easing: EASE_OUT, fill: "backwards" },
    );
  };

  // Both observers call back after the DOM or layout changed and before paint, so the first
  // frame the reader sees already starts from the old position. A row easing its own height
  // (a streamed reasoning preview) already moves the log smoothly, frame by frame; gliding on
  // top of that would lag it, so those resizes only keep the end in view.
  const reconcile = (cause: "steps" | "layout") => {
    if (cause === "layout" && list.querySelector("[data-growing]") !== null) {
      toEnd();
      remember();
      return;
    }
    const current = steps();
    // The last step that was on screen before measures how far the log moved.
    let anchorIndex = current.length - 1;
    while (anchorIndex >= 0 && !tops.has(current[anchorIndex])) anchorIndex -= 1;
    const anchor = anchorIndex >= 0 ? current[anchorIndex] : null;
    const animate =
      visible() && !reducedMotion.matches && !document.hidden && performance.now() >= settleUntil;

    if (!animate) {
      toEnd();
      remember();
      return;
    }

    if (anchor !== null && following()) {
      const before = (tops.get(anchor) ?? anchor.offsetTop) - scrollTop;
      // Settle at the end now rather than waiting for scroll anchoring later in the frame.
      toEnd();
      const delta = before - (anchor.offsetTop - scroller.scrollTop);
      // A move larger than the visible log is a relayout, not a step arriving; land it.
      if (Math.abs(delta) >= MIN_GLIDE_PX && Math.abs(delta) < scroller.clientHeight) {
        glideFrom(delta);
      }
    }
    if (anchor !== null) {
      // Only steps after the anchor were appended; earlier fresh rows are a prepended page.
      current
        .slice(anchorIndex + 1)
        .filter((step) => !seen.has(step))
        .forEach(enter);
    }
    remember();
  };

  const mutations = new MutationObserver(() => reconcile("steps"));
  mutations.observe(list, { childList: true });
  const resize = new ResizeObserver(() => reconcile("layout"));
  resize.observe(list);
  const onScroll = () => {
    scrollTop = scroller.scrollTop;
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  // Changes made while the window was hidden land at once when it returns.
  const onVisibility = () => {
    if (!document.hidden) settle();
  };
  document.addEventListener("visibilitychange", onVisibility);
  settle();
  toEnd();
  remember();

  return () => {
    mutations.disconnect();
    resize.disconnect();
    scroller.removeEventListener("scroll", onScroll);
    document.removeEventListener("visibilitychange", onVisibility);
    glide?.cancel();
  };
}
