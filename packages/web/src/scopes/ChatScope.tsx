import { AsyncCell, Cell, createScope, onSetup, useScopeContext, type SourceCell } from "retend";
import { useDocumentVisibility, useLiveDate } from "retend-utils/hooks";
import type { JSX } from "retend/jsx-runtime";
import { useCurrentRoute, useRouter } from "retend/router";

import {
  branchConversation,
  editConversationMessage,
  editQueuedMessage,
  markConversationSeen,
  type AttachmentInput,
  cancelConversationJob,
  deleteQueuedMessage,
  type DesktopProviders,
  getAgentProviders,
  sendConversationMessage,
  sendQueuedNow,
  startConversation,
  stopConversation,
} from "@/platform/desktopClient";
import {
  type ModelRef,
  type ConversationMessage,
  type ConversationSnapshot,
  type DesktopConversation,
  type LiveActivity,
} from "@/platform/desktopEvents";
import { createChatStore } from "@/scopes/chatStore";
import { onDesktopEvent } from "@/scopes/DesktopEventsScope";
import { createModelDiscoveryStore, type ModelDiscoveryStore } from "@/scopes/modelDiscovery";

interface ChatCells {
  providers: AsyncCell<DesktopProviders>;
  modelDiscovery: ModelDiscoveryStore;
  conversations: Cell<DesktopConversation[]>;
  /** Conversation ID from the `/chat/:conversationId` route. */
  selectedId: Cell<string | null>;
  /**
   * Latest displayed conversation snapshot. Retain it while another chat loads and prepares
   * Markdown, then replace it atomically. Null before loading or on the new-chat screen.
   */
  snapshot: Cell<ConversationSnapshot | null>;
  /** Whether another conversation is loading while the previous snapshot remains visible. */
  switching: Cell<boolean>;
  /** Current server-reported conversation activity. */
  live: Cell<LiveActivity | null>;
  /** Transient streamed reasoning for the active model response. */
  liveReasoning: Cell<string>;
  /** Shared clock for durations and date-grouped history. */
  clock: Cell<Date>;
  /** Send, edit or stop error displayed by the composer. */
  error: Cell<string | null>;
  /** List loading or update error displayed in the sidebar. */
  listError: Cell<string | null>;
  /** Snapshot loading error displayed in the transcript. */
  conversationError: Cell<string | null>;
  /** Whether older conversation pages remain. */
  hasMoreChats: Cell<boolean>;
  loadingMoreChats: Cell<boolean>;
  loadMoreChats: () => void;
  loadOlderMessages: () => Promise<void>;
  loadingOlderMessages: Cell<boolean>;
  busy: Cell<boolean>;
  /** Whether a message send is awaiting a server response. */
  sending: Cell<boolean>;
  /** Latest client message key acknowledged by a server event. */
  acceptedMessageKey: Cell<string | null>;
  modelIntent: SourceCell<ModelRef | null>;
  selectedModel: AsyncCell<ModelRef | null>;
  nativeOptions: SourceCell<unknown>;
  refreshProviders: () => void;
  /** Retry loading the selected conversation. */
  retryConversation: () => void;
  /** Reload the conversation list after a sidebar error. */
  refreshConversationSummaries: () => Promise<void>;
}

interface ChatActions {
  /** Open the empty composer; create the conversation on the first send. */
  startNew: () => void;
  select: (id: string) => void;
  send: (
    text: string,
    attachments?: AttachmentInput[],
    clientMessageId?: string,
  ) => Promise<boolean>;
  edit: (messageId: string, text: string, queued?: boolean) => Promise<boolean>;
  branch: (messageId: string) => Promise<void>;
  stop: () => Promise<void>;
  sendNow: () => Promise<void>;
  removeQueued: (messageId: string) => Promise<void>;
  cancelJob: (jobId: string) => Promise<void>;
}

type ChatState = ChatCells & ChatActions;

