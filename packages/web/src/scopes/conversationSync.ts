import type {
  ConversationListResponse,
  ConversationMessage,
  ConversationSnapshot,
  ConversationToolCall,
  DesktopConversation,
  ConversationEvent,
} from "@/platform/desktopEvents";

/**
 * Pure client-side reducers. Durable events carry the conversation's revision and
 * exactly the data that changed, so applying one advances a transcript or the
 * sidebar without refetching.
 */

export interface AppliedEvent {
  snapshot: ConversationSnapshot;
  /** The event cannot be applied safely; bootstrap the transcript again. */
  gap: boolean;
}

function upsertMessage(messages: ConversationMessage[], message: ConversationMessage) {
  // Queued Messages stay in the queue list until they join the transcript.
  if (message.status !== "complete") {
    return messages;
  }
  const rest = messages.filter((existing) => {
    return existing.id !== message.id;
  });
  rest.push(message);
  return rest.sort((left, right) => {
    return (left.seq ?? 0) - (right.seq ?? 0);
  });
}

function upsertToolCall(messages: ConversationMessage[], call: ConversationToolCall) {
  return messages.map((message) => {
    if (message.id !== call.messageId) {
      return message;
    }
    const calls = message.toolCalls ?? [];
    const index = calls.findIndex((existing) => {
      return existing.id === call.id;
    });
    const next = [...calls];
    if (index === -1) {
      next.push(call);
    } else {
      next[index] = call;
    }
    return { ...message, toolCalls: next };
  });
}

/**
 * Apply one durable event to a transcript. Events at the current revision are
 * applied idempotently (some runtime metadata shares the revision of the write
 * that started it); older events are ignored; a gap means re-bootstrap.
 */
export function applyTranscriptEvent(
  snapshot: ConversationSnapshot,
  event: ConversationEvent,
): AppliedEvent {
  if (event.type === "transcript.replaced") {
    return { snapshot, gap: true };
  }
  if (event.revision === undefined) {
    return {
      snapshot: event.live !== undefined ? { ...snapshot, live: event.live } : snapshot,
      gap: false,
    };
  }
  if (event.revision < snapshot.revision) {
    return { snapshot, gap: false };
  }
  if (event.revision > snapshot.revision + 1) {
    return { snapshot, gap: true };
  }
  let next: ConversationSnapshot = { ...snapshot, revision: event.revision };
  if (event.conversation !== undefined && event.conversation !== null) {
    next.conversation = event.conversation;
  }
  if (event.message !== undefined && event.message !== null) {
    next.messages = upsertMessage(next.messages, event.message);
  }
  if (event.toolCall !== undefined && event.toolCall !== null) {
    next.messages = upsertToolCall(next.messages, event.toolCall);
  }
  if (event.queued !== undefined) {
    next.queued = event.queued;
  }
  if (event.jobs !== undefined) {
    next.jobs = event.jobs;
  }
  if (event.live !== undefined) {
    next.live = event.live;
  }
  return { snapshot: next, gap: false };
}

/** Revision-tracked sidebar list merged from fetched pages and events. */
export interface ConversationList {
  entries: Map<string, ListEntry>;
}

interface ListEntry {
  revision: number;
  /** Retain deletion markers so older pages cannot restore removed conversations. */
  conversation: DesktopConversation | null;
}

export function emptyList(): ConversationList {
  return { entries: new Map() };
}

function keepNewer(
  entries: Map<string, ListEntry>,
  id: string,
  revision: number,
  conversation: DesktopConversation | null,
) {
  const current = entries.get(id);
  if (current === undefined || revision >= current.revision) {
    entries.set(id, { revision, conversation });
  }
}

/** Merge each conversation using the latest revision from pages or events. */
export function mergeListPage(
  list: ConversationList,
  page: ConversationListResponse,
): ConversationList {
  const entries = new Map(list.entries);
  for (const conversation of page.conversations) {
    keepNewer(entries, conversation.id, page.revisions[conversation.id] ?? 0, conversation);
  }
  return { entries };
}

/** Replace the list with one page, dropping entries that are no longer present. */
export function replaceListPage(page: ConversationListResponse): ConversationList {
  return mergeListPage(emptyList(), page);
}

/** Apply events containing a conversation summary to the sidebar list. */
export function applyListEvent(
  list: ConversationList,
  event: ConversationEvent,
): ConversationList | "refetch" {
  if (event.conversation === undefined) {
    return list;
  }
  if (event.revision === undefined) {
    return "refetch";
  }
  const entries = new Map(list.entries);
  keepNewer(entries, event.conversationId, event.revision, event.conversation);
  return { entries };
}

/** Sort nondeleted conversations by latest update. */
export function visibleConversations(list: ConversationList) {
  const conversations: DesktopConversation[] = [];
  for (const entry of list.entries.values()) {
    if (entry.conversation !== null) {
      conversations.push(entry.conversation);
    }
  }
  return conversations.sort((left, right) => {
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}
