import { Textarea } from "innate-ui";
import { Cell, onConnected, type SourceCell } from "retend";

import classes from "./Chat.module.css";

interface MessageEditorProps {
  draft: SourceCell<string>;
  busy: Cell<boolean>;
  submitLabel: string;
  onSave: () => Promise<void>;
  onCancel: () => void;
}

/**
 * The bubble, editable in place: same spot, same surface. The field sizes to its text with CSS
 * `field-sizing`, growing only as the text does and wrapping at the bubble's cap. Cancel and Send
 * sit under it. Enter sends, Shift+Enter inserts a newline, and Escape cancels.
 */
export function MessageEditor(props: MessageEditorProps) {
  const { draft, busy, submitLabel, onSave, onCancel } = props;
  const inputRef = Cell.source<HTMLTextAreaElement | null>(null);
  const submitDisabled = Cell.derived(() => {
    return busy.get() || draft.get().trim() === "";
  });
  const onKeyDown = (event: KeyboardEvent) => {
    // Keys pressed while an input method is composing belong to it: Escape dismisses the
    // candidate list and Enter confirms it.
    if (event.isComposing) {
      return;
    }
    if (event.key === "Escape") {
      onCancel();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    // Enter sends; Shift+Enter keeps the textarea's newline.
    event.preventDefault();
    (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
  };

  // Place the caret at the end when editing starts.
  onConnected(inputRef, (input) => {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });

  return (
    <form class={classes.editForm} onSubmit--prevent={onSave} aria-busy={busy}>
      <div class={[classes.userBubble, classes.editBubble]}>
        <Textarea
          ref={inputRef}
          class={classes.editInput}
          value={draft}
          rows={1}
          aria-label="Edit message"
          disabled={busy}
          onInput={(event) => {
            draft.set((event.currentTarget as HTMLTextAreaElement).value);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div class={classes.editActions}>
        <button
          type="button"
          class={classes.editCancel}
          disabled={busy}
          onClick={onCancel}
          title="Cancel (Esc)"
        >
          Cancel
        </button>
        <button
          type="submit"
          class={classes.editSubmit}
          disabled={submitDisabled}
          title={`${submitLabel} (Enter)`}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
