import { Cell, If } from "retend";
import { SearchInput, Tabs, ViewHeader } from "squire-ui";

import { usePluginState } from "@/scopes/PluginScope";

import { AddPluginButton } from "./AddPluginButton";
import { MarketplaceDiscover } from "./MarketplaceDiscover";
import { MarketplaceInstalled } from "./MarketplaceInstalled";

import classes from "./Plugins.module.css";

const LIBRARY_TABS = [
  { value: "discover" as const, label: "Discover" },
  { value: "installed" as const, label: "Installed" },
];

export function PluginsHome() {
  const { search, libraryTab } = usePluginState();
  const discovering = Cell.derived(() => libraryTab.get() === "discover");
  return (
    <section class={classes.pluginHome}>
      <header class={classes.header}>
        <ViewHeader title="Plugins" subtitle="Discover and manage tools available to Squire." />
        <AddPluginButton label="Add plugin" class={classes.addButton} />
      </header>
      <div class={classes.installedPanel}>
        <Tabs
          class={classes.detailTabs}
          label="Plugin library"
          tabs={LIBRARY_TABS}
          value={libraryTab}
          onChange={(value) => {
            libraryTab.set(value);
            search.set("");
          }}
        />
        <SearchInput model={search} placeholder="Search plugins" label="Search plugins" />
        {If(discovering, {
          true: () => <MarketplaceDiscover />,
          false: () => <MarketplaceInstalled />,
        })}
      </div>
    </section>
  );
}
