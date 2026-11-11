import { Cell, If } from "retend";

import { LoadingState } from "@/components/ui/LoadingState";
import { useChat } from "@/scopes/ChatScope";

import { Transcript } from "./Transcript";

import classes from "./Chat.module.css";

/**
 * Show delayed initial loading feedback or a retryable load error in place of the conversation.
 */
function ConversationLoading() {
  const { conversationError, retryConversation } = useChat();
  const loadError = Cell.derived(() => {
    const message = conversationError.get();
    return message === null ? null : `Couldn't load this chat: ${message}`;
  });
  return (
    <section class={classes.conversationContent}>
      <LoadingState
        screen
        label="Opening conversation…"
        error={loadError}
        onRetry={retryConversation}
      />
    </section>
  );
}

/**
 * Render the prepared snapshot without additional async work. Preserve the current view while
 * switching chats, and make it inert until replacement data is ready.
 */
export function ConversationView() {
  const { snapshot, switching, conversationError } = useChat();
  // Replace the previous conversation with an error if the selected chat fails to load.
  const showContent = Cell.derived(() => {
    return snapshot.get() !== null && !(switching.get() && conversationError.get() !== null);
  });
  return If(showContent, {
    true: () => (
      <section
        class={classes.conversationContent}
        data-pending={switching}
        inert={switching}
        aria-busy={switching}
      >
        <Transcript />
      </section>
    ),
    false: () => <ConversationLoading />,
  });
}
