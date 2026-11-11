import { Await, Cell, For, If } from "retend";
import { Button } from "squire-ui";

import { MarketplaceMcpDialogHost } from "@/components/views/Plugins/MarketplaceMcpConnect";
import { usePluginState } from "@/scopes/PluginScope";

import { PluginMarketplaceSection } from "./PluginMarketplaceSection";
import { InstalledChip } from "./PluginRows";

import classes from "./Onboarding.module.css";

interface PluginProps {
  finish: () => void;
  /** Whether completion is being saved. */
  finishing: Cell<boolean>;
}

/** Installed chips wrap to their natural height as plugins are loaded or added. */
function InstalledPluginsSection() {
  const { plugins } = usePluginState();
  return (
    <>
      <p class={classes.label}>Installed</p>
      <div class={classes.chipsSlot}>
        <Await
          fallback={
            <div class={classes.chipsSkeleton} role="status" aria-label="Loading installed plugins">
              <span class={classes.skeletonChip} />
              <span class={classes.skeletonChip} />
              <span class={classes.skeletonChip} />
            </div>
          }
        >
          <div class={classes.chips}>
            {For(plugins, (plugin) => (
              <InstalledChip plugin={plugin} />
            ))}
          </div>
        </Await>
        {If(plugins.error, () => (
          <p class={classes.error} role="alert">
            Couldn’t load installed plugins.
          </p>
        ))}
      </div>
    </>
  );
}

/** The installed section grows; the suggestions list uses the remaining dialog space. */
export function PluginContent(props: PluginProps) {
  const { finish, finishing } = props;
  return (
    <>
      <h1>Plugins</h1>
      <InstalledPluginsSection />
      <PluginMarketplaceSection />
      <div class={classes.actions}>
        <Button variant="outline" onClick={finish} disabled={finishing}>
          Skip
        </Button>
        <Button onClick={finish} loading={finishing}>
          Done
        </Button>
      </div>
      <MarketplaceMcpDialogHost />
    </>
  );
}
