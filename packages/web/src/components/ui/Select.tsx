import type { JSX } from "retend/jsx-runtime";
import { Icon } from "squire-ui";

import classes from "./Select.module.css";

type SelectProps = JSX.IntrinsicElements["select"];

/** Native select with a shared decorative caret. */
export function Select(props: SelectProps) {
  const { class: className, children, ...rest } = props;
  return (
    <span class={classes.wrapper}>
      <select {...rest} class={[classes.select, className]}>
        {children}
      </select>
      <span class={classes.caret} aria-hidden="true">
        <Icon name="caret" />
      </span>
    </span>
  );
}
