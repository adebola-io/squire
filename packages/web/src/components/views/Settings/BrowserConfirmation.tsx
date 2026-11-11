import { If } from "retend";
import { Button, Dialog, ModalHeading } from "squire-ui";

import type { BrowserSettingsModel } from "./useBrowserSettings";

import browserClasses from "./BrowserSettings.module.css";
import deletion from "./DataDeletionSettings.module.css";
import classes from "./SettingsEditor.module.css";

interface ConfirmationProps {
  model: BrowserSettingsModel;
}
export function BrowserConfirmation(props: ConfirmationProps) {
  const { model } = props;
  return (
    <Dialog
      id="browser-data-confirmation"
      open={model.open}
      onOpenChange={(next) => {
        if (!next) {
          model.close();
        }
      }}
    >
      <Dialog.Content size="medium" class={deletion.dialogContent} ariaLabel={model.dialogTitle}>
        <div class={deletion.dialog} aria-busy={model.busy}>
          <div class={deletion.intro}>
            <ModalHeading title={model.dialogTitle} subtitle={model.warning} />
          </div>
          {If(model.error, (message) => {
            return (
              <p class={classes.error} role="alert">
                {message}
              </p>
            );
          })}
          <div class={[deletion.actions, browserClasses.actions]}>
            <Button
              variant="outline"
              class={[classes.saveButton, browserClasses.action]}
              disabled={model.busy}
              onClick={model.close}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              class={[classes.saveButton, browserClasses.action]}
              disabled={model.busy}
              onClick={model.confirm}
            >
              {model.confirmLabel}
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  );
}
