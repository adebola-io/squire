import { Cell, If } from "retend";
import type { AsyncCell, SourceCell } from "retend";
import { Dialog, Icon } from "squire-ui";

import {
  authorizeMcpPlugin,
  deletePlugin,
  setPluginActionEnabled,
  setPluginEnabled,
  waitForMcpCandidate,
} from "@/platform/desktopClient";
import type { DesktopPlugin } from "@/platform/desktopClient";

import { PluginDeleteModal } from "./PluginDeleteModal";

import classes from "./Plugins.module.css";

interface PluginDetailMenuProps {
  plugin: AsyncCell<DesktopPlugin | null>;
  menuOpen: SourceCell<boolean>;
  onDelete: () => void;
  onPluginUpdated: (plugin: DesktopPlugin) => void;
  onRevalidate: () => void;
}

function enabledWriteActions(plugin: DesktopPlugin) {
  return plugin.actions.filter((action) => action.mutative && action.enabled);
}

async function disableEnabledWriteActions(plugin: DesktopPlugin) {
  await Promise.all(
    enabledWriteActions(plugin).map((action) =>
      setPluginActionEnabled(plugin.id, action.name, false),
    ),
  );
}

function usePluginDetailMenu(props: PluginDetailMenuProps) {
  const { plugin, menuOpen, onDelete, onPluginUpdated, onRevalidate } = props;
  const deleteOpen = Cell.source(false);
  // Capture the plugin record used for both the deletion request and dialog label.
  const deleteTarget = Cell.source<DesktopPlugin | null>(null);
  const deletePluginName = Cell.derived(() => {
    return deleteTarget.get()?.name ?? null;
  });
  const toggleEnabled = Cell.task(async (_: unknown) => {
    const currentPlugin = await plugin.get();
    if (currentPlugin === null) return;
    const updated = await setPluginEnabled(currentPlugin.id, !currentPlugin.enabled);
    menuOpen.set(false);
    // The response is the updated plugin; apply it instead of refetching the index.
    onPluginUpdated(updated);
  });
  const deletePluginTask = Cell.task(async (pluginId: string): Promise<boolean> => {
    await deletePlugin(pluginId);
    menuOpen.set(false);
    onDelete();
    onRevalidate();
    return true;
  });
  const authorize = Cell.task(async (popup: Window | null) => {
    try {
      const currentPlugin = await plugin.get();
      if (currentPlugin === null) return;
      if (!popup) throw new Error("Allow pop-ups to authorize this Plugin.");
      const authorization = await authorizeMcpPlugin(currentPlugin.id);
      popup.location.href = authorization.authorizationUrl;
      await waitForMcpCandidate(authorization.candidateId, () => true);
      menuOpen.set(false);
      onRevalidate();
    } catch (error) {
      popup?.close();
      throw error;
    }
  });
  const disableWriteActions = Cell.task(async (_: unknown) => {
    const currentPlugin = await plugin.get();
    if (currentPlugin === null) return;
    await disableEnabledWriteActions(currentPlugin);
    menuOpen.set(false);
    onRevalidate();
  });
  const enabledLabel = Cell.derivedAsync(async (get) =>
    (await get(plugin))?.enabled ? "Disable" : "Enable",
  );
  const authorizable = Cell.derivedAsync(async (get) => (await get(plugin))?.oauth ?? false);
  const disabled = Cell.derived(
    () =>
      toggleEnabled.pending.get() ||
      authorize.pending.get() ||
      deletePluginTask.pending.get() ||
      disableWriteActions.pending.get(),
  );
  const error = Cell.derived(
    () =>
      toggleEnabled.error.get()?.message ??
      authorize.error.get()?.message ??
      deletePluginTask.error.get()?.message ??
      disableWriteActions.error.get()?.message ??
      null,
  );
  const deleteError = Cell.derived(() => deletePluginTask.error.get()?.message ?? null);

  const onToggleMenu = () => {
    menuOpen.set(!menuOpen.get());
  };

  const onToggleEnabled = () => {
    if (disabled.get()) return;
    toggleEnabled.runWith(null);
  };

  const onAuthorize = () => {
    if (disabled.get()) return;
    // Open the popup synchronously from the click, then navigate it when the authorization URL
    // returns.
    authorize.runWith(window.open("about:blank", "_blank"));
  };

  const openDeleteDialog = async () => {
    if (disabled.get()) return;
    const currentPlugin = await plugin.get();
    if (currentPlugin === null) return;
    menuOpen.set(false);
    deleteTarget.set(currentPlugin);
    deleteOpen.set(true);
  };

  const onRunDelete = () => {
    void openDeleteDialog();
  };

  const onCancelDelete = () => {
    if (deletePluginTask.pending.get()) return;
    deleteOpen.set(false);
  };

  const onConfirmDelete = async () => {
    const pluginId = deleteTarget.get()?.id;
    if (pluginId === undefined || deletePluginTask.pending.get()) return;
    const deleted = await deletePluginTask.runWith(pluginId);
    if (deleted) deleteOpen.set(false);
  };

  const onDisableWriteActions = () => {
    if (disabled.get()) return;
    disableWriteActions.runWith(null);
  };

  return {
    enabledLabel,
    authorizable,
    disabled,
    error,
    deleteError,
    deleteOpen,
    deletePluginName,
    deleteBusy: deletePluginTask.pending,
    onToggleEnabled,
    onAuthorize,
    onDisableWriteActions,
    onDelete: onRunDelete,
    onCancelDelete,
    onConfirmDelete,
    onToggleMenu,
  };
}

