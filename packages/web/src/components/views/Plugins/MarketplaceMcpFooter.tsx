import { Cell, If } from "retend";
import { Button } from "squire-ui";

import type { MarketplaceMcpFlow } from "./MarketplaceMcpConnect";

import classes from "./Plugins.module.css";

interface MarketplaceMcpFooterProps {
  flow: MarketplaceMcpFlow;
}

interface FooterAction {
  label: string;
  submit?: boolean;
  disabled?: boolean;
  run?: () => void;
}

export function MarketplaceMcpFooter(props: MarketplaceMcpFooterProps) {
  const { flow } = props;
  const busy = Cell.derived(() => flow.connect.pending.get() || flow.install.pending.get());
  const action = Cell.derived((): FooterAction => {
    switch (flow.step.get()) {
      case "setup":
        return { label: "Connect", submit: true, disabled: busy.get() };
      case "connecting":
        return { label: "Connecting…", disabled: true };
      case "error":
        return { label: "Retry", run: flow.retry };
      case "authorize":
        return { label: "Waiting for sign-in…", disabled: true };
      case "review":
        return {
          label: flow.install.pending.get() ? "Installing…" : "Install",
          disabled: busy.get(),
          run: () => void flow.install.runWith(null),
        };
    }
  });
  const buttonType = Cell.derived(() => (action.get().submit ? "submit" : "button"));
  const disabled = Cell.derived(() => action.get().disabled ?? false);
  const busyState = Cell.derived(() =>
    flow.step.get() === "connecting" && busy.get() ? true : undefined,
  );
  const label = Cell.derived(() => action.get().label);
  return (
    <footer class={classes.modalFooter}>
      {If(flow.error, (message) => (
        <p class={[classes.modalError, classes.marketplaceNotice]} role="alert">
          {message}
        </p>
      ))}
      <div class={classes.modalActions}>
        <Button
          class={classes.modalActionButton}
          variant="outline"
          type="button"
          onClick={flow.close}
        >
          Cancel
        </Button>
        <Button
          class={classes.modalActionButton}
          type={buttonType}
          disabled={disabled}
          data-busy={busyState}
          onClick={() => action.get().run?.()}
        >
          {label}
        </Button>
      </div>
    </footer>
  );
}
