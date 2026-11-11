import { If } from "retend";
import type { JSX } from "retend/jsx-runtime";

import classes from "./ViewHeader.module.css";

interface ViewHeaderProps {
  title: JSX.ValueOrCellOrPromise<string>;
  subtitle?: JSX.ValueOrCellOrPromise<string>;
}

export function ViewHeader(props: ViewHeaderProps) {
  const { title, subtitle } = props;

  return (
    <div class={classes.viewHeader}>
      <h1 class={classes.title}>{title}</h1>
      {If(title, () => {
        return <p class={classes.subtitle}>{subtitle}</p>;
      })}
    </div>
  );
}
