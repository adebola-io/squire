import {
  AsyncCell,
  type AsyncDerivedCell,
  Cell,
  createScope,
  onSetup,
  SourceCell,
  useScopeContext,
} from "retend";
import type { JSX } from "retend/jsx-runtime";
import { useCurrentRoute, useRouter } from "retend/router";

import {
  getCachedMarketplace,
  listInstalledPlugins,
  listMarketplaceOperations,
  listPluginSecrets,
  refreshMarketplace,
} from "@/platform/desktopClient";
import type {
  DesktopMarketplaceEntry,
  DesktopMarketplaceOperation,
  DesktopMarketplaceSnapshot,
  DesktopPlugin,
  DesktopPluginSecretsResponse,
} from "@/platform/desktopClient";
import { onDesktopEvent } from "@/scopes/DesktopEventsScope";

interface PluginState {
  marketplace: SourceCell<DesktopMarketplaceSnapshot>;
  retryMarketplace: () => Promise<void>;
  /** The listing whose MCP connection dialog is open. */
  mcpConnect: SourceCell<DesktopMarketplaceEntry | null>;
  operations: AsyncDerivedCell<DesktopMarketplaceOperation[]>;
  plugins: AsyncDerivedCell<DesktopPlugin[]>;
  filteredPlugins: AsyncCell<DesktopPlugin[]>;
  selectedPlugin: AsyncDerivedCell<DesktopPlugin | null>;
  selectedMarketplaceEntry: AsyncDerivedCell<DesktopMarketplaceEntry | null>;
  selectedPluginId: Cell<string | null>;
  selectedSecrets: AsyncDerivedCell<DesktopPluginSecretsResponse | null>;
  search: SourceCell<string>;
  libraryTab: SourceCell<"discover" | "installed">;
  /** The Discover group filter; `null` shows every group. */
  discoverGroup: SourceCell<string | null>;
  selectMarketplaceEntry: (entry: DesktopMarketplaceEntry) => void;
  revalidate: () => void;
  refreshSecrets: () => void;
  applyPlugin: (plugin: DesktopPlugin) => void;
  selectPlugin: (plugin: DesktopPlugin) => void;
  clearSelection: () => void;
}

interface PluginStateProviderProps {
  children: JSX.Children;
}

const PluginStateScope = createScope<PluginState>();

function pluginSearchText(plugin: DesktopPlugin) {
  return [
    plugin.name,
    plugin.version,
    plugin.description,
    plugin.id,
    ...plugin.actions.map((action) => action.name),
    ...plugin.actions.map((action) => action.description),
  ]
    .join(" ")
    .toLowerCase();
}

function useSelectedSecrets(
  selectedPluginId: Cell<string | null>,
  selectedPlugin: AsyncCell<DesktopPlugin | null>,
) {
  const runtime = Cell.derivedAsync(async (get) => (await get(selectedPlugin))?.runtime ?? null);
  return Cell.derivedAsync(async (get) => {
    const id = get(selectedPluginId);
    if (!id || (await get(runtime)) !== "wasm") return null;
    return listPluginSecrets(id);
  });
}

/**
 * Keeps the identity of entries whose content did not change, so their cards
 * and an open detail page are not rebuilt when another plugin's state changes.
 */
function shareUnchangedEntries(
  previous: DesktopMarketplaceSnapshot,
  next: DesktopMarketplaceSnapshot,
): DesktopMarketplaceSnapshot {
  if (!next.catalog) return next;
  const prior = new Map(previous.catalog?.entries.map((entry) => [entry.manifest.id, entry]));
  const entries = next.catalog.entries.map((entry) => {
    const old = prior.get(entry.manifest.id);
    return old && JSON.stringify(old) === JSON.stringify(entry) ? old : entry;
  });
  return { ...next, catalog: { ...next.catalog, entries } };
}

