import { Textarea as InnateTextarea } from "innate-ui";

import classes from "./Textarea.module.css";

type InnateTextareaProps = Parameters<typeof InnateTextarea>[0];

interface TextareaProps extends InnateTextareaProps {
  class?: InnateTextareaProps["class"];
}

export function Textarea(props: TextareaProps) {
  const { class: className, ...rest } = props;
  return <InnateTextarea {...rest} class={[classes.textarea, className]} />;
}
export type { TextareaProps };
