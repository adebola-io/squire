import { Cell } from "retend";

import { messageText } from "@/components/views/Chat/chatModel";
import { prepareMarkdown } from "@/components/views/Chat/markdownRender";
import {
  DesktopRequestError,
  getConversation,
  getConversationMessages,
  listConversations,
} from "@/platform/desktopClient";
import {
  CONVERSATION_EVENTS,
  type ConversationEvent,
  type ConversationMessage,
  type ConversationSnapshot,
} from "@/platform/desktopEvents";
import {
  applyListEvent,
  applyTranscriptEvent,
  emptyList,
  mergeListPage,
  replaceListPage,
  visibleConversations,
} from "@/scopes/conversationSync";
import { onDesktopEvent } from "@/scopes/DesktopEventsScope";
import { useDerivedSync } from "@/utils/cells";

const MAX_CACHED_TRANSCRIPTS = 10;
/** Events buffered for one background conversation before its cache is dropped instead. */
const MAX_QUEUED_EVENTS = 200;

function describe(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

/** Prepare message Markdown, enabling interactive rendering for assistant replies. */
function prepareMessages(messages: ConversationMessage[]) {
  const assistant: string[] = [];
  const reader: string[] = [];
  for (const message of messages) {
    (message.role === "assistant" ? assistant : reader).push(messageText(message));
  }
  return Promise.all([prepareMarkdown(assistant, true), prepareMarkdown(reader)]);
}

/**
 * Keep earlier pages the user already loaded when a refetch returns only the latest turns.
 * Older messages are stitched on only when the previous snapshot reached into the fresh page,
 * so a gap can never be papered over.
 */
function withOlderHistory(
  fresh: ConversationSnapshot,
  previous: ConversationSnapshot | undefined,
): ConversationSnapshot {
  const floor = fresh.nextBefore;
  if (previous === undefined || floor === null) return fresh;
  const seqOf = (message: ConversationMessage) => message.seq ?? -1;
  const reachesFloor = previous.messages.some((message) => seqOf(message) >= floor);
  let older = previous.messages.filter((message) => {
    const seq = seqOf(message);
    return seq >= 0 && seq < floor;
  });
  if (!reachesFloor || older.length === 0) return fresh;
  // Editability thresholds only move forward. If the oldest fresh request can no longer be
  // edited, nothing before it can be either.
  const oldestRequest = fresh.messages.find((message) => {
    return message.role === "user" && message.status === "complete";
  });
  if (oldestRequest !== undefined && !oldestRequest.editable) {
    older = older.map((message) => (message.editable ? { ...message, editable: false } : message));
  }
  return { ...fresh, messages: [...older, ...fresh.messages], nextBefore: previous.nextBefore };
}

interface ShowInput {
  kind: "show";
  id: string | null;
}

interface EventInput {
  kind: "event";
  event: ConversationEvent;
}

type TranscriptInput = ShowInput | EventInput;

interface ChatStoreOptions {
  /** The selected conversation was deleted on the server. */
  onSelectedConversationDeleted: () => void;
}

export interface ChatStore {
  show: (id: string | null) => void;
  loadEarlierMessages: (id: string) => Promise<void>;
  retryConversation: (id: string) => void;
  loadMoreConversationSummaries: () => Promise<void>;
  refreshConversationSummaries: () => Promise<void>;

  /** The displayed snapshot, written when the task's run settles. */
  snapshot: Cell<ConversationSnapshot | null>;
  transcriptError: Cell<string | null>;

  conversationSummaries: Cell<ReturnType<typeof visibleConversations>>;
  summariesError: Cell<string | null>;
  hasMoreConversationSummaries: Cell<boolean>;
  loadingMoreConversationSummaries: Cell<boolean>;

  hasEarlierMessages: Cell<boolean>;
  loadingEarlierMessages: Cell<boolean>;
  earlierMessagesError: Cell<string | null>;
}

/** One event-driven conversation store shared by the sidebar and the transcript. */
export function createChatStore(options: ChatStoreOptions): ChatStore {
  const selection = Cell.source<string | null>(null);
  const transcripts = new Map<string, ConversationSnapshot>();
  const inFlight = new Map<string, Promise<void>>();
  const queuedEvents = new Map<string, ConversationEvent[]>();
  // Snapshots invalidated by a gap or resync, kept until the refetch lands so earlier pages the
  // user loaded survive it.
  const retained = new Map<string, ConversationSnapshot>();
  let earlierId: string | null = null;

  const forget = (id: string) => {
    transcripts.delete(id);
    inFlight.delete(id);
    queuedEvents.delete(id);
    retained.delete(id);
  };

  /** Drop a transcript that must be refetched, keeping its loaded history for the refetch. */
  const invalidate = (id: string) => {
    const previous = transcripts.get(id) ?? retained.get(id);
    forget(id);
    if (previous !== undefined) retained.set(id, previous);
  };

  const enqueue = (id: string, event: ConversationEvent) => {
    const queue = queuedEvents.get(id) ?? [];
    queue.push(event);
    if (queue.length > MAX_QUEUED_EVENTS && id !== selection.peek()) {
      // Cheaper to refetch on open than to hold a long run's events in memory.
      forget(id);
      return;
    }
    queuedEvents.set(id, queue);
  };

  const remember = (id: string, snapshot: ConversationSnapshot) => {
    transcripts.set(id, snapshot);
    if (transcripts.size <= MAX_CACHED_TRANSCRIPTS) return;
    for (const key of transcripts.keys()) {
      if (transcripts.size <= MAX_CACHED_TRANSCRIPTS) return;
      if (key === id || key === selection.peek()) continue;
      forget(key);
    }
  };

  /** Apply buffered events; false means refetch. */
  const flush = (id: string) => {
    const queued = queuedEvents.get(id);
    queuedEvents.delete(id);
    let snapshot = transcripts.get(id);
    if (snapshot === undefined) return true;
    for (const event of queued ?? []) {
      const outcome = applyTranscriptEvent(snapshot, event);
      if (outcome.gap) {
        invalidate(id);
        return false;
      }
      snapshot = outcome.snapshot;
    }
    remember(id, snapshot);
    return true;
  };

  const fetchTranscript = (id: string): Promise<void> => {
    const existing = inFlight.get(id);
    if (existing !== undefined) return existing;

    let request!: Promise<void>;
    request = (async () => {
      try {
        const fresh = await getConversation(id);
        await prepareMessages(fresh.messages);
        // A retry, reconnect, or replacement may have invalidated this request meanwhile.
        if (inFlight.get(id) !== request) return;
        const current = transcripts.get(id);
        if (current === undefined || fresh.revision > current.revision) {
          remember(id, withOlderHistory(fresh, current ?? retained.get(id)));
        }
        retained.delete(id);
      } catch (error) {
        // An obsolete load must not surface a 404 or other error over its replacement.
        if (inFlight.get(id) === request) throw error;
      }
    })();
    inFlight.set(id, request);
    const clear = () => {
      if (inFlight.get(id) === request) inFlight.delete(id);
    };
    void request.then(clear, clear);
    return request;
  };

  const applyEvent = (event: ConversationEvent) => {
    const id = event.conversationId;
    if (event.conversation === null) {
      forget(id);
      if (selection.peek() === id) {
        selection.set(null);
        options.onSelectedConversationDeleted();
      }
      return;
    }
    const cached = transcripts.get(id);
    if (cached !== undefined) {
      const outcome = applyTranscriptEvent(cached, event);
      if (outcome.gap) {
        invalidate(id);
      } else {
        remember(id, outcome.snapshot);
      }
    } else if (id === selection.peek()) {
      enqueue(id, event);
    }
  };

  const transcript = Cell.task(
    async (input: TranscriptInput): Promise<ConversationSnapshot | null> => {
      if (input.kind === "show") selection.set(input.id);
      else applyEvent(input.event);
      const id = selection.peek();
      if (id === null) return null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!transcripts.has(id)) {
          try {
            await fetchTranscript(id);
          } catch (error) {
            if (!(error instanceof DesktopRequestError) || error.status !== 404) throw error;
            forget(id);
            if (selection.peek() === id) {
              selection.set(null);
              options.onSelectedConversationDeleted();
            }
            return null;
          }
        }
        if (!transcripts.has(id)) continue;
        if (flush(id)) return transcripts.get(id) ?? null;
      }
      return transcripts.get(id) ?? null;
    },
  );

  const snapshot = useDerivedSync(transcript);

  const earlier = Cell.task(async (id: string) => {
    earlierId = id;
    const current = transcripts.get(id);
    if (current === undefined || current.nextBefore === null) return;
    const page = await getConversationMessages(id, current.nextBefore);
    await prepareMessages(page.messages);
    const latest = transcripts.get(id);
    // The transcript was refetched or dropped meanwhile. Its window may no longer end where this
    // page begins, so stitching would leave a hole; the user can load the page again.
    if (latest === undefined || latest.nextBefore !== current.nextBefore) return;
    const seen = new Set<string>();
    const messages = [...page.messages, ...latest.messages].filter((message) => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
    remember(id, { ...latest, messages, nextBefore: page.nextBefore });
    if (selection.peek() === id) await transcript.runWith({ kind: "show", id });
  });

  const summaries = Cell.source(emptyList());
  const listCursor = Cell.source<string | null | undefined>(undefined);

  const summariesLoad = Cell.task(async (reset: boolean, signal) => {
    const after = reset ? null : listCursor.peek();
    if (after === null && !reset) return;
    const page = await listConversations(signal, "", after);
    if (signal.aborted) return;
    summaries.set(reset ? replaceListPage(page) : mergeListPage(summaries.peek(), page));
    listCursor.set(page.nextCursor ?? null);
  });

  const loadMoreConversationSummaries = async () => {
    if (typeof listCursor.peek() !== "string" || summariesLoad.pending.get()) return;
    await summariesLoad.runWith(false);
  };

  const refreshConversationSummaries = async () => {
    await summariesLoad.runWith(true);
  };

  const show = (id: string | null) => {
    earlier.error.set(null);
    void transcript.runWith({ kind: "show", id });
  };

  const retryConversation = (id: string) => {
    forget(id);
    show(id);
  };

  const loadEarlierMessages = async (id: string) => {
    if (earlier.pending.get()) return;
    await earlier.runWith(id);
  };

  const handleConversationEvent = (event: ConversationEvent) => {
    const list = summaries.peek();
    const nextList = applyListEvent(list, event);
    if (nextList === "refetch") {
      void refreshConversationSummaries();
    } else if (nextList !== list) {
      summaries.set(nextList);
    }
    if (event.conversationId === selection.peek()) {
      void transcript.runWith({ kind: "event", event });
    } else if (event.conversation === null) {
      forget(event.conversationId);
    } else {
      const id = event.conversationId;
      // Only cached or loading transcripts need the events; others load fresh when opened.
      if (transcripts.has(id) || inFlight.has(id)) enqueue(id, event);
    }
  };

  const reload = () => {
    const selected = selection.peek();
    const previous = selected === null ? undefined : transcripts.get(selected);
    transcripts.clear();
    inFlight.clear();
    queuedEvents.clear();
    retained.clear();
    if (selected !== null && previous !== undefined) retained.set(selected, previous);
    void refreshConversationSummaries();
    const id = selection.peek();
    if (id !== null) {
      void transcript.runWith({ kind: "show", id });
    }
  };

  for (const type of CONVERSATION_EVENTS) {
    onDesktopEvent(type, handleConversationEvent);
  }
  onDesktopEvent("resync", reload);
  onDesktopEvent("connection.opened", reload);

  const transcriptError = Cell.derived(() => {
    const error = transcript.error.get();
    return error === null ? null : describe(error, "Could not load this conversation");
  });
  const conversationSummaries = Cell.derived(() => visibleConversations(summaries.get()));
  const summariesError = Cell.derived(() => summariesLoad.error.get()?.message ?? null);
  const hasMoreConversationSummaries = Cell.derived(() => typeof listCursor.get() === "string");
  const loadingMoreConversationSummaries = Cell.derived(() => {
    return summariesLoad.pending.get() && summaries.peek().entries.size > 0;
  });
  const hasEarlierMessages = Cell.derived(() => {
    const current = snapshot.get();
    return current !== null && current.nextBefore !== null;
  });
  const loadingEarlierMessages = Cell.derived(() => {
    return earlier.pending.get() && earlierId === selection.get();
  });
  const earlierMessagesError = Cell.derived(() => {
    if (earlierId !== selection.get()) return null;
    const error = earlier.error.get();
    return error === null ? null : describe(error, "Could not load earlier messages");
  });

  return {
    show,
    loadEarlierMessages,
    retryConversation,
    loadMoreConversationSummaries,
    refreshConversationSummaries,
    transcriptError,
    snapshot,
    conversationSummaries,
    summariesError,
    hasMoreConversationSummaries,
    loadingMoreConversationSummaries,
    hasEarlierMessages,
    loadingEarlierMessages,
    earlierMessagesError,
  };
}
