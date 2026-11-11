import { FadeScroll as InnateFadeScroll } from "innate-ui";
import { Cell } from "retend";
import type { JSX } from "retend/jsx-runtime";

import classes from "./FadeScroll.module.css";

type FadeScrollDirection = "horizontal" | "vertical";

interface FadeScrollProps extends Omit<JSX.BaseContainerProps, "ref"> {
  direction?: JSX.ValueOrCell<FadeScrollDirection>;
  ref?: Cell<HTMLElement | null>;
}

export function FadeScroll(props: FadeScrollProps) {
  const {
    ref = Cell.source<HTMLElement | null>(null),
    direction = "vertical",
    class: className,
    children,
    ...rest
  } = props;

  return (
    <InnateFadeScroll
      {...rest}
      ref={ref}
      direction={direction}
      class={[classes.container, className]}
    >
      {children}
    </InnateFadeScroll>
  );
}
