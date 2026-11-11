import { Cell, If, Switch } from "retend";

import { LoadingState } from "@/components/ui/LoadingState";
import { PendingPage } from "@/components/ui/PendingPage";
import type { DesktopPluginSecretsResponse } from "@/platform/desktopClient";
import { PluginStateProvider, usePluginState } from "@/scopes/PluginScope";
import { usePageSwitch } from "@/utils/pageSwitch";

import { MarketplaceDetail } from "./MarketplaceDetail";
import { MarketplaceMcpDialogHost } from "./MarketplaceMcpConnect";
import { PluginDetail } from "./PluginDetail";
import { PluginsHome } from "./PluginsHome";

const LIST = "list";
const NO_SECRETS: DesktopPluginSecretsResponse = { secrets: [] };

/**
 * Switch between the plugin list and details after the selected plugin and secrets resolve.
 * Aggregate loading and errors with a composite; show errors instead of potentially stale data.
 */
function PluginsContent() {
  const {
    selectedPlugin,
    selectedPluginId,
    selectedMarketplaceEntry,
    selectedSecrets,
    plugins,
    revalidate,
    refreshSecrets,
  } = usePluginState();
  const page = Cell.composite({ plugins, plugin: selectedPlugin, secrets: selectedSecrets });
  const key = Cell.derived(() => {
    const id = selectedPluginId.get();
    return id === null ? LIST : `plugin:${id}`;
  });
  const { pageKey, switching } = usePageSwitch(key, async (get) => {
    // Await the selected inputs directly. Composite values may resolve unchanged, allowing the
    // secrets value to finish before the new plugin record.
    await get(selectedPlugin);
    await get(selectedSecrets);
    // Check the composite error before rendering because failed cells retain values from the
    // previous selection.
    const error = get(page.error);
    if (error !== null) {
      throw error;
    }
  });
  const secrets = Cell.derivedAsync(async (get) => {
    return (await get(selectedSecrets)) ?? NO_SECRETS;
  });
  const showPage = Cell.derived(() => page.loaded.get() && page.error.get() === null);
  const loadError = Cell.derived(() => page.error.get()?.message ?? null);
  const retry = () => {
    revalidate();
    refreshSecrets();
  };

  return If(showPage, {
    true: () => (
      <PendingPage switching={switching}>
        {Switch(pageKey, { [LIST]: () => <PluginsHome /> }, () =>
          If(
            Cell.derivedAsync(async (get) => (await get(selectedPlugin)) !== null),
            {
              true: () => (
                <PluginDetail
                  plugin={selectedPlugin}
                  secrets={secrets}
                  onSecretsRevalidate={refreshSecrets}
                />
              ),
              false: () =>
                If(selectedMarketplaceEntry, (entry) => <MarketplaceDetail entry={entry} />),
            },
          ),
        )}
      </PendingPage>
    ),
    false: () => (
      <LoadingState screen label="Fetching plugins…" error={loadError} onRetry={retry} />
    ),
  });
}

export function Plugins() {
  return (
    <PluginStateProvider>
      <PluginsContent />
      <MarketplaceMcpDialogHost />
    </PluginStateProvider>
  );
}
