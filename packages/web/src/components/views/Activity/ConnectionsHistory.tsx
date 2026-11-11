import { Cell, If } from "retend";
import { EmptyScreen, FadeScroll, SearchInput } from "squire-ui";

import { useActivity } from "@/scopes/ActivityScope";

import { ThreadList } from "./ThreadList";

import classes from "./Activity.module.css";

/** Search stays above the independently scrolling unified thread history. */
export function ConnectionsHistory() {
  const { threads, search, query: searchQuery } = useActivity();
  const hasThreads = Cell.derivedAsync(async (get) => (await get(threads)).total > 0);
  const searching = Cell.derivedAsync(async (get) => (await get(searchQuery)) !== "");
  const noMatchLabel = Cell.derivedAsync(async (get) => {
    return `No threads match “${await get(searchQuery)}”.`;
  });

  return (
    <div class={classes.historyPanel}>
      <SearchInput
        class={classes.threadSearch}
        model={search}
        placeholder="Search threads or clients"
        label="Search threads or clients"
      />
      {If(hasThreads, {
        true: () => (
          <FadeScroll class={classes.threadScroller}>
            <ThreadList />
          </FadeScroll>
        ),
        false: () =>
          If(searching, {
            true: () => (
              <div class={classes.noMatches} role="status">
                <p title={noMatchLabel}>{noMatchLabel}</p>
                <button type="button" onClick={() => search.set("")}>
                  Clear search
                </button>
              </div>
            ),
            false: () => (
              <div class={classes.emptyConnections}>
                <EmptyScreen
                  icon="activity"
                  text="No threads yet. They appear here when a connected app runs a tool."
                />
              </div>
            ),
          }),
      })}
    </div>
  );
}
