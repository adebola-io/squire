import { Cell, If } from "retend";
import { Toggle } from "squire-ui";

import { useInstantSwitch } from "./instantSwitchState";

import classes from "./Providers.module.css";

interface InstantSwitchProps {
  label: string | Cell<string>;
  hint?: string;
  /** The saved value. */
  on: Cell<boolean>;
  /** Persist a change and revert the displayed value if saving fails. */
  save: (next: boolean) => Promise<void>;
  /** Hide the label when the surrounding row already identifies the setting. */
  compact?: boolean;
}

/**
 * Save toggles optimistically. Disable repeated changes while saving, then reconcile with the
 * saved value and display any error.
 */
export function InstantSwitch(props: InstantSwitchProps) {
  const { label, hint, on, save, compact = false } = props;
  const { shown, pending, error: saveError, flip } = useInstantSwitch(on, save);
  const labelText = Cell.derived(() => {
    return typeof label === "string" ? label : label.get();
  });

  const error = Cell.derived(() => {
    const failure = saveError.get();
    if (failure === null) return null;
    return failure instanceof Error ? failure.message : `Couldn't change "${labelText.get()}".`;
  });
  const toggle = () => {
    void flip();
  };

  return (
    <div class={classes.switchRow} data-compact={compact} aria-busy={pending}>
      {If(!compact, () => {
        return (
          <span class={classes.switchText}>
            <span title={labelText}>{labelText}</span>
            {If(hint !== undefined, () => {
              return (
                <span class={classes.fieldHint} title={hint}>
                  {hint}
                </span>
              );
            })}
          </span>
        );
      })}
      <Toggle
        on={shown}
        title={labelText}
        aria-label={labelText}
        disabled={pending}
        onChange={toggle}
      />
      {If(error, (message) => {
        return (
          <p class={classes.switchError} role="alert" title={message}>
            {message}
          </p>
        );
      })}
    </div>
  );
}