export function PluginDetailMenu(props: PluginDetailMenuProps) {
  const { menuOpen } = props;
  const menu = usePluginDetailMenu(props);
  const deleteDialogId = `delete-plugin-${crypto.randomUUID()}`;

  return (
    <>
      <div class={classes.detailMenu}>
        <button
          class={classes.detailMenuButton}
          type="button"
          title="Plugin actions"
          aria-label="Plugin actions"
          aria-expanded={menuOpen}
          onClick={menu.onToggleMenu}
        >
          <Icon name="threeDots" aria-hidden="true" />
        </button>
        {If(menuOpen, () => (
          <PluginDetailMenuPopover menu={menu} />
        ))}
      </div>
      {If(menu.deletePluginName, (pluginName) => (
        <Dialog
          id={deleteDialogId}
          open={menu.deleteOpen}
          onOpenChange={(nextOpen) => menu.deleteOpen.set(nextOpen)}
        >
          <Dialog.Content size="medium" ariaLabel={`Delete ${pluginName}`}>
            <PluginDeleteModal
              pluginName={pluginName}
              isBusy={menu.deleteBusy}
              error={menu.deleteError}
              onCancel={menu.onCancelDelete}
              onConfirm={menu.onConfirmDelete}
            />
          </Dialog.Content>
        </Dialog>
      ))}
    </>
  );
}

interface PluginDetailMenuPopoverProps {
  menu: ReturnType<typeof usePluginDetailMenu>;
}

function PluginDetailMenuPopover(props: PluginDetailMenuPopoverProps) {
  const { menu } = props;
  const {
    enabledLabel,
    authorizable,
    disabled,
    error,
    onToggleEnabled,
    onAuthorize,
    onDisableWriteActions,
    onDelete,
  } = menu;

  return (
    <div class={classes.detailMenuPopover} role="menu">
      <button
        class={classes.detailMenuItem}
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={onToggleEnabled}
      >
        {enabledLabel}
      </button>
      {If(authorizable, () => (
        <button
          class={classes.detailMenuItem}
          type="button"
          role="menuitem"
          disabled={disabled}
          onClick={onAuthorize}
        >
          Authorize
        </button>
      ))}
      <button
        class={classes.detailMenuItem}
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={onDisableWriteActions}
      >
        Disable all write actions
      </button>
      <button
        class={classes.detailMenuItem}
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={onDelete}
      >
        Delete
      </button>
      {If(error, (message) => (
        <p class={classes.detailError} role="alert" title={message}>
          {message}
        </p>
      ))}
    </div>
  );
}
