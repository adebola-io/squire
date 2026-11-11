import { Cell, If } from "retend";
import type { AsyncCell } from "retend";
import { Icon } from "squire-ui";

import { pluginIconUrl } from "@/platform/desktopClient";
import type { DesktopPlugin } from "@/platform/desktopClient";
import { useColorScheme } from "@/scopes/ColorSchemeScope";
import { pluralize } from "@/utils/misc";

import { PluginDetailMenu } from "./PluginDetailMenu";

import classes from "./Plugins.module.css";

interface PluginDetailHeaderProps {
  plugin: AsyncCell<DesktopPlugin | null>;
  /** Null for MCP plugins, which do not expose secrets here. */
  secretCount: AsyncCell<string | null>;
  onDelete: () => void;
  onPluginUpdated: (plugin: DesktopPlugin) => void;
  onRevalidate: () => void;
}

export function PluginDetailHeader(props: PluginDetailHeaderProps) {
  const { plugin, secretCount, onDelete, onPluginUpdated, onRevalidate } = props;
  const menuOpen = Cell.source(false);
  const colorScheme = useColorScheme();
  const name = Cell.derivedAsync(async (get) => (await get(plugin))?.name ?? "");
  const version = Cell.derivedAsync(async (get) => (await get(plugin))?.version ?? null);
  const description = Cell.derivedAsync(async (get) => (await get(plugin))?.description ?? "");
  const themeColor = Cell.derivedAsync(async (get) => (await get(plugin))?.themeColor ?? "");
  const disabled = Cell.derivedAsync(async (get) => !(await get(plugin))?.enabled);
  const actionCount = Cell.derivedAsync(async (get) =>
    pluralize((await get(plugin))?.actions.length ?? 0, "action", "actions"),
  );
  const iconUrl = Cell.derivedAsync(async (get) => {
    const id = (await get(plugin))?.id ?? "";
    return pluginIconUrl(id, await get(colorScheme));
  });

  return (
    <header class={classes.detailHeader}>
      <div class={classes.detailPlaceholder}>
        <span class={classes.detailIconFrame} style={{ color: themeColor }}>
          <img class={classes.detailIcon} src={iconUrl} alt="" aria-hidden="true" />
        </span>
        <div class={classes.detailText}>
          <div class={classes.detailTitleRow}>
            <h1 class={classes.detailTitle} title={name}>
              {name}
            </h1>
            {If(disabled, () => (
              <span class={classes.detailDisabledBadge}>disabled</span>
            ))}
          </div>
          <p class={classes.detailDescription} title={description}>
            {description}
          </p>
          <p class={classes.detailMeta}>
            {If(version, (value) => (
              <>
                <span title={`Version ${value}`}>v{value}</span>
                <span aria-hidden="true">•</span>
              </>
            ))}
            <Icon class={classes.detailMetaIcon} name="extension" aria-hidden="true" />
            <span title={actionCount}>{actionCount}</span>
            {If(secretCount, (count) => (
              <>
                <span aria-hidden="true">•</span>
                <Icon class={classes.detailMetaIcon} name="padlock" aria-hidden="true" />
                <span title={count}>{count}</span>
              </>
            ))}
          </p>
        </div>
      </div>
      <PluginDetailMenu
        plugin={plugin}
        menuOpen={menuOpen}
        onDelete={onDelete}
        onPluginUpdated={onPluginUpdated}
        onRevalidate={onRevalidate}
      />
    </header>
  );
}
