import { Cell, If } from "retend";
import { Button } from "squire-ui";

import { cancelMarketplaceOperation } from "@/platform/desktopClient";
import { usePluginState } from "@/scopes/PluginScope";

import classes from "./Plugins.module.css";

/** Backend state survives navigation; the latest operation is enough for each integration. */
interface MarketplaceOperationStatusProps {
  integrationId: string;
}

export function MarketplaceOperationStatus(props: MarketplaceOperationStatusProps) {
  const { operations } = usePluginState();
  const operation = Cell.derivedAsync(
    async (get) =>
      (await get(operations)).filter((item) => item.integrationId === props.integrationId).at(-1) ??
      null,
  );
  const visible = Cell.derivedAsync(async (get) => {
    const current = await get(operation);
    return current !== null && current.status !== "succeeded";
  });
  const cancellable = Cell.derivedAsync(async (get) =>
    ["queued", "running"].includes((await get(operation))?.status ?? ""),
  );
  const message = Cell.derivedAsync(async (get) => {
    const current = await get(operation);
    if (!current) return "";
    const progress = current.percent === null ? "" : ` · ${current.percent}%`;
    return `${current.phase}${progress}`;
  });
  const error = Cell.derivedAsync(async (get) => (await get(operation))?.error ?? null);
  const cancel = Cell.task(async () => {
    const current = await operation.get();
    if (current) await cancelMarketplaceOperation(current.id);
  });

  return If(visible, () => (
    <div class={classes.marketplaceOperation} role="status">
      <span class={classes.marketplaceOperationMessage}>{message}</span>
      {If(cancellable, () => (
        <Button
          variant="outline"
          type="button"
          disabled={cancel.pending}
          onClick={() => void cancel.runWith(null)}
        >
          Cancel
        </Button>
      ))}
      {If(error, (value) => (
        <p class={classes.detailError}>{value}</p>
      ))}
    </div>
  ));
}
