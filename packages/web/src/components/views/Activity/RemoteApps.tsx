import { Cell } from "retend";
import { Dialog, Icon } from "squire-ui";

import { AddApps } from "./RemoteAppsSections";
import type { RemoteAccessModel } from "./useRemoteAccess";

import classes from "./RemoteAccess.module.css";

interface RemoteAppsProps {
  remote: RemoteAccessModel;
}

/** Entry point to client-specific instructions, independent of OAuth grants. */
export function RemoteApps(props: RemoteAppsProps) {
  const { remote } = props;
  const open = Cell.source(false);
  const dialogId = `remote-apps-${crypto.randomUUID()}`;

  return (
    <Dialog id={dialogId} open={open} onOpenChange={(next) => open.set(next)}>
      <Dialog.Trigger>
        <button type="button" class={classes.banner}>
          <span class={classes.iconStack} aria-hidden="true">
            <span class={classes.stackTile}>
              <Icon name="plus" class={classes.stackIcon} />
            </span>
          </span>
          <span class={classes.bannerTitle}>Connect an app</span>
          <Icon name="caret" class={classes.bannerCaret} aria-hidden="true" />
        </button>
      </Dialog.Trigger>
      <Dialog.Content size="large">
        <div class={classes.sheet}>
          <header class={classes.sheetHead}>
            <Dialog.Title>Connect an app</Dialog.Title>
            <Dialog.Close variant="ghost" size="small" class={classes.sheetClose}>
              Close
            </Dialog.Close>
          </header>
          <Dialog.Description class={classes.lede}>
            Choose an app to see how to add Squire as a remote MCP server.
          </Dialog.Description>
          <AddApps remote={remote} />
        </div>
      </Dialog.Content>
    </Dialog>
  );
}
