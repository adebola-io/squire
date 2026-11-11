import { Cell, For, If, onConnected } from "retend";
import type { JSX } from "retend/jsx-runtime";
import { Icon } from "squire-ui";

import type { ConversationMessage } from "@/platform/desktopEvents";
import { useChat } from "@/scopes/ChatScope";

import { messageText } from "./chatModel";
import { CopyButton } from "./CopyButton";
import { MessageAttachments } from "./MessageAttachments";
import { MessageEditor } from "./MessageEditor";
import { UserBubble } from "./UserBubble";

import classes from "./Chat.module.css";

interface UserMessageProps {
  message: Cell<ConversationMessage>;
  queued?: boolean;
  /** Additional row actions after Copy and Edit. */
  extraActions?: JSX.Children;
}

function useMessageActions(props: UserMessageProps) {
  const { message, queued = false } = props;
  const { snapshot, busy, edit, branch } = useChat();
  const editing = Cell.source(false);
  const draft = Cell.source("");
  const notRunning = Cell.derived(() => {
    return snapshot.get()?.conversation.executionStatus !== "running";
  });
  const canEdit = Cell.derived(() => {
    if (queued) {
      return true;
    }
    return snapshot.get() !== null && notRunning.get() && message.get().editable;
  });
  const canBranch = Cell.derived(() => {
    return !queued && notRunning.get();
  });
  const slots = Cell.derived(() => {
    const current = message.get();
    return [{ key: JSON.stringify([current.parts, current.attachments]), current }];
  });
  const editRef = Cell.source<HTMLElement | null>(null);
  // Restore focus to Edit when the editor closes.
  let returnFocus = false;

  const startEdit = () => {
    draft.set(messageText(message.get()));
    editing.set(true);
  };
  const cancelEdit = () => {
    returnFocus = true;
    editing.set(false);
  };
  const save = async () => {
    if (busy.get() || draft.get().trim() === "") {
      return;
    }
    if (await edit(message.get().id, draft.get(), queued)) {
      returnFocus = true;
      editing.set(false);
    }
  };
  const branchHere = () => {
    return branch(message.get().id);
  };
  const copyText = () => {
    return messageText(message.get());
  };

  onConnected(editRef, (button) => {
    if (returnFocus) {
      returnFocus = false;
      button.focus();
    }
  });

  return {
    editRef,
    busy,
    editing,
    draft,
    canEdit,
    canBranch,
    slots,
    startEdit,
    cancelEdit,
    save,
    branchHere,
    copyText,
  };
}

/**
 * A message from the user: its bubble, and under it the actions, which show while the pointer is
 * over the message or focus is inside it. Editing turns the bubble itself into the editor, in
 * place.
 *
 * A queued message, not yet sent, reads the same way: a dashed bubble keeps its actions in view,
 * in the same one row.
 */
export function UserMessage(props: UserMessageProps) {
  const { message, queued = false, extraActions } = props;
  const actions = useMessageActions({ message, queued });
  const messageId = Cell.derived(() => message.get().id);
  const { busy, editing, draft, canEdit, canBranch, slots } = actions;
  // A queued message has not been sent yet, so editing it only saves it.
  const submitLabel = queued ? "Save" : "Send";

  return (
    <div
      class={classes.userMessage}
      data-user-id={messageId}
      data-editing={editing}
      data-queued={queued}
    >
      {For(
        slots,
        ({ current }) => {
          return <MessageAttachments message={current} />;
        },
        { key: "key" },
      )}
      {If(editing, {
        true: () => {
          return (
            <MessageEditor
              draft={draft}
              busy={busy}
              submitLabel={submitLabel}
              onSave={actions.save}
              onCancel={actions.cancelEdit}
            />
          );
        },
        false: () => {
          return (
            <>
              {For(
                slots,
                ({ current }) => {
                  return <UserBubble text={messageText(current)} />;
                },
                { key: "key" },
              )}
              <div class={classes.messageActions}>
                <CopyButton text={actions.copyText} label="Copy message" />
                {If(canEdit, () => {
                  return (
                    <button
                      ref={actions.editRef}
                      type="button"
                      class={classes.actionButton}
                      disabled={busy}
                      onClick={actions.startEdit}
                      title="Edit message"
                      aria-label="Edit message"
                    >
                      <Icon name="edit" aria-hidden="true" />
                    </button>
                  );
                })}
                {If(canBranch, () => {
                  return (
                    <button
                      type="button"
                      class={classes.actionButton}
                      disabled={busy}
                      onClick={actions.branchHere}
                      title="Branch into a new chat from this message"
                      aria-label="Branch into a new chat from this message"
                    >
                      <Icon name="branch" aria-hidden="true" />
                    </button>
                  );
                })}
                {extraActions}
              </div>
            </>
          );
        },
      })}
    </div>
  );
}
