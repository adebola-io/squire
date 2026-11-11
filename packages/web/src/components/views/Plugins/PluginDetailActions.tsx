import { Cell, For } from "retend";
import type { AsyncCell } from "retend";
import { FadeScroll } from "squire-ui";

import type { DesktopPlugin } from "@/platform/desktopClient";

import { PluginActionRow } from "./PluginActionRow";
import { PluginDetailPanelHeader } from "./PluginDetailPanelHeader";

import classes from "./Plugins.module.css";

interface PluginActionListProps {
  plugin: AsyncCell<DesktopPlugin | null>;
  onPluginUpdated: (plugin: DesktopPlugin) => void;
}

export function PluginActionList(props: PluginActionListProps) {
  const { plugin, onPluginUpdated } = props;
  const search = Cell.source("");
  const pluginId = Cell.derivedAsync(async (get) => (await get(plugin))?.id ?? "");
  const actions = Cell.derivedAsync(async (get) => {
    const query = get(search).trim().toLowerCase();
    const pluginValue = await get(plugin);
    const pluginActions = pluginValue?.actions ?? [];
    if (query === "") return pluginActions;
    return pluginActions.filter((action) =>
      [action.name, action.description, action.id, ...action.args]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  });

  return (
    <div class={classes.detailPanel}>
      <PluginDetailPanelHeader search={search} placeholder="Search actions" />
      <FadeScroll>
        <ul class={classes.detailList}>
          {For(
            actions,
            (item, index) => {
              // Retain the initial row value until `For` removes it from a shrinking list.
              const action = Cell.derivedAsync(
                async (get) => (await get(actions))[get(index)] ?? item,
              );
              return (
                <PluginActionRow
                  pluginId={pluginId}
                  action={action}
                  onPluginUpdated={onPluginUpdated}
                />
              );
            },
            { key: "name" },
          )}
        </ul>
      </FadeScroll>
    </div>
  );
}
