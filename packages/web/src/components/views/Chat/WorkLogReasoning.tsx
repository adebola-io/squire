import { Cell, onConnected, type SourceCell } from "retend";

import { getConversationMessageParts } from "@/platform/desktopClient";
import { useChat } from "@/scopes/ChatScope";

import type { LogEntry } from "./workLogState";
import { ToolStep } from "./WorkLogToolStep";

import classes from "./WorkLog.module.css";

const INTERVAL_MS = 90;
const CHARS_PER_STEP = 14;
const PREVIEW_CHARS = 900;
/** Longer than the preview's height transition, in case that transition never runs. */
const GROW_FALLBACK_MS = 500;

type ReasoningPreviewChat = Pick<
  ReturnType<typeof useChat>,
  "selectedId" | "liveReasoning" | "live"
>;

/** Handle streaming and historical loading independently of the JSX component. */
function attachReasoningPreview(
  viewport: HTMLElement,
  entry: Cell<LogEntry>,
  text: SourceCell<string>,
  { selectedId, liveReasoning, live }: ReasoningPreviewChat,
  streaming: boolean,
) {
  const controller = new AbortController();
  const rendered = viewport.querySelector<HTMLElement>(`.${classes.reasoningText}`);
  if (!rendered) return;
  let latest = liveReasoning.peek();
  let cursor = streaming ? latest.length : 0;
  let timer = 0;
  let inView = false;
  let requested = false;
  const stop = () => {
    window.clearTimeout(timer);
    timer = 0;
  };
  const paint = () => {
    timer = 0;
    if (!streaming) return;
    const source = liveReasoning.peek();
    const immediate =
      document.hidden ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      live.peek()?.kind !== "thinking";
    if (immediate) cursor = source.length;
    else if (source.length - cursor > 180) cursor = source.length - 100;
    else cursor = Math.min(source.length, cursor + CHARS_PER_STEP);
    text.set(source.slice(Math.max(0, cursor - PREVIEW_CHARS), cursor));
    if (cursor < source.length) timer = window.setTimeout(paint, INTERVAL_MS);
  };
  const onDelta = (value: string) => {
    if (!streaming) return;
    if (!value) {
      stop();
      text.set(latest.slice(-PREVIEW_CHARS));
      cursor = latest.length;
      return;
    }
    latest = value;
    if (cursor === 0) {
      cursor = Math.min(value.length, CHARS_PER_STEP);
      text.set(value.slice(0, cursor));
    }
    if (!timer && cursor < value.length) timer = window.setTimeout(paint, INTERVAL_MS);
  };
  const load = () => {
    if (!inView || streaming || requested || text.peek()) return;
    const current = entry.peek();
    if (current.kind !== "reasoning" || !("messageId" in current)) return;
    const id = selectedId.peek();
    if (id === null) return;
    requested = true;
    void getConversationMessageParts(id, current.messageId, controller.signal)
      .then((parts) => {
        if (!controller.signal.aborted) {
          text.set(
            parts
              .filter((part) => part.type === "reasoning" && typeof part.text === "string")
              .map((part) => part.text)
              .join("\n")
              .slice(-PREVIEW_CHARS),
          );
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.error("Could not load reasoning:", error);
      });
  };
  const stopEntry = entry.listen((current) => {
    if (current.kind !== "reasoning" || !("messageId" in current)) return;
    if (streaming) {
      streaming = false;
      stop();
      text.set(latest.slice(-PREVIEW_CHARS));
      // The live preview is already the correct tail; no payload refetch needed.
    } else {
      load();
    }
  });
  const stopDeltas = liveReasoning.listen(onDelta);
  const stopActivity = live.listen(() => {
    if (streaming && live.peek()?.kind !== "thinking") {
      stop();
      text.set(latest.slice(-PREVIEW_CHARS));
      cursor = latest.length;
    }
  });
  const inViewport = new IntersectionObserver(([observation]) => {
    inView = observation.isIntersecting;
    if (inView) load();
  });
  inViewport.observe(viewport);
  // A streamed preview grows a line at a time; ease its height so the log moves smoothly.
  // Historical previews load at their full height without motion.
  const easeHeight = streaming && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let height = -1;
  let growTimer = 0;
  const grown = () => {
    window.clearTimeout(growTimer);
    delete viewport.dataset.growing;
  };
  const onSized = (event: TransitionEvent) => {
    if (event.target === viewport && event.propertyName === "block-size") grown();
  };
  if (easeHeight) {
    viewport.dataset.easeHeight = "true";
    viewport.addEventListener("transitionend", onSized);
    viewport.addEventListener("transitioncancel", onSized);
  }
  const measure = new ResizeObserver(() => {
    const limit = parseFloat(getComputedStyle(viewport).maxBlockSize);
    const natural = rendered.offsetHeight;
    const next = Number.isFinite(limit) ? Math.min(natural, limit) : natural;
    viewport.dataset.scrolled = String(natural > next + 1);
    if (!easeHeight || next === height) return;
    // The first measurement sets the starting height; later ones ease to the new height.
    if (height >= 0) {
      viewport.dataset.growing = "true";
      // A transition that never runs (a hidden window, say) must not hold the flag.
      window.clearTimeout(growTimer);
      growTimer = window.setTimeout(grown, GROW_FALLBACK_MS);
    }
    height = next;
    viewport.style.blockSize = `${next}px`;
  });
  measure.observe(rendered);
  return () => {
    grown();
    viewport.removeEventListener("transitionend", onSized);
    viewport.removeEventListener("transitioncancel", onSized);
    stop();
    stopEntry();
    stopDeltas();
    stopActivity();
    controller.abort();
    inViewport.disconnect();
    measure.disconnect();
  };
}

interface ReasoningStepProps {
  entry: Cell<LogEntry>;
}

/** Tool-row preview: pace live text; load historical text only when it enters view. */
export function ReasoningStep(props: ReasoningStepProps) {
  const { entry } = props;
  const chat = useChat();
  const { liveReasoning, live } = chat;
  const initial = entry.peek();
  const streaming = initial.kind === "reasoning" && "live" in initial;
  const text = Cell.source(streaming ? liveReasoning.peek().slice(-PREVIEW_CHARS) : "");
  const previewRef = Cell.source<HTMLElement | null>(null);
  const status = Cell.derived(() =>
    entry.get().kind === "reasoning" && "live" in entry.get() && live.get()?.kind === "thinking"
      ? "running"
      : "complete",
  );
  const hasText = Cell.derived(() => String(text.get().length > 0));

  onConnected(previewRef, (viewport) =>
    attachReasoningPreview(viewport, entry, text, chat, streaming),
  );

  return (
    <ToolStep kind="reasoning" label="Reasoning" icon="brain" status={status}>
      <div ref={previewRef} class={classes.reasoningPreview} data-has-text={hasText}>
        <span class={classes.reasoningText}>{text}</span>
      </div>
    </ToolStep>
  );
}
