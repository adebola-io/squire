import type { JSX } from "retend/jsx-runtime";
import { Dialog } from "squire-ui";

import classes from "./Onboarding.module.css";

interface SetupDialogProps {
  id: string;
  label: string;
  /** Closing the dialog continues to the next step. */
  onClose: () => void;
  /**
   * A fixed-height dialog whose list scrolls inside it, for steps with long lists. Without it the
   * dialog fits its content.
   */
  fill?: boolean;
  children: JSX.Children;
}

export function SetupDialog(props: SetupDialogProps) {
  const { id, label, onClose, fill = false, children } = props;
  return (
    <Dialog
      id={id}
      open={true}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Content size="larger" ariaLabel={label} class={classes.dialog}>
        {/* Our own column, so the scroll area never depends on how the dialog wraps children. */}
        <div class={[classes.frame, fill ? classes.fill : undefined]}>{children}</div>
      </Dialog.Content>
    </Dialog>
  );
}
