import { Cell, onConnected } from "retend";
import { Icon } from "squire-ui";

import { MarketplaceInstallAction } from "@/components/views/Plugins/MarketplaceCardAction";
import {
  pluginIconUrl,
  type DesktopMarketplaceEntry,
  type DesktopPlugin,
} from "@/platform/desktopClient";
import { useColorScheme } from "@/scopes/ColorSchemeScope";

import classes from "./Onboarding.module.css";

interface InstalledChipProps {
  plugin: DesktopPlugin;
}

/** An installed plugin as a pill, with its icon, as in the Plugins design. */
export function InstalledChip(props: InstalledChipProps) {
  const { plugin } = props;
  const colorScheme = useColorScheme();
  const iconReady = Cell.source(false);
  const iconFailed = Cell.source(false);
  const imageRef = Cell.source<HTMLImageElement | null>(null);
  const icon = Cell.derived(() => pluginIconUrl(plugin.id, colorScheme.get()));
  icon.listen(() => {
    iconReady.set(false);
    iconFailed.set(false);
  });
  // A cached image may already be complete when the pill connects.
  onConnected(imageRef, (image) => {
    if (image.complete && image.naturalWidth > 0) iconReady.set(true);
  });
  return (
    <span class={classes.chip}>
      <span class={classes.chipIcon} data-ready={iconReady} data-failed={iconFailed}>
        <img
          ref={imageRef}
          src={icon}
          alt=""
          aria-hidden="true"
          onLoad={() => {
            iconFailed.set(false);
            iconReady.set(true);
          }}
          onError={() => {
            iconReady.set(false);
            iconFailed.set(true);
          }}
        />
        <Icon name="extension" class={classes.chipIconFallback} aria-hidden="true" />
      </span>
      {plugin.name}
    </span>
  );
}

interface MarketplaceRowProps {
  entry: DesktopMarketplaceEntry;
}

/** A plugin that can be added, with its always-visible install action. */
export function MarketplaceRow(props: MarketplaceRowProps) {
  const { entry } = props;
  const colorScheme = useColorScheme();
  const icon = Cell.derived(() => `${entry.iconUrl}?variant=${colorScheme.get()}`);
  return (
    <li>
      <img src={icon} alt="" />
      <div>
        <strong>{entry.manifest.name}</strong>
        <span>{entry.manifest.description}</span>
      </div>
      <MarketplaceInstallAction entry={entry} compact />
    </li>
  );
}
