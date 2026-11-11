import { Cell, If, Switch } from "retend";
import { Button, Icon } from "squire-ui";

import { installMarketplaceWasm, updateMarketplaceWasm } from "@/platform/desktopClient";
import type { DesktopMarketplaceEntry } from "@/platform/desktopClient";
import { usePluginState } from "@/scopes/PluginScope";

import { MarketplaceMcpConnect } from "./MarketplaceMcpConnect";

import classes from "./Plugins.module.css";

interface MarketplaceInstallActionProps {
  entry: DesktopMarketplaceEntry;
  compact?: boolean;
}

function useMarketplaceInstall(entry: DesktopMarketplaceEntry) {
  const { operations } = usePluginState();
  const mutate = Cell.task(async (kind: "install" | "update") => {
    await (kind === "update" ? updateMarketplaceWasm : installMarketplaceWasm)(entry);
  });
  const latest = Cell.derivedAsync(async (get) =>
    (await get(operations)).filter((op) => op.integrationId === entry.manifest.id).at(-1),
  );
  /** Patch updates install themselves; only an approval update needs a button. */
  const pendingUpdate = entry.update?.kind === "approval" ? entry.update : null;
  const error = Cell.derivedAsync(async (get) => {
    const taskError = get(mutate.error)?.message;
    const operation = await get(latest);
    return taskError ?? (operation?.status === "failed" ? operation.error : null);
  });
  const status = Cell.derivedAsync(async (get) => {
    if (
      get(mutate.pending) ||
      ["queued", "running", "cancelling"].includes((await get(latest))?.status ?? "")
    )
      return "loading";
    if ((entry.installation === "not_installed" || entry.update) && (await get(error)))
      return "failed";
    if (pendingUpdate) return "update";
    return entry.installation === "not_installed" ? "available" : "installed";
  });
  const busy = entry.installation === "not_installed" ? "Installing…" : "Updating…";
  const label = Cell.derivedAsync(async (get) => {
    const failure = await get(error);
    if (failure) return `Retry ${entry.manifest.name}: ${failure}`;
    return pendingUpdate
      ? `Update ${entry.manifest.name} to ${pendingUpdate.version}`
      : `Install ${entry.manifest.name}`;
  });
  const retryKind =
    entry.installation === "not_installed" ? ("install" as const) : ("update" as const);
  return { mutate, status, busy, error, label, retryKind };
}

/** Both discovery cards and detail pages use the same backend operation. */
export function MarketplaceInstallAction(props: MarketplaceInstallActionProps) {
  const { entry, compact = false } = props;
  const { mutate, status, busy, error, label, retryKind } = useMarketplaceInstall(entry);
  const button = (kind: "install" | "update", retry = false) => {
    const failed = retry || undefined;
    const isUpdate = kind === "update";
    const run = () => void mutate.runWith(kind);
    const icon = retry ? (
      <span aria-hidden="true">!</span>
    ) : isUpdate ? (
      <Icon name="upload" aria-hidden="true" />
    ) : (
      <span class={classes.marketplaceCardPlus} aria-hidden="true">
        +
      </span>
    );
    const text = retry ? "Retry" : isUpdate ? `Update to ${entry.update?.version}` : "Install";
    return compact ? (
      <button
        class={classes.marketplaceCardAction}
        type="button"
        data-failed={failed}
        title={label}
        aria-label={label}
        disabled={mutate.pending}
        onClick={run}
      >
        {icon}
      </button>
    ) : (
      <Button type="button" disabled={mutate.pending} onClick={run}>
        {text}
      </Button>
    );
  };

  return (
    <>
      {Switch(status, {
        installed: () =>
          compact ? (
            <span
              class={[classes.marketplaceCardAction, classes.marketplaceCardInstalled]}
              role="status"
              aria-label={`${entry.manifest.name} installed`}
              title="Installed"
            >
              <Icon name="checkmark" aria-hidden="true" />
            </span>
          ) : (
            <span class={classes.pluginDisabled}>Installed</span>
          ),
        loading: () =>
          compact ? (
            <span
              class={classes.marketplaceCardAction}
              role="status"
              aria-label={busy}
              title={busy}
            >
              <Icon name="loading" class={classes.marketplaceCardSpinner} aria-hidden="true" />
            </span>
          ) : (
            <span class={classes.pluginDisabled}>{busy}</span>
          ),
        update: () => button("update"),
        failed: () =>
          entry.manifest.runtime === "mcp" ? (
            <MarketplaceMcpConnect entry={entry} iconTrigger={compact} retry />
          ) : (
            button(retryKind, true)
          ),
        available: () =>
          entry.manifest.runtime === "mcp" ? (
            <MarketplaceMcpConnect entry={entry} iconTrigger={compact} />
          ) : (
            button("install")
          ),
      })}
      {If(!compact, () =>
        If(error, (message) => (
          <p class={classes.detailError} role="alert">
            {message}
          </p>
        )),
      )}
    </>
  );
}
