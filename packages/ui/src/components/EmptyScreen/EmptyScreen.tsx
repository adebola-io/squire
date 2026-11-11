import type { JSX } from "retend/jsx-runtime";

import { Icon, type IconName } from "../../icons";

import classes from "./EmptyScreen.module.css";

interface EmptyScreenProps {
  icon: JSX.ValueOrCellOrPromise<IconName>;
  text: JSX.ValueOrCellOrPromise<string>;
}

export function EmptyScreen(props: EmptyScreenProps) {
  const { icon, text } = props;

  return (
    <div class={classes.container}>
      <Icon class={classes.icon} name={icon} />
      <span>{text}</span>
    </div>
  );
}
