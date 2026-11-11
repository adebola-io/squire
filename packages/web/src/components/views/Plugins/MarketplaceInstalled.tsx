import { Cell, For, If } from "retend";
import { Button, EmptyScreen, FadeScroll } from "squire-ui";

import { usePluginState } from "@/scopes/PluginScope";
import { pluralize } from "@/utils/misc";

import { AddPluginButton } from "./AddPluginButton";
import { PluginCard } from "./PluginCard";

import classes from "./Plugins.module.css";

export function MarketplaceInstalled() {
  const { plugins, filteredPlugins, search, revalidate } = usePluginState();
  const hasPlugins = Cell.derivedAsync(async (get) => (await get(plugins)).length > 0);
  const hasResults = Cell.derivedAsync(async (get) => (await get(filteredPlugins)).length > 0);
  const countLabel = Cell.derivedAsync(async (get) =>
    pluralize((await get(plugins)).length, "plugin", "plugins"),
  );
  const error = Cell.derived(() => plugins.error.get()?.message ?? null);
  return (
    <div class={classes.marketplaceResults}>
      {If(error, (message) => (
        <div class={classes.error} role="alert">
          <p>{message}</p>
          <Button variant="outline" type="button" onClick={revalidate}>
            Retry
          </Button>
        </div>
      ))}
      {If(hasPlugins, {
        true: () => (
          <>
            <p class={classes.installedLabel}>Installed · {countLabel}</p>
            {If(hasResults, {
              true: () => (
                <FadeScroll>
                  <ul class={classes.pluginGrid}>
                    {For(filteredPlugins, PluginCard, { key: "id" })}
                  </ul>
                </FadeScroll>
              ),
              false: () => (
                <div class={classes.filteredEmpty}>
                  <p>No plugins match your search.</p>
                  <button type="button" onClick={() => search.set("")}>
                    Clear search
                  </button>
                </div>
              ),
            })}
          </>
        ),
        false: () => (
          <div class={classes.emptyPlugins}>
            <EmptyScreen icon="plugin" text="No plugins installed." />
            <AddPluginButton label="Add plugin" />
          </div>
        ),
      })}
    </div>
  );
}
