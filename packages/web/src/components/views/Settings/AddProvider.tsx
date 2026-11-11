import { Cell, If } from "retend";
import { useCurrentRoute, useRouter } from "retend/router";
import { Button, Dialog, Icon } from "squire-ui";

import type { DesktopProviderProfile } from "@/platform/desktopClient";

import { ProfileForm } from "./ProfileForm";

import classes from "./Providers.module.css";

interface AddProviderProps {
  label?: string;
}

/** Create a provider and open its model settings. */
export function AddProvider(props: AddProviderProps) {
  const { label = "Add provider" } = props;
  const router = useRouter();
  const open = Cell.source(false);
  const dialogId = `add-provider-${crypto.randomUUID()}`;
  const route = useCurrentRoute();

  const close = () => {
    open.set(false);
  };
  const added = (profile: DesktopProviderProfile) => {
    open.set(false);
    void router.navigate(`/settings/providers/${encodeURIComponent(profile.id)}`);
  };
  const setOpen = (next: boolean) => {
    open.set(next);
  };

  // Close the dialog on navigation, including links to an existing built-in provider.
  route.listen(() => {
    open.set(false);
  });

  return (
    <Dialog id={dialogId} open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button class={classes.primaryButton}>
          <Icon name="extension" aria-hidden="true" />
          {label}
        </Button>
      </Dialog.Trigger>
      <Dialog.Content size="larger" class={classes.dialog} ariaLabel="Add provider">
        <header class={classes.dialogHeading}>
          <div>
            <Dialog.Title>Add a provider</Dialog.Title>
            <Dialog.Description>
              Connect a model service or a local server to chat with.
            </Dialog.Description>
          </div>
          <button
            type="button"
            class={classes.iconButton}
            onClick={close}
            title="Close"
            aria-label="Close"
          >
            <Icon name="cancel" aria-hidden="true" />
          </button>
        </header>
        {If(open, () => {
          return <ProfileForm onSaved={added} onCancel={close} />;
        })}
      </Dialog.Content>
    </Dialog>
  );
}
