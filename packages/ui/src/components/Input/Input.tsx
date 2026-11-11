import { Input as InnateInput } from "innate-ui";
import type { JSX } from "retend/jsx-runtime";

import classes from "./Input.module.css";

type InputType = JSX.InputTypeHTMLAttribute;
type InnateInputProps<T extends InputType> = Parameters<typeof InnateInput<T>>[0];

interface InputProps<T extends InputType> extends InnateInputProps<T> {
  class?: InnateInputProps<T>["class"];
  autoComplete?: string;
}

export function Input<T extends InputType>(props: InputProps<T>) {
  const { class: className, ...rest } = props;
  return <InnateInput {...(rest as InnateInputProps<T>)} class={[classes.input, className]} />;
}
export type { InputProps };
