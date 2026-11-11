import { Cell, If } from "retend";
import { Button, Dialog, Icon } from "squire-ui";

import { useWorkspaceState } from "@/scopes/WorkspaceScope";

import { WorkspaceFileExplorerModal } from "./WorkspaceFileExplorerModal";

interface AddWorkspaceButtonProps {
  class?: string;
  showIcon?: boolean;
  label?: string;
}

export function AddWorkspaceButton(props: AddWorkspaceButtonProps) {
  const { class: className, showIcon = false, label = "Add Folder" } = props;
  const { addRoot, busyPath, error, clearError } = useWorkspaceState();
  const open = Cell.source(false);
  const dialogId = `add-workspace-${crypto.randomUUID()}`;
  const adding = Cell.derived(() => busyPath.get() === "add");
  const close = () => open.set(false);

  return (
    <Dialog id={dialogId} open={open} onOpenChange={(nextOpen) => open.set(nextOpen)}>
      <Dialog.Trigger onClick={clearError}>
        <Button variant="outline" class={className} type="button" disabled={adding}>
          {If(showIcon, () => (
            <Icon name="plus" aria-hidden="true" />
          ))}
          {label}
        </Button>
      </Dialog.Trigger>
      <Dialog.Content size="larger" ariaLabel="Choose a workspace folder">
        <WorkspaceFileExplorerModal
          addError={error}
          onClearError={clearError}
          adding={adding}
          onAdd={addRoot}
          onClose={close}
        />
      </Dialog.Content>
    </Dialog>
  );
}
