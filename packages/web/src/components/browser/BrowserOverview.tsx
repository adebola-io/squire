import { For, type Cell } from "retend";
import { Button } from "squire-ui";

import type { BrowserScopeKind, BrowserTab } from "@/platform/browserViewer";
import { browserThumbnailUrl } from "@/platform/browserViewer";

import classes from "./Browser.module.css";

interface Props {
  tabs: Cell<BrowserTab[]>;
  kind: BrowserScopeKind;
  id: string;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}

export function BrowserOverview(props: Props) {
  const { tabs, kind, id, onSelect, onRemove } = props;
  return (
    <section class={classes.overview} aria-label="Open browser tabs">
      <h2>Open tabs</h2>
      <ul class={classes.overviewGrid}>
        {For(
          tabs,
          (item) => {
            const title = item.title || item.url || "New tab";
            return (
              <li class={classes.overviewCard}>
                <Button variant="ghost" onClick={() => onSelect(item.tab)} title={title}>
                  <img src={browserThumbnailUrl(kind, id, item.tab)} alt="" loading="lazy" />
                  <span>{title}</span>
                </Button>
                <Button
                  variant="ghost"
                  class={classes.overviewRemove}
                  onClick={() => onRemove(item.tab)}
                >
                  Close browser tab
                </Button>
              </li>
            );
          },
          { key: "tab" },
        )}
      </ul>
    </section>
  );
}
