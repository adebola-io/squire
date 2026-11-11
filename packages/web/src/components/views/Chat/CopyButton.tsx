import { Cell, If, onSetup } from "retend";
import { Icon } from "squire-ui";

import classes from "./Chat.module.css";

/** Duration of the copied-state indicator. */
const COPIED_MS = 1500;

interface CopyButtonProps {
  /** Read on click to copy the latest text. */
  text: () => string;
  label: string;
}

/** Copy text and show a checkmark on success. */
export function CopyButton(props: CopyButtonProps) {
  const { text, label } = props;
  const copied = Cell.source(false);
  const title = Cell.derived(() => {
    return copied.get() ? "Copied" : label;
  });
  let timer = 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
    } catch {
      // Do not show success if clipboard access fails.
      return;
    }
    copied.set(true);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      copied.set(false);
    }, COPIED_MS);
  };

  onSetup(() => {
    return () => {
      window.clearTimeout(timer);
    };
  });

  return (
    <button
      type="button"
      class={classes.actionButton}
      title={title}
      aria-label={title}
      data-done={copied}
      onClick={copy}
    >
      {If(copied, {
        true: () => {
          return <Icon name="checkmark" aria-hidden="true" />;
        },
        false: () => {
          return <Icon name="copy" aria-hidden="true" />;
        },
      })}
    </button>
  );
}
