import { Cell, For, If } from "retend";
import { Button, EmptyScreen, FadeScroll } from "squire-ui";

import type { DesktopMarketplaceEntry } from "@/platform/desktopClient";
import { usePluginState } from "@/scopes/PluginScope";

import { MarketplaceGroupFilter, type GroupOption } from "./MarketplaceGroupFilter";
import { PluginCard } from "./PluginCard";

import classes from "./Plugins.module.css";

/** A Discover section: a whole group under "All", or one category inside a group. */
interface CatalogSection {
  id: string;
  name: string;
  entries: DesktopMarketplaceEntry[];
}

interface SectionProps {
  section: CatalogSection;
  sections: Cell<CatalogSection[]>;
}

const SECTION_PREVIEW_COUNT = 4;

function MarketplaceSection(props: SectionProps) {
  const { section, sections } = props;
  const { search } = usePluginState();
  const expanded = Cell.source(false);
  const entries = Cell.derived(
    () => sections.get().find((current) => current.id === section.id)?.entries ?? [],
  );
  const searching = Cell.derived(() => search.get().trim().length > 0);
  const visibleEntries = Cell.derived(() =>
    expanded.get() || searching.get()
      ? entries.get()
      : entries.get().slice(0, SECTION_PREVIEW_COUNT),
  );
  const hasMore = Cell.derived(
    () => !searching.get() && entries.get().length > SECTION_PREVIEW_COUNT,
  );
  const toggleLabel = Cell.derived(() => (expanded.get() ? "Show less" : "Show all"));
  const ariaExpanded = Cell.derived(() => (expanded.get() ? "true" : "false"));

  return (
    <section class={classes.marketplaceCategory}>
      <div class={classes.marketplaceCategoryHeader}>
        <h2>{section.name}</h2>
        {If(hasMore, () => (
          <button
            type="button"
            class={classes.marketplaceCategoryToggle}
            aria-expanded={ariaExpanded}
            onClick={() => expanded.set(!expanded.get())}
          >
            {toggleLabel}
          </button>
        ))}
      </div>
      <ul class={classes.pluginGrid}>
        {For(visibleEntries, (entry) => (
          <PluginCard entry={entry} />
        ))}
      </ul>
    </section>
  );
}

/** Group filter options, the effective group, and the sections to show for it. */
function useDiscoverView() {
  const { marketplace, search, discoverGroup } = usePluginState();

  // Groups with at least one listing, regardless of the search.
  const groupOptions = Cell.derived((): GroupOption[] => {
    const catalog = marketplace.get().catalog;
    if (!catalog) return [];
    const populated = catalog.groups.filter((group) =>
      catalog.entries.some((entry) =>
        group.categories.some((category) => entry.categories.includes(category.id)),
      ),
    );
    return [
      { key: "", group: null, name: "All" },
      ...populated.map((group) => ({ key: group.id, group: group.id, name: group.name })),
    ];
  });

  // Search always spans every group; a filter naming a vanished group means "All".
  const activeGroup = Cell.derived(() => {
    const selected = discoverGroup.get();
    if (search.get().trim() || selected === null) return null;
    return groupOptions.get().some((option) => option.group === selected) ? selected : null;
  });

  const sections = Cell.derived((): CatalogSection[] => {
    const catalog = marketplace.get().catalog;
    if (!catalog) return [];
    const query = search.get().trim().toLowerCase();
    const entries = query
      ? catalog.entries.filter(({ manifest }) =>
          `${manifest.name} ${manifest.description} ${manifest.id}`.toLowerCase().includes(query),
        )
      : catalog.entries;
    const group = catalog.groups.find((current) => current.id === activeGroup.get());
    const buckets = group
      ? group.categories.map((category) => ({ ...category, members: [category.id] }))
      : catalog.groups.map((current) => ({
          id: current.id,
          name: current.name,
          members: current.categories.map((category) => category.id),
        }));
    return buckets
      .map(({ id, name, members }) => ({
        id,
        name,
        entries: entries.filter((entry) =>
          entry.categories.some((category) => members.includes(category)),
        ),
      }))
      .filter((section) => section.entries.length > 0);
  });

  return { groupOptions, activeGroup, sections };
}

/** The server supplies installation state and local icon paths with each entry. */
export function MarketplaceDiscover() {
  const { marketplace, retryMarketplace } = usePluginState();
  const { groupOptions, activeGroup, sections } = useDiscoverView();
  const hasCatalog = Cell.derived(() => marketplace.get().catalog !== null);
  const visible = Cell.derived(() => sections.get().length > 0);
  const cachedError = Cell.derived(() =>
    hasCatalog.get() ? (marketplace.get().error ?? null) : null,
  );
  const emptyLabel = Cell.derived(() => {
    const snapshot = marketplace.get();
    if (snapshot.catalog) return "No plugins match this search.";
    return snapshot.error ? "Marketplace unavailable." : "Loading plugins…";
  });
  const showRetry = Cell.derived(() => !hasCatalog.get() && !!marketplace.get().error);
  const retry = () => void retryMarketplace();

  return (
    <div class={classes.marketplaceResults}>
      {If(cachedError, () => (
        <div class={classes.marketplaceNotice} role="status">
          <span>Could not refresh the marketplace. Showing saved listings.</span>
          <Button variant="outline" type="button" onClick={retry}>
            Retry
          </Button>
        </div>
      ))}
      {If(hasCatalog, () => (
        <MarketplaceGroupFilter options={groupOptions} activeGroup={activeGroup} />
      ))}
      {If(visible, {
        true: () => (
          <FadeScroll>
            <div class={classes.marketplaceCategories}>
              {For(
                sections,
                (section) => (
                  <MarketplaceSection section={section} sections={sections} />
                ),
                { key: "id" },
              )}
            </div>
          </FadeScroll>
        ),
        false: () => (
          <div class={classes.emptyPlugins}>
            <EmptyScreen icon="plugin" text={emptyLabel} />
            {If(showRetry, () => (
              <Button variant="outline" type="button" onClick={retry}>
                Retry
              </Button>
            ))}
          </div>
        ),
      })}
    </div>
  );
}
