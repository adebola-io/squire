import { Cell, For, If } from "retend";
import { Icon } from "squire-ui";

import type { ConversationMessage } from "@/platform/desktopEvents";
import { useChat } from "@/scopes/ChatScope";

import { UserMessage } from "./UserMessage";

import classes from "./Chat.module.css";

interface QueuedFollowUpsProps {
  /** Queued messages for the active turn. */
  queued: Cell<ConversationMessage[]>;
}

/**
 * Render queued follow-ups as user messages in queue order, with controls to remove a message
 * or send the queue immediately.
 */
export function QueuedFollowUps(props: QueuedFollowUpsProps) {
  const { queued } = props;
  return For(
    queued,
    (message) => {
      return <QueuedRow message={message} queued={queued} />;
    },
    { key: "id" },
  );
}

interface QueuedRowProps {
  /** Initial queued-message data. */
  message: ConversationMessage;
  queued: Cell<ConversationMessage[]>;
}

/** Read current queue data as messages are edited or removed. */
function QueuedRow(props: QueuedRowProps) {
  const { message, queued } = props;
  const { removeQueued, sendNow, busy } = useChat();
  const current = Cell.derived(() => {
    return queued.get().find((entry) => entry.id === message.id) ?? message;
  });
  // Show Send now on the final queued message because it applies to the entire queue.
  const last = Cell.derived(() => {
    const list = queued.get();
    return list.length > 0 && list[list.length - 1].id === message.id;
  });
  const remove = () => void removeQueued(message.id);
  const actions = (
    <>
      <button
        type="button"
        class={classes.actionButton}
        disabled={busy}
        onClick={remove}
        title="Remove queued message"
        aria-label="Remove queued message"
      >
        <Icon name="trash" aria-hidden="true" />
      </button>
      {If(last, () => {
        return (
          <button
            type="button"
            class={classes.actionButton}
            disabled={busy}
            onClick={() => void sendNow()}
            title="Send queued messages now"
            aria-label="Send queued messages now"
          >
            <Icon name="arrow" aria-hidden="true" />
          </button>
        );
      })}
    </>
  );

  return <UserMessage message={current} queued extraActions={actions} />;
}
