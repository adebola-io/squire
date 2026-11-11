import { Cell, For, If } from "retend";
import { FadeScroll, SearchInput } from "squire-ui";

import { usePluginState } from "@/scopes/PluginScope";

import { MarketplaceRow } from "./PluginRows";

import classes from "./Onboarding.module.css";

/** Match the real marketplace row geometry without moving the list as data arrives. */
function MarketplaceSkeletons() {
  return (
    <div role="status" aria-label="Loading marketplace">
      <ul class={classes.plugins} aria-hidden="true">
        {For([0, 1, 2, 3, 4, 5], () => (
          <li class={classes.skeletonRow}>
            <span class={classes.skeletonIcon} />
            <div>
              <span class={classes.skeletonName} />
              <span class={classes.skeletonDescription} />
            </div>
            <span class={classes.skeletonAction} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Marketplace search and results remain inside a fixed-size scroll pane. */
export function PluginMarketplaceSection() {
  const { marketplace, retryMarketplace } = usePluginState();
  const search = Cell.source("");
  const entries = Cell.derived(() => {
    const query = search.get().trim().toLowerCase();
    return (marketplace.get().catalog?.entries ?? []).filter((entry) => {
      if (entry.installation !== "not_installed") return false;
      if (query === "") return true;
      const { name, description } = entry.manifest;
      return `${name} ${description}`.toLowerCase().includes(query);
    });
  });
  const noMatches = Cell.derived(() => {
    const query = search.get().trim();
    return marketplace.get().catalog && query !== "" && entries.get().length === 0 ? query : null;
  });
  const catalogError = Cell.derived(() => {
    const { catalog, error } = marketplace.get();
    if (!error) return null;
    return catalog
      ? "Couldn’t refresh the marketplace. Showing saved listings."
      : "Marketplace unavailable.";
  });
  const loading = Cell.derived(() => !marketplace.get().catalog && !marketplace.get().error);

  return (
    <>
      <p class={classes.label}>Add to Squire</p>
      <SearchInput
        class={classes.pluginSearch}
        model={search}
        placeholder="Search plugins"
        label="Search plugins"
      />
      <FadeScroll class={classes.scroller}>
        {If(catalogError, (text) => (
          <p class={classes.error} role="alert">
            {text}{" "}
            <button class={classes.retryLink} type="button" onClick={() => void retryMarketplace()}>
              Try again
            </button>
          </p>
        ))}
        {If(loading, MarketplaceSkeletons)}
        <ul class={classes.plugins}>
          {For(entries, (entry) => (
            <MarketplaceRow entry={entry} />
          ))}
        </ul>
        {If(noMatches, (query) => (
          <p class={classes.noMatches} role="status">
            No plugins match “{query}”.
          </p>
        ))}
      </FadeScroll>
    </>
  );
}
