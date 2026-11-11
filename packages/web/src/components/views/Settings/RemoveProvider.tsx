import { Cell, If } from "retend";
import type { AsyncCell } from "retend";
import type { JSX } from "retend/jsx-runtime";
import { useRouter } from "retend/router";
import { Button, Dialog, Icon } from "squire-ui";

import { deleteProvider } from "@/platform/desktopClient";
import type { DesktopProviderProfile } from "@/platform/desktopClient";
import { useChat } from "@/scopes/ChatScope";

import classes from "./Providers.module.css";

interface RemoveProviderProps {
  profile: DesktopProviderProfile;
  name: AsyncCell<string>;
}

interface ConfirmActions {
  run: () => void;
  cancel: () => void;
}

interface RemoveConfirmProps {
  label: string;
  heading: JSX.Template;
  copy: string;
  pending: Cell<boolean>;
  error: Cell<Error | null>;
  confirm: ConfirmActions;
}

function RemoveConfirm(props: RemoveConfirmProps) {
  const { label, heading, copy, pending, error, confirm } = props;
  return (
    <form class={classes.confirm} onSubmit--prevent={confirm.run} aria-busy={pending}>
      <div class={classes.dialogHeading}>
        <div>
          <Dialog.Title>{heading}</Dialog.Title>
          <Dialog.Description>{copy}</Dialog.Description>
        </div>
      </div>
      {If(error, (failure) => {
        return (
          <p class={classes.error} role="alert">
            {failure.message}
          </p>
        );
      })}
      <div class={classes.formFooter}>
        <span />
        <Button
          variant="ghost"
          type="button"
          class={classes.quietButton}
          disabled={pending}
          onClick={confirm.cancel}
        >
          Cancel
        </Button>
        <Button
          variant="danger"
          type="submit"
          class={[classes.submitButton, classes.dangerButton]}
          disabled={pending}
        >
          {label}
        </Button>
      </div>
    </form>
  );
}

/**
 * Confirm removal before deleting a provider and its key. Built-in providers remain listed;
 * removal clears only their credentials.
 */
export function RemoveProvider(props: RemoveProviderProps) {
  const { profile, name } = props;
  const { refreshProviders } = useChat();
  const router = useRouter();
  const open = Cell.source(false);
  const remove = Cell.task(async () => {
    await deleteProvider(profile.id);
    open.set(false);
    refreshProviders();
    if (!profile.builtin) {
      await router.navigate("/settings/providers");
    }
  });
  const dialogId = `remove-provider-${crypto.randomUUID()}`;
  const triggerLabel = profile.builtin ? "Remove key" : "Remove provider";

  const confirm = {
    run: () => {
      if (!remove.pending.get()) {
        void remove.runWith(null);
      }
    },
    cancel: () => {
      if (!remove.pending.get()) {
        open.set(false);
      }
    },
  };

  return (
    <Dialog
      id={dialogId}
      open={open}
      onOpenChange={(next) => {
        open.set(next);
      }}
    >
      <Dialog.Trigger>
        {/* Apply the destructive color to both the icon and label. */}
        <button type="button" class={classes.dangerTextButton} title={triggerLabel}>
          <Icon name="trash" aria-hidden="true" />
          {triggerLabel}
        </button>
      </Dialog.Trigger>
      <Dialog.Content size="medium" class={classes.dialog} ariaLabel={triggerLabel}>
        {If(profile.builtin, {
          true: () => {
            return (
              <RemoveConfirm
                label="Remove key"
                heading={<>Remove {profile.displayName} key?</>}
                copy="Its saved API key is deleted from this device. The provider stays in the list."
                pending={remove.pending}
                error={remove.error}
                confirm={confirm}
              />
            );
          },
          false: () => {
            return (
              <RemoveConfirm
                label="Remove"
                heading={<>Remove {name}?</>}
                copy="Its connection and saved API key are deleted from this device. Chats that used it stay in your history."
                pending={remove.pending}
                error={remove.error}
                confirm={confirm}
              />
            );
          },
        })}
      </Dialog.Content>
    </Dialog>
  );
}
