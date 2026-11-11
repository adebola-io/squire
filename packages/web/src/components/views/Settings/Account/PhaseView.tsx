import { Button } from "squire-ui";

import { AccountBlock } from "./AccountBlock";
import { ConnectedState } from "./ConnectedState";
import { AwaitingState, StartingState } from "./ProgressStates";
import { RetryState, UnavailableState } from "./RecoveryStates";
import type { AccountPhase, AccountStateProps } from "./useAccount";

interface PhaseViewProps extends AccountStateProps {
  phase: AccountPhase;
}

function DisconnectedState(props: AccountStateProps) {
  const { account } = props;
  const { busy, connect } = account;
  return (
    <AccountBlock
      tone="idle"
      headline="No account connected"
      title="No account connected"
      detail={
        <span>
          Connect a Squire account to use hosted services. Everything local works without one.
        </span>
      }
      actions={
        <Button disabled={busy} onClick={connect}>
          Connect account
        </Button>
      }
    />
  );
}

/** Render the selected account phase through FadeSwitch. */
export function PhaseView(props: PhaseViewProps) {
  const { phase, account } = props;
  switch (phase) {
    case "connected": {
      return <ConnectedState account={account} />;
    }
    case "awaitingApproval": {
      return <AwaitingState account={account} />;
    }
    case "starting": {
      return <StartingState account={account} />;
    }
    case "expired": {
      return (
        <RetryState
          account={account}
          tone="idle"
          headline="Approval link expired"
          retryLabel="Try again"
        />
      );
    }
    case "failed": {
      return (
        <RetryState
          account={account}
          tone="error"
          headline="Couldn't connect"
          retryLabel="Try again"
        />
      );
    }
    case "revoked": {
      return (
        <RetryState
          account={account}
          tone="error"
          headline="Access revoked"
          retryLabel="Connect again"
        />
      );
    }
    case "unavailable": {
      return <UnavailableState account={account} />;
    }
    default: {
      return <DisconnectedState account={account} />;
    }
  }
}
