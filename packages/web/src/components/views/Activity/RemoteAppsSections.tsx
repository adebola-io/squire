import { Cell, For } from "retend";

import { AddApp, APP_TARGETS } from "./RemoteAddApp";
import type { RemoteAccessModel } from "./useRemoteAccess";

import classes from "./RemoteAccess.module.css";

interface AppsSectionProps {
  remote: RemoteAccessModel;
}

/** Show every supported client, regardless of existing OAuth authorizations. */
export function AddApps(props: AppsSectionProps) {
  const expanded = Cell.source<string | null | undefined>(undefined);
  const openTarget = Cell.derivedAsync(async (get) => {
    const chosen = get(expanded);
    return chosen === undefined ? (APP_TARGETS[0]?.name ?? null) : chosen;
  });

  return (
    <section class={classes.sheetSection}>
      <h3 class={classes.label}>Choose an app</h3>
      <div>
        {For(
          APP_TARGETS,
          (target) => (
            <AddApp
              remote={props.remote}
              target={target}
              openTarget={openTarget}
              expanded={expanded}
            />
          ),
          { key: "name" },
        )}
      </div>
    </section>
  );
}
