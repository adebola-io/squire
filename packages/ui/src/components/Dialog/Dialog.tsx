import { Dialog as InnateDialog } from "innate-ui";
import type { DialogProps as InnateDialogProps } from "innate-ui";

import classes from "./Dialog.module.css";

export type DialogSize = "medium" | "large" | "larger";
type InnateDialogContentProps = Parameters<typeof InnateDialog.Content>[0];

interface DialogContentProps extends InnateDialogContentProps {
  size?: DialogSize;
}

function DialogRoot(props: InnateDialogProps) {
  return <InnateDialog {...props} />;
}

function DialogContent(props: DialogContentProps) {
  const { size = "medium", class: className, ...rest } = props;

  return <InnateDialog.Content {...rest} class={[classes.content, className]} data-size={size} />;
}

type DialogParts = {
  Actions: typeof InnateDialog.Actions;
  Close: typeof InnateDialog.Close;
  Content: typeof DialogContent;
  Description: typeof InnateDialog.Description;
  Title: typeof InnateDialog.Title;
  Trigger: typeof InnateDialog.Trigger;
};

export const Dialog: typeof DialogRoot & DialogParts = Object.assign(DialogRoot, {
  Actions: InnateDialog.Actions,
  Close: InnateDialog.Close,
  Content: DialogContent,
  Description: InnateDialog.Description,
  Title: InnateDialog.Title,
  Trigger: InnateDialog.Trigger,
});
