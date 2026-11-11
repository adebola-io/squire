import { Cell, For } from "retend";
import { FadeScroll } from "squire-ui";

import { usePluginState } from "@/scopes/PluginScope";

import classes from "./Plugins.module.css";

export interface GroupOption {
  /** Group IDs are never empty, so "" safely keys "All". */
  key: string;
  group: string | null;
  name: string;
}

interface GroupChipProps {
  option: GroupOption;
  activeGroup: Cell<string | null>;
}

interface MarketplaceGroupFilterProps {
  options: Cell<GroupOption[]>;
  activeGroup: Cell<string | null>;
}

function GroupChip(props: GroupChipProps) {
  const { option, activeGroup } = props;
  const { search, discoverGroup } = usePluginState();
  const pressed = Cell.derived(() => (activeGroup.get() === option.group ? "true" : "false"));
  const select = () => {
    discoverGroup.set(option.group);
    search.set("");
  };
  return (
    <button type="button" class={classes.marketplaceGroup} aria-pressed={pressed} onClick={select}>
      {option.name}
    </button>
  );
}

/** Discover's group chips in one horizontally scrolling row; picking one clears the search. */
export function MarketplaceGroupFilter(props: MarketplaceGroupFilterProps) {
  const { options, activeGroup } = props;
  return (
    <FadeScroll direction="horizontal" class={classes.marketplaceGroupScroll}>
      <div class={classes.marketplaceGroups} role="group" aria-label="Plugin groups">
        {For(
          options,
          (option) => (
            <GroupChip option={option} activeGroup={activeGroup} />
          ),
          { key: "key" },
        )}
      </div>
    </FadeScroll>
  );
}
