import { Cell, If } from "retend";
import type { AsyncCell } from "retend";
import { Icon, Toggle } from "squire-ui";

import { setPluginActionEnabled } from "@/platform/desktopClient";
import type { DesktopPlugin, DesktopPluginAction } from "@/platform/desktopClient";

import classes from "./Plugins.module.css";

interface PluginActionRowProps {
  pluginId: AsyncCell<string>;
  action: AsyncCell<DesktopPluginAction>;
  onPluginUpdated: (plugin: DesktopPlugin) => void;
}

export function PluginActionRow(props: PluginActionRowProps) {
  const { pluginId, action, onPluginUpdated } = props;
  const toggleAction = Cell.task(async (_: unknown) => {
    const [currentPluginId, currentAction] = await Promise.all([pluginId.get(), action.get()]);
    // The response is the updated plugin; apply it instead of refetching the index.
    onPluginUpdated(
      await setPluginActionEnabled(currentPluginId, currentAction.name, !currentAction.enabled),
    );
  });
  const name = Cell.derivedAsync(async (get) => (await get(action)).name);
  const description = Cell.derivedAsync(async (get) => (await get(action)).description);
  const mutative = Cell.derivedAsync(async (get) => (await get(action)).mutative);
  const enabled = Cell.derivedAsync(async (get) => (await get(action)).enabled);
  const label = Cell.derivedAsync(async (get) => ((await get(enabled)) ? "Disable" : "Enable"));
  const title = Cell.derivedAsync(async (get) => `${await get(label)} ${await get(name)}`);
  const error = Cell.derived(() => toggleAction.error.get()?.message ?? null);

  const runToggle = () => {
    if (toggleAction.pending.get()) return;
    toggleAction.runWith(null);
  };

  return (
    <li class={classes.detailRow} data-kind="action" aria-busy={toggleAction.pending}>
      <div class={classes.detailRowText}>
        <div class={classes.detailRowTitle}>
          <h2 title={name}>{name}</h2>
          {If(mutative, () => (
            <span class={classes.detailBadge}>write</span>
          ))}
        </div>
        <p title={description}>{description}</p>
        {If(error, (message) => (
          <p class={classes.detailError} role="alert" title={message}>
            {message}
          </p>
        ))}
      </div>
      <span class={classes.detailRowControl}>
        <span class={classes.detailLoadingSlot} aria-hidden="true">
          {If(toggleAction.pending, () => (
            <Icon class={classes.detailLoadingIcon} name="loading" />
          ))}
        </span>
        <Toggle
          class={classes.detailToggle}
          on={enabled}
          disabled={toggleAction.pending}
          title={title}
          aria-label={title}
          onChange={runToggle}
        />
      </span>
    </li>
  );
}