interface ChatProviderProps {
  children: JSX.Children;
}

const ChatScope = createScope<ChatState>();

function describe(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

type ChatOperation = () => Promise<void>;

/** Route for an existing conversation or a new chat. */
export function chatPath(id: string | null) {
  return id === null ? "/chat" : `/chat/${encodeURIComponent(id)}`;
}

/** Shared conversation selection, list and snapshot for the sidebar and chat view. */
function useChatState() {
  const router = useRouter();
  const route = useCurrentRoute();
  const clock = useLiveDate();
  const operation = Cell.task(async (action: ChatOperation) => {
    await action();
    return true;
  });
  const selectedId = Cell.derived(() => {
    return route.get().params.get("conversationId") ?? null;
  });
  // Reasoning streamed for each conversation's current model turn. Every running conversation
  // keeps its own text, so switching away and back shows the whole turn instead of splicing
  // the deltas from before and after the switch. Entries end with their model turn or run.
  const reasoningText = new Map<string, string>();
  // The stored reply that ends each conversation's streamed reasoning. The text stays until the
  // transcript shows that reply, so the work log's live step becomes the stored step in place
  // instead of unmounting while the reply is still being applied.
  const reasoningEndedBy = new Map<string, string>();
  const reasoningRevision = Cell.source(0);
  const setReasoning = (conversationId: string, text: string | null) => {
    reasoningEndedBy.delete(conversationId);
    if (text === null) {
      if (!reasoningText.delete(conversationId)) return;
    } else {
      reasoningText.set(conversationId, text);
    }
    reasoningRevision.set(reasoningRevision.peek() + 1);
  };
  const endReasoningWith = (conversationId: string, messageId: string) => {
    if (!reasoningText.has(conversationId)) return;
    reasoningEndedBy.set(conversationId, messageId);
    reasoningRevision.set(reasoningRevision.peek() + 1);
  };
  onDesktopEvent("model.started", (event) => {
    setReasoning(event.conversationId, null);
  });
  onDesktopEvent("model.reasoning.delta", (event) => {
    const current = reasoningText.get(event.conversationId) ?? "";
    setReasoning(event.conversationId, current + event.delta);
  });
  onDesktopEvent("execution.finished", (event) => {
    setReasoning(event.conversationId, null);
  });
  // The latest Message key acknowledged by the server. The composer clears a draft on this key
  // even before the HTTP response arrives.
  const acceptedMessageKey = Cell.source<string | null>(null);
  const noteAcceptedMessage = (message: ConversationMessage | null | undefined) => {
    const key = message?.clientMessageId;
    if (key !== null && key !== undefined) {
      acceptedMessageKey.set(key);
    }
  };
  onDesktopEvent("message.appended", (event) => {
    noteAcceptedMessage(event.message);
    // Each model turn gets its own reasoning step, so a stored reply ends the streamed text.
    if (event.message?.role === "assistant") {
      endReasoningWith(event.conversationId, event.message.id);
    }
  });
  onDesktopEvent("queue.updated", (event) => {
    for (const message of event.queued ?? []) noteAcceptedMessage(message);
  });
  const store = createChatStore({
    onSelectedConversationDeleted: () => {
      void router.replace(chatPath(null));
    },
  });
  store.show(selectedId.get());
  onSetup(() => {
    void store.refreshConversationSummaries();
  });

  const stopError = Cell.source<string | null>(null);
  const error = Cell.derived(() => {
    return operation.error.get()?.message ?? stopError.get();
  });
  const {
    snapshot,
    conversationSummaries: conversations,
    summariesError,
    transcriptError,
    earlierMessagesError,
    hasMoreConversationSummaries: hasMore,
    loadingMoreConversationSummaries: loadingMore,
    loadMoreConversationSummaries,
    loadEarlierMessages,
    loadingEarlierMessages,
    retryConversation,
    refreshConversationSummaries,
  } = store;
  // Show reasoning only for the open conversation, and only while its run is active. Holding it
  // until the run ends keeps the work log's live step mounted between a finished model turn and
  // its stored message; switching chats and finishing need no reset of their own.
  const liveReasoning = Cell.derived(() => {
    reasoningRevision.get();
    const id = selectedId.get();
    const current = snapshot.get();
    if (id === null || current?.conversation.id !== id) return "";
    if (current.conversation.executionStatus !== "running") return "";
    // Ending in the same derivation as the reply landing keeps both in one update.
    const endedBy = reasoningEndedBy.get(id);
    if (endedBy !== undefined && current.messages.some((message) => message.id === endedBy)) {
      return "";
    }
    return reasoningText.get(id) ?? "";
  });
  const switching = Cell.derived(() => {
    const id = selectedId.get();
    const shown = snapshot.get()?.conversation.id ?? null;
    return id !== null && shown !== null && shown !== id;
  });
  const live = Cell.derived(() => {
    return snapshot.get()?.live ?? null;
  });
  const modelIntent = Cell.source<ModelRef | null>(null);
  const nativeOptions = Cell.source<unknown>(null);
  const providerRevision = Cell.source(0);
  const modelDiscovery = createModelDiscoveryStore();
  onSetup(() => {
    return () => modelDiscovery.dispose();
  });
  const providers = Cell.derivedAsync(async (get, signal) => {
    get(providerRevision);
    return await getAgentProviders(signal);
  });
  const selectedModel = Cell.derivedAsync(async (get) => {
    return (
      get(modelIntent) ??
      get(snapshot)?.conversation.currentModel ??
      (await get(providers)).defaultModel
    );
  });
  selectedId.listen((id) => {
    store.show(id);
    modelIntent.set(null);
    nativeOptions.set(null);
    // Clear errors associated with the previous conversation.
    operation.error.set(null);
    stopError.set(null);
  });
  // Mark the open conversation read whenever new messages arrive while it is visible.
  const seen = Cell.task(async (id: string, signal) => {
    let current = snapshot.get();
    while (
      current !== null &&
      current.conversation.id === id &&
      current.conversation.unread &&
      document.visibilityState === "visible"
    ) {
      const seq = current.messages.at(-1)?.seq ?? 0;
      await markConversationSeen(id, seq);
      if (signal.aborted) return;
      current = snapshot.get();
      if (
        current === null ||
        current.conversation.id !== id ||
        (current.messages.at(-1)?.seq ?? 0) <= seq
      ) {
        return;
      }
    }
  });
  const markSeen = () => {
    const current = snapshot.get();
    if (
      current === null ||
      !current.conversation.unread ||
      document.visibilityState !== "visible" ||
      seen.pending.get()
    ) {
      return;
    }
    void seen.runWith(current.conversation.id);
  };
  snapshot.listen(markSeen);
  const documentIsVisible = useDocumentVisibility();
  documentIsVisible.listen(markSeen);

  // Sidebar errors include list loads and the background read marker.
  const listError = Cell.derived(() => {
    return summariesError.get() ?? seen.error.get()?.message ?? null;
  });
  const conversationError = Cell.derived(() => {
    return transcriptError.get() ?? earlierMessagesError.get();
  });

  // True while the send request is in flight. The transcript renders only confirmed server state.
  const sending = Cell.source(false);
  let stoppedWhileSending = false;

  const run = async (action: ChatOperation) => {
    if (operation.pending.get()) {
      return false;
    }
    const succeeded = await operation.runWith(action);
    return succeeded === true && operation.error.get() === null;
  };
  const clearError = () => {
    operation.error.set(null);
    stopError.set(null);
  };
  const cells: ChatCells = {
    selectedId,
    conversations,
    snapshot,
    switching,
    clock,
    live,
    liveReasoning,
    error,
    listError,
    conversationError,
    hasMoreChats: hasMore,
    loadingMoreChats: loadingMore,
    loadMoreChats: () => {
      void loadMoreConversationSummaries();
    },
    loadOlderMessages: () => loadEarlierMessages(selectedId.get() ?? ""),
    loadingOlderMessages: loadingEarlierMessages,
    busy: operation.pending,
    sending,
    acceptedMessageKey,
    providers,
    modelDiscovery,
    modelIntent,
    selectedModel,
    nativeOptions,
    retryConversation: () => {
      const id = selectedId.get();
      if (id !== null) retryConversation(id);
    },
    refreshConversationSummaries,
    refreshProviders: () => {
      modelDiscovery.invalidate();
      providerRevision.set(providerRevision.get() + 1);
    },
  };
  // Select conversations through route navigation.
  const open = async (id: string | null) => {
    clearError();
    await router.navigate(chatPath(id));
  };
  const withSelected = (action: (id: string) => Promise<unknown>) => {
    return run(async () => {
      const id = selectedId.get();
      if (id !== null) {
        await action(id);
      }
    });
  };
  const sendMessage = (text: string, attachments: AttachmentInput[], clientMessageId?: string) => {
    return run(async () => {
      const model = await selectedModel.get();
      const options = nativeOptions.get();
      const current = selectedId.get();
      if (current === null) {
        // Create and send in one request so a failed first message cannot leave an empty chat.
        const conversation = await startConversation({
          text,
          modelRef: model,
          nativeOptions: options,
          attachments,
          clientMessageId,
        });
        await open(conversation.id);
      } else {
        await sendConversationMessage(current, text, model, options, attachments, clientMessageId);
      }
      // Refresh the default-model summary after sending without invalidating provider
      // configuration.
      providerRevision.set(providerRevision.get() + 1);
    });
  };
  // Mutations are confirmed through server events. The client never invents transcript state.
  const actions: ChatActions = {
    startNew: () => {
      void open(null);
    },
    select: (id) => {
      void open(id);
    },
    send: async (text, attachments = [], clientMessageId) => {
      if (operation.pending.get()) {
        return false;
      }
      sending.set(true);
      stoppedWhileSending = false;
      let sent = false;
      try {
        sent = await sendMessage(text, attachments, clientMessageId);
      } finally {
        sending.set(false);
      }
      // Treat Stop during a compaction-blocked send as cancellation, not a send error.
      if (!sent && stoppedWhileSending) {
        operation.error.set(null);
      }
      return sent;
    },
    edit: (messageId, text, queued = false) => {
      return withSelected((id) => {
        return (queued ? editQueuedMessage : editConversationMessage)(id, messageId, text);
      });
    },
    branch: async (messageId) => {
      await withSelected(async (id) => {
        await open((await branchConversation(id, messageId)).id);
      });
    },
    stop: async () => {
      const id = selectedId.get();
      if (id === null) {
        return;
      }
      if (sending.get()) {
        stoppedWhileSending = true;
      }
      try {
        await stopConversation(id);
      } catch (error) {
        stopError.set(describe(error, "Could not stop work"));
      }
    },
    sendNow: async () => {
      await withSelected(sendQueuedNow);
    },
    // Cancelling a job must work while a send or edit is pending, so it bypasses the exclusive
    // operation gate. Failures reject so the job row can report them.
    cancelJob: async (jobId) => {
      const id = selectedId.get();
      if (id !== null) {
        await cancelConversationJob(id, jobId);
      }
    },
    removeQueued: async (messageId) => {
      await withSelected((id) => {
        return deleteQueuedMessage(id, messageId);
      });
    },
  };
  return { ...cells, ...actions };
}

export function ChatProvider(props: ChatProviderProps) {
  const { children } = props;
  const value = useChatState();
  return <ChatScope.Provider value={value}>{children}</ChatScope.Provider>;
}

export function useChat() {
  return useScopeContext(ChatScope);
}
