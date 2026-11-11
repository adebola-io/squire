import { Cell, If, onConnected, type SourceCell } from "retend";
import { Icon } from "squire-ui";

import { AppLink } from "@/components/ui/AppLink";
import { deleteConversation, renameConversation } from "@/platform/desktopClient";
import type { DesktopConversation } from "@/platform/desktopEvents";
import { chatPath, useChat } from "@/scopes/ChatScope";
import { renameFieldKeyDown, selectFieldText } from "@/utils/renameField";

import { plainPreview } from "./chatModel";
import { HistoryRowMenu } from "./HistoryRowMenu";

import classes from "./Chat.module.css";

interface HistoryRowProps {
  /** Initial row data used as a fallback. */
  initial: DesktopConversation;
  /** Current conversation list, including live updates. */
  conversations: Cell<DesktopConversation[]>;
  browserConversations: Cell<Set<string>>;
}

function useHistoryRow(conversation: Cell<DesktopConversation>) {
  const titleDraft = Cell.source(conversation.get().title);
  const renaming = Cell.source(false);
  const rowRef = Cell.source<HTMLElement | null>(null);
  // Restore focus to the row after renaming.
  let returnFocus = false;
  const rename = Cell.task(async () => {
    await renameConversation(conversation.get().id, titleDraft.get().trim());
    returnFocus = true;
    renaming.set(false);
  });
  const remove = Cell.task(async () => {
    // Delete immediately without a sidebar lifecycle timer.
    await deleteConversation(conversation.get().id);
  });
  const { selectedId } = useChat();
  const isSelected = Cell.derived(() => {
    return selectedId.get() === conversation.get().id;
  });
  const title = Cell.derived(() => {
    return conversation.get().title || "New Chat";
  });
  const preview = Cell.derived(() => {
    return plainPreview(conversation.get().preview ?? "");
  });
  const isRunning = Cell.derived(() => {
    return conversation.get().executionStatus === "running";
  });
  // Use a spinner while running and an unread dot after execution finishes.
  const showUnread = Cell.derived(() => {
    return !isRunning.get() && conversation.get().unread;
  });
  const actionsTitle = Cell.derived(() => {
    return `Actions for ${title.get()}`;
  });
  const ariaCurrent = Cell.derived(() => {
    return isSelected.get() ? "page" : undefined;
  });

  const startRename = () => {
    titleDraft.set(conversation.get().title);
    renaming.set(true);
  };
  const cancelRename = () => {
    returnFocus = true;
    renaming.set(false);
  };
  // Save on Enter or blur. Exit unchanged for an empty or unmodified title.
  const saveTitle = () => {
    if (!renaming.get() || rename.pending.get()) {
      return;
    }
    const next = titleDraft.get().trim();
    if (next === "" || next === conversation.get().title) {
      returnFocus = true;
      renaming.set(false);
      return;
    }
    void rename.runWith(null);
  };
  const deleteChat = () => {
    if (!remove.pending.get()) {
      void remove.runWith(null);
    }
  };

  onConnected(rowRef, (row) => {
    if (returnFocus) {
      returnFocus = false;
      row.focus();
    }
  });

  return {
    rowRef,
    titleDraft,
    renaming,
    rename,
    remove,
    ariaCurrent,
    isSelected,
    title,
    preview,
    isRunning,
    showUnread,
    actionsTitle,
    startRename,
    cancelRename,
    saveTitle,
    deleteChat,
  };
}

/** Chat history row with inline title editing. */
export function HistoryRow(props: HistoryRowProps) {
  const { initial, conversations, browserConversations } = props;
  const conversation = Cell.derived(() => {
    const current = conversations.get().find((item) => {
      return item.id === initial.id;
    });
    return current ?? initial;
  });
  const row = useHistoryRow(conversation);
  const hasBrowser = Cell.derived(() => browserConversations.get().has(initial.id));
  const { renaming, remove, isSelected, title, preview, isRunning, showUnread } = row;
  // Derive the link from the stable conversation ID.
  const href = chatPath(initial.id);

  return (
    <li class={classes.historyItem} data-renaming={renaming}>
      {If(renaming, {
        true: () => {
          return (
            <TitleField
              draft={row.titleDraft}
              preview={preview}
              pending={row.rename.pending}
              error={row.rename.error}
              onSave={row.saveTitle}
              onCancel={row.cancelRename}
            />
          );
        },
        false: () => {
          return (
            <HistoryRowMenu
              title={row.actionsTitle}
              pending={remove.pending}
              error={remove.error}
              onRename={row.startRename}
              onDelete={row.deleteChat}
            >
              <AppLink
                ref={row.rowRef}
                href={href}
                class={classes.historyButton}
                data-selected={isSelected}
                aria-current={row.ariaCurrent}
                aria-disabled={remove.pending}
              >
                <span class={classes.historyTitle} title={title}>
                  <span class={classes.historyTitleText}>{title}</span>
                  <span class={classes.historyIndicators}>
                    {If(isRunning, () => (
                      <span class={classes.historyStatus} title="Working">
                        <Icon name="spinner" class={classes.historySpinner} aria-hidden="true" />
                        <span class={classes.srOnly}>Working</span>
                      </span>
                    ))}
                    {If(showUnread, () => (
                      <span class={classes.unreadMark} title="Unread">
                        <span class={classes.srOnly}>Unread</span>
                      </span>
                    ))}
                    {If(hasBrowser, () => (
                      <span
                        class={classes.historyBrowser}
                        title="Browser active"
                        aria-label="Browser active"
                      >
                        <Icon name="browser" aria-hidden="true" />
                        <span class={classes.historyBrowserDot} />
                      </span>
                    ))}
                  </span>
                </span>
                <span class={classes.historyPreview} title={preview}>
                  {preview}
                </span>
              </AppLink>
            </HistoryRowMenu>
          );
        },
      })}
    </li>
  );
}

interface TitleFieldProps {
  draft: SourceCell<string>;
  preview: Cell<string>;
  pending: Cell<boolean>;
  error: Cell<Error | null>;
  onSave: () => void;
  onCancel: () => void;
}

/** Title editor sized to match the history row. */
function TitleField(props: TitleFieldProps) {
  const { draft, preview, pending, error, onSave, onCancel } = props;
  const inputRef = Cell.source<HTMLInputElement | null>(null);
  const detail = Cell.derived(() => {
    return error.get()?.message ?? preview.get();
  });

  // Enter saves and blurs; Escape cancels and blurs. Keep submit and blur as save fallbacks.
  const onKeyDown = renameFieldKeyDown({ onCommit: onSave, onCancel });

  // Focus on the next animation frame, after the closing menu restores focus to its trigger.
  onConnected(inputRef, (input) => {
    const frame = window.requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  });

  return (
    <form
      class={[classes.historyButton, classes.historyRename]}
      onSubmit--prevent={onSave}
      aria-busy={pending}
    >
      <span class={classes.historyTitle}>
        <input
          ref={inputRef}
          class={classes.historyTitleInput}
          value={draft}
          aria-label="Chat title"
          disabled={pending}
          onInput={(event) => {
            draft.set((event.currentTarget as HTMLInputElement).value);
          }}
          onFocus={selectFieldText}
          onKeyDown={onKeyDown}
          onBlur={onSave}
        />
      </span>
      <span class={classes.historyPreview} data-error={error} title={detail}>
        {detail}
      </span>
    </form>
  );
}
