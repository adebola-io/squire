import { Cell } from "retend";
import { Button } from "squire-ui";

import { AccountBlock, type Tone } from "./AccountBlock";
import type { AccountStateProps } from "./useAccount";

import classes from "./Account.module.css";

interface RetryStateProps extends AccountStateProps {
  tone: Tone;
  headline: string;
  retryLabel: string;
}

/** Recoverable expired, failed and revoked connection states. */
export function RetryState(props: RetryStateProps) {
  const { account, tone, headline, retryLabel } = props;
  const { status, busy, connect, disconnect } = account;
  const reason = Cell.derivedAsync(async (get) => (await get(status))?.error ?? "");
  const reasonClass = tone === "error" ? classes.errorText : undefined;
  return (
    <AccountBlock
      tone={tone}
      headline={headline}
      title={headline}
      detail={<span class={reasonClass}>{reason}</span>}
      actions={
        <>
          <Button variant="ghost" disabled={busy} onClick={disconnect}>
            Dismiss
          </Button>
          <Button disabled={busy} onClick={connect}>
            {retryLabel}
          </Button>
        </>
      }
    />
  );
}

/** Error state when the local server cannot report account status. */
export function UnavailableState(props: AccountStateProps) {
  const { account } = props;
  const { status, retryStatus } = account;
  const reason = Cell.derived(() => status.error.get()?.message ?? "");
  return (
    <AccountBlock
      tone="error"
      headline="Account status unavailable"
      title="Account status unavailable"
      detail={<span class={classes.errorText}>{reason}</span>}
      actions={
        <Button variant="outline" onClick={retryStatus}>
          Retry
        </Button>
      }
    />
  );
}
