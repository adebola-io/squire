import { Popover } from "innate-ui";
import { Cell, type AsyncCell } from "retend";
import { Icon } from "squire-ui";

import classes from "./Activity.module.css";

interface ThreadActionsProps {
  title: AsyncCell<string>;
  onDelete: () => void;
}

/** Show secondary actions on hover or keyboard focus. */
export function ThreadActions(props: ThreadActionsProps) {
  const { title, onDelete } = props;
  const open = Cell.source(false);
  const label = Cell.derivedAsync(async (get) => `Actions for ${await get(title)}`);
  return (
    <Popover open={open} onOpenChange={(next) => open.set(next)} side="bottom" align="end">
      <Popover.Trigger>
        <button type="button" class={classes.threadActionsTrigger} title={label} aria-label={label}>
          <Icon name="threeDots" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Content class={classes.threadActionsMenu} showArrow={false}>
        <button
          type="button"
          class={classes.threadActionsDelete}
          onClick={() => {
            open.set(false);
            onDelete();
          }}
        >
          <Icon name="trash" aria-hidden="true" />
          Delete thread
        </button>
      </Popover.Content>
    </Popover>
  );
}
