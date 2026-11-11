import { Cell, If } from "retend";

import type { DesktopMarketplaceEntry } from "@/platform/desktopClient";
import { useColorScheme } from "@/scopes/ColorSchemeScope";
import { usePluginState } from "@/scopes/PluginScope";

import { MarketplaceInstallAction } from "./MarketplaceCardAction";
import { MarketplaceOperationStatus } from "./MarketplaceOperationStatus";
import { PluginOverview } from "./PluginOverview";

import classes from "./Plugins.module.css";

interface MarketplaceDetailProps {
  entry: DesktopMarketplaceEntry;
}

/** Browse a curated listing; installed plugins use the existing management page. */
export function MarketplaceDetail(props: MarketplaceDetailProps) {
  const { entry } = props;
  const { clearSelection } = usePluginState();
  const scheme = useColorScheme();
  const iconUrl = Cell.derived(() => `${entry.iconUrl}?variant=${scheme.get()}`);
  const typeLabel = entry.manifest.runtime === "wasm" ? "Plugin" : "MCP connector";
  const description = entry.overview || entry.manifest.description;

  return (
    <section class={classes.plugins}>
      <div class={classes.detailContent}>
        <button class={classes.backButton} type="button" onClick={clearSelection}>
          ← Plugins
        </button>
        <header class={classes.detailHeader}>
          <div class={classes.detailPlaceholder}>
            <span class={classes.detailIconFrame} style={{ color: entry.manifest.themeColor }}>
              <img class={classes.detailIcon} src={iconUrl} alt="" aria-hidden="true" />
            </span>
            <div class={classes.detailText}>
              <h1 class={classes.detailTitle}>{entry.manifest.name}</h1>
              <p class={classes.detailDescription}>{entry.manifest.description}</p>
              <p class={classes.detailMeta}>
                {If(Boolean(entry.manifest.version), () => (
                  <>
                    <span>v{entry.manifest.version}</span>
                    <span aria-hidden="true">·</span>
                  </>
                ))}
                <span>{typeLabel}</span>
              </p>
            </div>
          </div>
          <MarketplaceInstallAction entry={entry} />
        </header>
        <MarketplaceOperationStatus integrationId={entry.manifest.id} />
        <PluginOverview
          description={description}
          version={entry.manifest.version ?? undefined}
          categories={entry.categories}
          publishedAt={entry.publishedAt}
        />
      </div>
    </section>
  );
}
