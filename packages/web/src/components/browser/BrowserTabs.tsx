import { Cell, For } from "retend";
import { Button, Icon } from "squire-ui";

import type { BrowserTab } from "@/platform/browserViewer";

import { BrowserCollapseIcon } from "./BrowserChromeControls";
import { BrowserFavicon } from "./BrowserFavicon";

import classes from "./Browser.module.css";

interface Props {
  tabs: Cell<BrowserTab[]>;
  selected: Cell<string>;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onOverview: () => void;
  onClose: () => void;
}

interface TabItemProps {
  tab: BrowserTab;
  selected: Cell<string>;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}

function BrowserTabItem(props: TabItemProps) {
  const { tab, selected, onSelect, onRemove } = props;
  const active = Cell.derived(() => selected.get() === tab.tab);
  const ariaCurrent = Cell.derived(() => (active.get() ? "page" : undefined));
  const title = tab.title || tab.url || "New tab";

  return (
    <div class={classes.tab} data-selected={active}>
      <Button
        variant="ghost"
        type="button"
        class={classes.tabSelect}
        onClick={() => onSelect(tab.tab)}
        title={title}
        aria-current={ariaCurrent}
      >
        <BrowserFavicon url={tab.url} />
        <span>{title}</span>
      </Button>
      <Button
        variant="ghost"
        type="button"
        class={classes.tabRemove}
        title={"Close " + title + " tab"}
        aria-label={"Close " + title + " tab"}
        onClick={() => onRemove(tab.tab)}
      >
        <Icon name="cancel" aria-hidden="true" />
      </Button>
    </div>
  );
}

export function BrowserTabs(props: Props) {
  const { tabs, selected, onSelect, onRemove, onOverview, onClose } = props;
  const count = Cell.derived(() => String(tabs.get().length));

  return (
    <nav class={classes.tabs} aria-label="Browser tabs">
      <div class={classes.tabScroller}>
        {For(
          tabs,
          (tab) => (
            <BrowserTabItem tab={tab} selected={selected} onSelect={onSelect} onRemove={onRemove} />
          ),
          { key: "tab" },
        )}
      </div>
      <div class={classes.tabActions}>
        <Button
          variant="ghost"
          type="button"
          class={classes.mobileTabCount}
          title="Show all tabs"
          aria-label="Show all tabs"
          onClick={onOverview}
        >
          {count}
        </Button>
        <Button
          variant="ghost"
          type="button"
          class={classes.tabCollapse}
          title="Collapse browser viewer (Esc)"
          aria-label="Collapse browser viewer"
          onClick={onClose}
        >
          <BrowserCollapseIcon />
        </Button>
      </div>
    </nav>
  );
}
