import { Field as InnateField } from "innate-ui";

import classes from "./Field.module.css";

type InnateFieldProps = Parameters<typeof InnateField>[0];

interface FieldProps extends InnateFieldProps {
  class?: InnateFieldProps["class"];
}

function FieldRoot(props: FieldProps) {
  const { class: className, ...rest } = props;
  return <InnateField {...rest} class={[classes.field, className]} />;
}

type FieldParts = {
  Label: typeof InnateField.Label;
  Description: typeof InnateField.Description;
  ErrorMessage: typeof InnateField.ErrorMessage;
};

export const Field: typeof FieldRoot & FieldParts = Object.assign(FieldRoot, {
  Label: InnateField.Label,
  Description: InnateField.Description,
  ErrorMessage: InnateField.ErrorMessage,
});
export type { FieldProps };
