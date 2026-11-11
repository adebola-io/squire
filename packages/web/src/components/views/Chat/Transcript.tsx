import { Cell, For, If, onConnected } from "retend";
import { FadeScroll, Button } from "squire-ui";

import type { ConversationMessage } from "@/platform/desktopEvents";
import { useChat } from "@/scopes/ChatScope";

import { toTurns } from "./chatModel";
import { TurnView } from "./TurnView";

import classes from "./Chat.module.css";

/** Distance from the end within which the reader still counts as at the bottom. */
const PIN_SLACK_PX = 24;
/** After opening a chat or sending, late layout such as images still settles at the bottom. */
const SETTLE_MS = 1000;

function useTranscriptState() {
  const { snapshot, selectedId, sending, live, loadOlderMessages, loadingOlderMessages } =
    useChat();
  const scrollRef = Cell.source<HTMLElement | null>(null);
  const contentRef = Cell.source<HTMLElement | null>(null);
  // Animate messages created after the conversation opened; display existing messages without
  // entry animation.
  let shownSince = Date.now();
  // Derive all turn data synchronously from one snapshot to keep updates consistent.
  const turns = Cell.derived(() => {
    const current = snapshot.get();
    return current === null ? [] : toTurns(current.messages);
  });
  // Animate messages created after the conversation opened; display existing messages without
  // entry animation.
  const isEntering = (message: ConversationMessage | undefined) => {
    return message !== undefined && Date.parse(message.createdAt) >= shownSince;
  };

  // Opening a chat and sending a message land at the bottom. While the agent works, a reader
  // who is at the bottom stays there as the turn grows; scrolling up releases them, and
  // returning to the end pins them again. A finished answer does not pull the view.
  const working = Cell.derived(() => {
    return (
      sending.get() ||
      live.get() !== null ||
      snapshot.get()?.conversation.executionStatus === "running"
    );
  });
  // Only the reader moving up unpins. A position check alone is not enough: the scroll event
  // from our own jump to the end arrives after more content may have landed, and would read as
  // "not at the end". Growth below and our own jumps never move the view up.
  let pinned = true;
  let lastTop = 0;
  let settleUntil = 0;
  const atEnd = (scroller: HTMLElement) => {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= PIN_SLACK_PX;
  };
  const scrollToEnd = () => {
    const scroller = scrollRef.get();
    if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
  };
  let frame = 0;
  const toBottom = () => {
    pinned = true;
    settleUntil = performance.now() + SETTLE_MS;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(scrollToEnd);
  };
  const onScroll = () => {
    const scroller = scrollRef.get();
    if (scroller === null) return;
    const top = scroller.scrollTop;
    if (atEnd(scroller)) {
      pinned = true;
    } else if (top < lastTop) {
      pinned = false;
    }
    lastTop = top;
  };
  // Resize observations run after layout and before paint, so following never shows a frame
  // with the new content below the fold.
  const onContentResize = () => {
    const scroller = scrollRef.get();
    if (scroller === null) return;
    if (pinned && (working.get() || performance.now() < settleUntil)) {
      scrollToEnd();
    } else {
      pinned = atEnd(scroller);
    }
  };

  selectedId.listen(() => {
    shownSince = Date.now();
  });
  // A new conversation opens at the bottom, and sending scrolls to the bottom. Older pages,
  // replies, and queue drains are left to CSS scroll anchoring.
  let shownConversation: string | null = null;
  let newestUserSeq = 0;
  let queuedCount = 0;
  const newestUserSeqOf = (messages: ConversationMessage[]) => {
    return messages.reduce((newest, message) => {
      return message.role === "user" ? Math.max(newest, message.seq ?? 0) : newest;
    }, 0);
  };
  snapshot.listen((current) => {
    const id = current?.conversation.id ?? null;
    if (id !== shownConversation) {
      shownConversation = id;
      newestUserSeq = current === null ? 0 : newestUserSeqOf(current.messages);
      queuedCount = current?.queued.length ?? 0;
      toBottom();
      return;
    }
    if (current === null) return;
    const seq = newestUserSeqOf(current.messages);
    const queued = current.queued.length;
    if (seq > newestUserSeq || queued > queuedCount) {
      toBottom();
    }
    newestUserSeq = seq;
    queuedCount = queued;
  });
  onConnected(scrollRef, (scroller) => {
    toBottom();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    // The view gets shorter when the composer grows with a multi-line draft. A reader at the
    // end keeps seeing the end instead of having the last lines slide under the composer.
    const viewport = new ResizeObserver(() => {
      if (pinned) scrollToEnd();
    });
    viewport.observe(scroller);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
      viewport.disconnect();
    };
  });
  onConnected(contentRef, (content) => {
    const observer = new ResizeObserver(onContentResize);
    observer.observe(content);
    return () => observer.disconnect();
  });

  const hasOlder = Cell.derived(
    () => snapshot.get()?.nextBefore !== null && snapshot.get() !== null,
  );
  const loadOlder = () => {
    void loadOlderMessages();
  };
  const olderLabel = Cell.derived(() => {
    return loadingOlderMessages.get() ? "Loading earlier messages…" : "Show earlier messages";
  });
  return {
    scrollRef,
    contentRef,
    turns,
    isEntering,
    hasOlder,
    loadOlder,
    olderLabel,
    loadingOlderMessages,
  };
}

export function Transcript() {
  const {
    scrollRef,
    contentRef,
    turns,
    isEntering,
    hasOlder,
    loadOlder,
    olderLabel,
    loadingOlderMessages,
  } = useTranscriptState();

  return (
    <FadeScroll ref={scrollRef} class={classes.transcriptScroll}>
      <ol ref={contentRef} class={classes.transcript}>
        {/* Load earlier transcript pages on demand. */}
        {If(hasOlder, () => (
          <li class={classes.earlierMessages}>
            <Button
              variant="outline"
              class={classes.earlierMessagesButton}
              disabled={loadingOlderMessages}
              onClick={loadOlder}
            >
              {olderLabel}
            </Button>
          </li>
        ))}
        {For(
          turns,
          (item, index) => {
            // Keep turn DOM keyed by the first message while reading updated data by index.
            const entering = isEntering(item.users[0] ?? item.replies[0]);
            return <TurnView turns={turns} index={index} initial={item} entering={entering} />;
          },
          { key: "id" },
        )}
      </ol>
    </FadeScroll>
  );
}
