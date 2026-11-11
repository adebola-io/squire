import { Cell, If } from "retend";
import { Button, Dialog, ModalHeading } from "squire-ui";

import {
  deleteAllConversations,
  deleteAllPlugins,
  deleteAllThreads,
} from "@/platform/desktopClient";
import type { BulkDeleteResult } from "@/platform/desktopClient";

import { SettingRow } from "./SettingRow";

import classes from "./DataDeletionSettings.module.css";
import editorClasses from "./SettingsEditor.module.css";

interface DeleteSettingProps {
  title: string;
  hint: string;
  warning: string;
  action: () => Promise<BulkDeleteResult>;
  unit: string;
}

function DeleteSetting(props: DeleteSettingProps) {
  const { title, hint, warning, action, unit } = props;
  const open = Cell.source(false);
  const confirmation = Cell.source("");
  const success = Cell.source<string | null>(null);
  const deletion = Cell.task(action);
  const canDelete = Cell.derived(() => confirmation.get() === "DELETE" && !deletion.pending.get());
  const cannotDelete = Cell.derived(() => !canDelete.get());
  const submitLabel = Cell.derived(() => (deletion.pending.get() ? "Deleting…" : title));
  const dialogId = `delete-all-${unit}-${crypto.randomUUID()}`;

  const setOpen = (next: boolean) => {
    if (deletion.pending.get()) return;
    open.set(next);
    confirmation.set("");
    if (next) {
      deletion.error.set(null);
      success.set(null);
    }
  };

  const confirm = async () => {
    if (!canDelete.get()) return;
    const result = await deletion.runWith(null);
    if (result != null) {
      success.set(`Deleted ${result.deleted} ${unit}.`);
      setOpen(false);
    }
  };

  return (
    <SettingRow
      label={title}
      hint={
        <>
          <p>{hint}</p>
          {If(success, (message) => (
            <p class={classes.success} role="status">
              {message}
            </p>
          ))}
        </>
      }
    >
      <Dialog id={dialogId} open={open} onOpenChange={setOpen}>
        <Dialog.Trigger>
          <Button type="button" variant="outline" class={classes.trigger}>
            {title}
          </Button>
        </Dialog.Trigger>
        <Dialog.Content size="medium" class={classes.dialogContent} ariaLabel={title}>
          <form class={classes.dialog} onSubmit--prevent={confirm} aria-busy={deletion.pending}>
            <div class={classes.intro}>
              <ModalHeading title={`${title}?`} subtitle={warning} />
            </div>
            <div class={classes.field}>
              <label class={classes.confirmLabel} for={`${dialogId}-confirm`}>
                Type DELETE to confirm
              </label>
              <input
                id={`${dialogId}-confirm`}
                class={classes.confirmInput}
                type="text"
                spellcheck={false}
                value={confirmation}
                onInput={(event: Event) =>
                  confirmation.set((event.currentTarget as HTMLInputElement).value)
                }
              />
            </div>
            {If(deletion.error, (failure) => (
              <p class={classes.error} role="alert">
                {failure.message}
              </p>
            ))}
            <div class={classes.actions}>
              <Button
                type="button"
                variant="outline"
                disabled={deletion.pending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="danger"
                class={classes.confirmDanger}
                disabled={cannotDelete}
              >
                {submitLabel}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog>
    </SettingRow>
  );
}

export function DataDeletionSettings() {
  return (
    <section class={editorClasses.group} aria-label="Delete data">
      <h2 class={editorClasses.groupHeading}>Delete data</h2>
      <div class={editorClasses.groupFields}>
        <DeleteSetting
          title="Delete all plugins"
          hint="Remove every installed plugin, its settings, credentials and stored data."
          warning="All installed plugins and their local data will be permanently removed. This cannot be undone."
          action={deleteAllPlugins}
          unit="plugins"
        />
        <DeleteSetting
          title="Delete all chats"
          hint="Remove all local chats, messages and their attachments."
          warning="All chats, messages and their attachments will be permanently removed. Active chats will be stopped before deletion. This cannot be undone."
          action={deleteAllConversations}
          unit="chats"
        />
        <DeleteSetting
          title="Delete all threads"
          hint="Remove external-agent thread history and recorded tool calls."
          warning="All recorded connection threads, tool calls and their saved results will be permanently removed. This does not sign you out. This cannot be undone."
          action={deleteAllThreads}
          unit="threads"
        />
      </div>
    </section>
  );
}
