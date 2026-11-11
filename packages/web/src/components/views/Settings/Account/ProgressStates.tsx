import { Cell, If } from "retend";
import { Button } from "squire-ui";

import { AccountBlock } from "./AccountBlock";
import type { AccountStateProps } from "./useAccount";

import classes from "./Account.module.css";

function expiryLabel(milliseconds: number) {
  if (milliseconds <= 0) {
    return "Expiring now";
  }
  const minutes = Math.ceil(milliseconds / 60_000);
  if (minutes === 1) {
    return "Expires in 1 minute";
  }
  return `Expires in ${minutes} minutes`;
}

/** Connection setup state while the approval URL is being created. */
export function StartingState(props: AccountStateProps) {
  const { account } = props;
  const { disconnect } = account;
  return (
    <AccountBlock
      tone="pending"
      headline="Connecting"
      title="Connecting"
      busy
      detail={<span>Asking Squire for an approval link…</span>}
      actions={
        <Button variant="ghost" onClick={disconnect}>
          Cancel
        </Button>
      }
    />
  );
}

/** Wait for account events; the server handles approval polling. */
export function AwaitingState(props: AccountStateProps) {
  const { account } = props;
  const { expiresInMs, userCode, busy, disconnectTask, disconnect, openApproval } = account;
  const expiry = Cell.derivedAsync(async (get) => {
    const remaining = await get(expiresInMs);
    return remaining === null ? "" : expiryLabel(remaining);
  });
  const cancelLabel = Cell.derived(() => {
    return disconnectTask.pending.get() ? "Cancelling…" : "Cancel";
  });
  return (
    <AccountBlock
      tone="pending"
      headline="Waiting for approval"
      title="Waiting for approval"
      busy
      detail={
        <>
          <span>Approve this installation in your browser</span>
          {If(userCode, (code) => (
            <>
              <span class={classes.separator} aria-hidden="true">
                ·
              </span>
              <span>
                Code <strong class={classes.countdown}>{code}</strong>
              </span>
            </>
          ))}
          {If(expiry, (text) => (
            <>
              <span class={classes.separator} aria-hidden="true">
                ·
              </span>
              <span class={classes.countdown}>{text}</span>
            </>
          ))}
        </>
      }
      actions={
        <>
          <Button variant="ghost" disabled={busy} onClick={disconnect}>
            {cancelLabel}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void openApproval();
            }}
          >
            Open approval page
          </Button>
        </>
      }
    />
  );
}
