import { If, type Cell } from "retend";
import { Button, ModalHeading } from "squire-ui";

import classes from "./Activity.module.css";

interface ThreadDeleteDialogProps {
  title: string;
  busy: Cell<boolean>;
  error: Cell<string | null>;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

/** Confirm permanent removal of a thread and its recorded tool calls. */
export function ThreadDeleteDialog(props: ThreadDeleteDialogProps) {
  const { title, busy, error, onCancel, onConfirm } = props;
  return (
    <form class={classes.threadDeleteForm} onSubmit--prevent={onConfirm}>
      <ModalHeading
        title="Delete thread?"
        subtitle={`“${title}” and its recorded tool calls will be permanently removed.`}
      />
      {If(error, (message) => (
        <p role="alert" class={classes.threadDeleteError}>
          {message}
        </p>
      ))}
      <div class={classes.threadDeleteActions}>
        <Button type="submit" variant="danger" disabled={busy}>
          Delete
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
