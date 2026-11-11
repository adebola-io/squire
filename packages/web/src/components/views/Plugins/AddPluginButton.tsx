import { Menu } from "innate-ui";
import { Cell, Switch } from "retend";
import { Button, Dialog, Icon } from "squire-ui";

import { usePluginState } from "@/scopes/PluginScope";

import { PluginModal, type PluginModalMode } from "./PluginModal";

import classes from "./Plugins.module.css";

interface AddPluginButtonProps {
  label: string;
  class?: string;
}

export function AddPluginButton(props: AddPluginButtonProps) {
  const { label, class: className } = props;
  const { revalidate } = usePluginState();
  const open = Cell.source(false);
  const mode = Cell.source<PluginModalMode>("package");
  const dialogId = `add-plugin-${crypto.randomUUID()}`;
  const close = () => open.set(false);

  const openFlow = (nextMode: PluginModalMode) => {
    mode.set(nextMode);
    open.set(true);
  };

  return (
    <>
      <div class={classes.addPluginMenu}>
        <Menu align="end">
          <Menu.Trigger>
            <Button variant="outline" class={[classes.addPluginTrigger, className]} type="button">
              <span>{label}</span>
              <Icon name="caret" aria-hidden="true" />
            </Button>
          </Menu.Trigger>
          <Menu.Content>
            <Menu.Item onClick={() => openFlow("mcp")}>
              <Menu.Item.Start>
                <Icon name="mcp" aria-hidden="true" />
              </Menu.Item.Start>
              Add MCP connector
            </Menu.Item>
            <Menu.Item onClick={() => openFlow("package")}>
              <Menu.Item.Start>
                <Icon name="upload" aria-hidden="true" />
              </Menu.Item.Start>
              Import ZIP file
            </Menu.Item>
          </Menu.Content>
        </Menu>
      </div>
      <Dialog id={dialogId} open={open} onOpenChange={(nextOpen) => open.set(nextOpen)}>
        <Dialog.Content size="larger" class={classes.addPluginDialog} ariaLabel="Add plugins">
          {Switch(mode, {
            package: () => <PluginModal mode="package" onCancel={close} onInstalled={revalidate} />,
            mcp: () => <PluginModal mode="mcp" onCancel={close} onInstalled={revalidate} />,
          })}
        </Dialog.Content>
      </Dialog>
    </>
  );
}
