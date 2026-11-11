import { Toggle as InnateToggle } from "innate-ui";
import { Cell, If } from "retend";
import type { JSX } from "retend/jsx-runtime";

import classes from "./Toggle.module.css";

type NativeInputProps = JSX.IntrinsicElements["input"];

interface ToggleProps extends Omit<NativeInputProps, "checked" | "type"> {
  on: JSX.ValueOrCellOrPromise<boolean>;
}

export function Toggle(props: ToggleProps) {
  const {
    on,
    class: className,
    disabled: disabledProp = false,
    onChange,
    title,
    ...nativeProps
  } = props;
  const inputRef = Cell.source<HTMLInputElement | null>(null);
  const label = title ?? "Toggle";

  const renderToggle = (value: boolean, disabled: boolean) => (
    <span class={classes.root}>
      <input
        {...nativeProps}
        ref={inputRef}
        class={classes.nativeInput}
        type="checkbox"
        checked={on}
        disabled={disabled}
        title={title}
        tabIndex={-1}
        aria-hidden="true"
        onChange={onChange}
      />
      <InnateToggle
        value={value}
        disabled={disabled}
        label={label as JSX.ValueOrCell<string>}
        class={[classes.input, className]}
        title={title}
        onChange={() => inputRef.peek()?.click()}
      />
    </span>
  );

  const renderValue = (value: boolean) =>
    If(disabledProp, {
      true: () => renderToggle(value, true),
      false: () => renderToggle(value, false),
    });

  return If(on, {
    true: () => renderValue(true),
    false: () => renderValue(false),
  });
}
