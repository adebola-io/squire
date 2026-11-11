import { If } from "retend";
import { JSX } from "retend/jsx-runtime";

import classes from "./Modal.module.css";

interface ModalHeadingProps {
  title: JSX.Template;
  subtitle?: JSX.Template;
}

export function ModalHeading(props: ModalHeadingProps) {
  const { title, subtitle } = props;

  return (
    <div class={classes.modalHeading}>
      <h1>{title}</h1>
      {If(!!subtitle, () => (
        <p>{subtitle}</p>
      ))}
    </div>
  );
}
