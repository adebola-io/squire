import { If } from "retend";
import type { Cell } from "retend";
import { Button, ModalHeading } from "squire-ui";

import classes from "./Plugins.module.css";

interface PluginDeleteModalProps {
  pluginName: string;
  isBusy: Cell<boolean>;
  error: Cell<string | null>;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

export function PluginDeleteModal(props: PluginDeleteModalProps) {
  const { pluginName, isBusy, error, onCancel, onConfirm } = props;

  return (
    <form class={classes.deletePluginModal} onSubmit--prevent={onConfirm}>
      <ModalHeading
        title="Delete this plugin?"
        subtitle={`This will remove ${pluginName} and clear its stored data.`}
      />
      {If(error, (message) => (
        <p class={classes.modalError} role="alert" title={message}>
          {message}
        </p>
      ))}
      <div class={classes.deletePluginActions}>
        <Button
          variant="danger"
          class={classes.deletePluginActionButton}
          type="submit"
          disabled={isBusy}
        >
          Delete
        </Button>
        <Button
          variant="outline"
          class={classes.deletePluginActionButton}
          type="button"
          disabled={isBusy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
