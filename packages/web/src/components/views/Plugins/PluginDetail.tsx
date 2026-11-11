import { Cell, If, Switch } from "retend";
import type { AsyncCell } from "retend";
import { Tabs } from "squire-ui";
import type { TabOption } from "squire-ui";

import type {
  DesktopMarketplaceEntry,
  DesktopPlugin,
  DesktopPluginSecretsResponse,
} from "@/platform/desktopClient";
import { usePluginState } from "@/scopes/PluginScope";
import { pluralize } from "@/utils/misc";

import { MarketplaceInstallAction } from "./MarketplaceCardAction";
import { MarketplaceOperationStatus } from "./MarketplaceOperationStatus";
import { PluginActionList } from "./PluginDetailActions";
import { PluginDetailHeader } from "./PluginDetailHeader";
import { PluginSecretList } from "./PluginDetailSecrets";
import { PluginOverview } from "./PluginOverview";

import classes from "./Plugins.module.css";

type PluginDetailTab = "overview" | "actions" | "secrets";

const pluginDetailTabs: TabOption<PluginDetailTab>[] = [
  { value: "overview", label: "Overview" },
  { value: "actions", label: "Actions" },
  { value: "secrets", label: "Secrets" },
];

type CuratedEntry = DesktopMarketplaceEntry & { installedVersion?: string | null };

interface CuratedOverviewProps {
  entry: CuratedEntry;
}

/** Overview for a curated install, including an update waiting for approval. */
function CuratedOverview(props: CuratedOverviewProps) {
  const { entry } = props;
  const description = entry.overview || entry.manifest.description;
  return (
    <>
      <PluginOverview
        description={description}
        version={entry.installedVersion ?? undefined}
        update={entry.update}
        categories={entry.categories}
        publishedAt={entry.publishedAt}
      />
      {If(Boolean(entry.update), () => (
        <div class={classes.marketplaceUpdate}>
          <MarketplaceInstallAction entry={entry} />
        </div>
      ))}
    </>
  );
}

interface PluginDetailProps {
  plugin: AsyncCell<DesktopPlugin | null>;
  /** Secrets loaded with the page so counts and rows render together. */
  secrets: AsyncCell<DesktopPluginSecretsResponse>;
  onSecretsRevalidate: () => void;
}

/** Create a fresh plugin page per selection so tabs and searches reset between plugins. */
export function PluginDetail(props: PluginDetailProps) {
  const { plugin, secrets, onSecretsRevalidate } = props;
  const { applyPlugin, clearSelection, revalidate, selectedMarketplaceEntry } = usePluginState();
  const tab = Cell.source<PluginDetailTab>("overview");
  const curatedEntry = Cell.derivedAsync(async (get) => {
    const current = await get(plugin);
    const entry = await get(selectedMarketplaceEntry);
    if (!current || !entry) return null;
    return current.id === entry.manifest.id && current.runtime === entry.manifest.runtime
      ? { ...entry, installedVersion: current.version }
      : null;
  });
  const runtime = Cell.derivedAsync(async (get) => (await get(plugin))?.runtime ?? "wasm");
  // Fetch secrets only for WebAssembly plugins. MCP plugins use connection credentials and have
  // no Secrets tab.
  const isMcp = Cell.derivedAsync(async (get) => (await get(runtime)) === "mcp");
  const mcpDetailTabs = pluginDetailTabs.filter((item) => item.value !== "secrets");
  const detailDisabled = Cell.derivedAsync(async (get) => !(await get(plugin))?.enabled);
  const secretCount = Cell.derivedAsync(async (get): Promise<string | null> => {
    if (await get(isMcp)) return null;
    const count = (await get(secrets)).secrets.filter((secret) => secret.configured).length;
    return `${pluralize(count, "secret", "secrets")} configured`;
  });

  return (
    <section class={classes.plugins}>
      <div class={classes.detailContent} data-disabled={detailDisabled} data-runtime={runtime}>
        <button class={classes.backButton} type="button" onClick={clearSelection}>
          ← Plugins
        </button>
        <PluginDetailHeader
          plugin={plugin}
          secretCount={secretCount}
          onDelete={clearSelection}
          onPluginUpdated={applyPlugin}
          onRevalidate={revalidate}
        />
        {If(plugin, (item) => (
          <MarketplaceOperationStatus integrationId={item.id} />
        ))}
        {If(isMcp, {
          true: () => (
            <Tabs
              class={classes.detailTabs}
              value={tab}
              onChange={(value) => tab.set(value)}
              tabs={mcpDetailTabs}
              label="Plugin detail"
            />
          ),
          false: () => (
            <Tabs
              class={classes.detailTabs}
              value={tab}
              onChange={(value) => tab.set(value)}
              tabs={pluginDetailTabs}
              label="Plugin detail"
            />
          ),
        })}
        {Switch(tab, {
          overview: () =>
            If(curatedEntry, {
              true: (entry) => <CuratedOverview entry={entry} />,
              false: () =>
                If(plugin, (item) => (
                  <PluginOverview
                    description={item.description}
                    version={item.version ?? undefined}
                  />
                )),
            }),
          actions: () => <PluginActionList plugin={plugin} onPluginUpdated={applyPlugin} />,
          secrets: () => (
            <PluginSecretList
              plugin={plugin}
              secretsResponse={secrets}
              onSecretsRevalidate={onSecretsRevalidate}
            />
          ),
        })}
      </div>
    </section>
  );
}
