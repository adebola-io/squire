import { Cell, If } from "retend";
import { Button, Loader } from "squire-ui";

import type { PluginModalMode, PluginModalStep } from "./PluginModal";

import classes from "./Plugins.module.css";

interface PluginModalActionsProps {
  isBusy: Cell<boolean>;
  onCancel: () => void;
  step: Cell<PluginModalStep>;
  mode: PluginModalMode;
}

export function PluginModalActions(props: PluginModalActionsProps) {
  const { isBusy, onCancel, step, mode } = props;
  const cancelDisabled = Cell.derived(() => isBusy.get() && step.get() !== "mcp-authorize");
  const idleLabel = Cell.derived(() => {
    switch (step.get()) {
      case "secrets":
        return "Add all";
      case "mcp-authorize":
        return "Sign in again";
      case "mcp-review":
        return "Add";
      default:
        return mode === "mcp" ? "Connect" : "Continue";
    }
  });
  // Show progress in the active button label.
  const busyLabel = Cell.derived(() => {
    switch (step.get()) {
      case "secrets":
        return "Installing…";
      case "mcp-authorize":
        return "Waiting for sign-in…";
      case "mcp-review":
        return "Adding…";
      default:
        return mode === "mcp" ? "Connecting…" : "Installing…";
    }
  });
  const submitLabel = Cell.derived(() => (isBusy.get() ? busyLabel.get() : idleLabel.get()));

  return (
    <div class={classes.modalActions}>
      <Button
        variant="outline"
        class={classes.modalActionButton}
        type="button"
        disabled={cancelDisabled}
        onClick={onCancel}
      >
        Cancel
      </Button>
      <Button
        class={classes.modalActionButton}
        type="submit"
        disabled={isBusy}
        data-busy={isBusy}
        aria-busy={isBusy}
      >
        <span class={classes.modalActionContent} title={submitLabel}>
          {If(isBusy, () => (
            <Loader class={classes.modalActionLoader} size="small" label={busyLabel} />
          ))}
          <span>{submitLabel}</span>
        </span>
      </Button>
    </div>
  );
}