function useMarketplace() {
  const marketplace = Cell.source<DesktopMarketplaceSnapshot>({ catalog: null });
  const baselineOperations = Cell.derivedAsync(() => listMarketplaceOperations());
  const operationUpdates = Cell.source(new Map<string, DesktopMarketplaceOperation>());
  const operations = Cell.derivedAsync(async (get) => {
    const baseline = await get(baselineOperations);
    const updates = get(operationUpdates);
    const known = new Set(baseline.map((operation) => operation.id));
    return [
      ...baseline.map((operation) => updates.get(operation.id) ?? operation),
      ...[...updates.values()].filter((operation) => !known.has(operation.id)),
    ];
  });

  let disposed = false;
  onSetup(() => () => {
    disposed = true;
  });

  const load = async (remote: boolean) => {
    if (disposed) return;
    try {
      const snapshot = await (remote ? refreshMarketplace() : getCachedMarketplace());
      if (!disposed) marketplace.set(shareUnchangedEntries(marketplace.get(), snapshot));
    } catch {
      if (!disposed) {
        marketplace.set({ ...marketplace.get(), error: "Marketplace unavailable." });
      }
    }
  };
  // Loads run one at a time, so every response is newer than the one before it.
  let queue = Promise.resolve();
  const loadMarketplace = (remote = false) => (queue = queue.then(() => load(remote)));
  const retryMarketplace = () => loadMarketplace(true);
  const refreshInstalledStatus = () => loadMarketplace();
  onDesktopEvent("marketplace.operations", ({ operation }) => {
    const updated = new Map(operationUpdates.get());
    updated.delete(operation.id);
    updated.set(operation.id, operation);
    if (updated.size > 100) updated.delete(updated.keys().next().value!);
    operationUpdates.set(updated);
    // Even a rejected install can have fetched a changed release. Read the
    // complete projection once the operation settles, including on failure.
    if (["succeeded", "failed", "cancelled"].includes(operation.status))
      void refreshInstalledStatus();
  });
  const resyncOperations = () => {
    operationUpdates.set(new Map());
    baselineOperations.revalidate();
  };
  onDesktopEvent("connection.opened", resyncOperations);
  onDesktopEvent("resync", resyncOperations);
  onDesktopEvent("resync", () => void refreshInstalledStatus());
  onDesktopEvent("connection.opened", () => void refreshInstalledStatus());
  void loadMarketplace().then(retryMarketplace);

  return { marketplace, operations, retryMarketplace, refreshInstalledStatus };
}

function useInstalledPlugins(search: SourceCell<string>) {
  const updates = Cell.source(new Map<string, DesktopPlugin>());
  const pluginIndex = Cell.derivedAsync(() => listInstalledPlugins());
  const plugins = Cell.derivedAsync(async (get) => {
    const index = await get(pluginIndex);
    if (!index) throw get(pluginIndex.error) ?? new Error("Could not load plugins.");
    const overrides = get(updates);
    return index.plugins.map((plugin) => overrides.get(plugin.id) ?? plugin);
  });
  const searchablePlugins = Cell.derivedAsync(async (get) =>
    (await get(plugins)).map((plugin) => ({ plugin, text: pluginSearchText(plugin) })),
  );
  const filteredPlugins = Cell.derivedAsync(async (get) => {
    const query = get(search).trim().toLowerCase();
    if (!query) return get(plugins);
    return (await get(searchablePlugins))
      .filter((item) => item.text.includes(query))
      .map((item) => item.plugin);
  });
  const revalidate = () => {
    updates.set(new Map());
    pluginIndex.revalidate();
  };
  const applyPlugin = (plugin: DesktopPlugin) => {
    updates.set(new Map(updates.get()).set(plugin.id, plugin));
  };

  onDesktopEvent("plugins.changed", revalidate);
  onDesktopEvent("resync", revalidate);
  onDesktopEvent("connection.opened", revalidate);
  return { plugins, filteredPlugins, revalidate, applyPlugin };
}

function usePluginStateValues(): PluginState {
  const router = useRouter();
  const route = useCurrentRoute();
  const search = Cell.source("");
  const libraryTab = Cell.source<"discover" | "installed">("discover");
  const discoverGroup = Cell.source<string | null>(null);
  const { marketplace, operations, retryMarketplace, refreshInstalledStatus } = useMarketplace();
  const { plugins, filteredPlugins, revalidate, applyPlugin } = useInstalledPlugins(search);

  const selectedPluginId = Cell.derived(() => route.get().params.get("pluginId") ?? null);
  const selectedPlugin = Cell.derivedAsync(async (get) => {
    const id = get(selectedPluginId);
    return id ? ((await get(plugins)).find((plugin) => plugin.id === id) ?? null) : null;
  });
  const selectedMarketplaceEntry = Cell.derivedAsync(async (get) => {
    const id = get(selectedPluginId);
    return get(marketplace).catalog?.entries.find((entry) => entry.manifest.id === id) ?? null;
  });
  const selectedSecrets = useSelectedSecrets(selectedPluginId, selectedPlugin);

  const navigate = (id: string) => void router.navigate(`/plugins/${encodeURIComponent(id)}`);
  return {
    marketplace,
    operations,
    retryMarketplace,
    mcpConnect: Cell.source<DesktopMarketplaceEntry | null>(null),
    plugins,
    filteredPlugins,
    selectedPlugin,
    selectedPluginId,
    selectedMarketplaceEntry,
    selectedSecrets,
    search,
    libraryTab,
    discoverGroup,
    selectMarketplaceEntry: (entry) => navigate(entry.manifest.id),
    selectPlugin: (plugin) => navigate(plugin.id),
    clearSelection: () => void router.navigate("/plugins"),
    revalidate: () => {
      revalidate();
      void refreshInstalledStatus();
    },
    applyPlugin,
    refreshSecrets: () => selectedSecrets.revalidate(),
  };
}

export function PluginStateProvider(props: PluginStateProviderProps) {
  const { children } = props;
  const state = usePluginStateValues();
  return <PluginStateScope.Provider value={state}>{children}</PluginStateScope.Provider>;
}

export function usePluginState() {
  return useScopeContext(PluginStateScope);
}
