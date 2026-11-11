import { Cell, If } from "retend";

import { pluginIconUrl } from "@/platform/desktopClient";
import type { DesktopMarketplaceEntry, DesktopPlugin } from "@/platform/desktopClient";
import { useColorScheme } from "@/scopes/ColorSchemeScope";
import { usePluginState } from "@/scopes/PluginScope";

import { MarketplaceInstallAction } from "./MarketplaceCardAction";

import classes from "./Plugins.module.css";

interface MarketplaceCardProps {
  entry: DesktopMarketplaceEntry;
}

type PluginCardProps = (DesktopPlugin & { entry?: never }) | MarketplaceCardProps;

export function PluginCard(props: PluginCardProps) {
  const { entry: marketplace = null } = props;
  const { selectPlugin, selectMarketplaceEntry } = usePluginState();
  const colorScheme = useColorScheme();
  const plugin = marketplace?.manifest ?? (props as DesktopPlugin);
  const { id, name, version, description, themeColor } = plugin;
  const enabled = marketplace ? true : (props as DesktopPlugin).enabled;
  const disabled = marketplace ? undefined : !enabled;
  const iconUrl = Cell.derived(() =>
    marketplace
      ? `${marketplace.iconUrl}?variant=${colorScheme.get()}`
      : pluginIconUrl(id, colorScheme.get()),
  );
  const open = () =>
    marketplace ? selectMarketplaceEntry(marketplace) : selectPlugin(props as DesktopPlugin);
  const action = marketplace ? <MarketplaceInstallAction entry={marketplace} compact /> : null;
  const cardClass = marketplace ? classes.marketplaceCard : undefined;

  return (
    <li class={cardClass}>
      <button
        class={classes.pluginCard}
        type="button"
        data-disabled={disabled}
        title={`Open ${name}`}
        aria-label={`Open ${name}`}
        onClick={open}
      >
        <span class={classes.pluginIconFrame} style={{ color: themeColor }}>
          <img class={classes.pluginIcon} src={iconUrl} alt="" aria-hidden="true" />
        </span>
        <span class={classes.pluginText}>
          <span class={classes.pluginNameRow}>
            <span class={classes.pluginName} title={name}>
              {name}
            </span>
            {If(Boolean(version), () => (
              <span class={classes.pluginVersion} title={`Version ${version}`}>
                v{version}
              </span>
            ))}
            {If(!enabled, () => (
              <span class={classes.pluginDisabled}>Disabled</span>
            ))}
          </span>
          <span class={classes.pluginDescription} title={description}>
            {description}
          </span>
        </span>
      </button>
      {action}
    </li>
  );
}
