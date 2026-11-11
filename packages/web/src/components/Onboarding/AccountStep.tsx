import { Cell, If, onSetup, Switch } from "retend";
import { Button } from "squire-ui";

import { useAccount } from "@/components/views/Settings/Account/useAccount";

import { AccountDisconnected, AccountRetry } from "./AccountChoices";
import { ApprovalWaiting } from "./ApprovalWaiting";

import classes from "./Onboarding.module.css";

interface StepProps {
  next: () => void;
}

export function AccountStep(props: StepProps) {
  const { next } = props;
  const account = useAccount();
  const phase = account.phase;
  const message = Cell.derived(() =>
    account.connectTask.error.get()
      ? "Couldn’t reach the sign-in service. Check your connection and try again."
      : null,
  );

  // The local backend polls for authorization and emits an account event when approved.
  // Advance as soon as the connected status is confirmed, including after returning from
  // the browser when an event was missed.
  let active = true;
  let advanced = false;
  const advance = async (state: Promise<string>) => {
    const current = await state.catch(() => null);
    if (!active || advanced || current !== "connected") return;
    advanced = true;
    next();
  };
  phase.listen((state) => void advance(state));
  onSetup(() => {
    void advance(phase.get());
    return () => {
      active = false;
    };
  });

  return (
    <div class={classes.signin} data-color-scheme="dark">
      <div class={classes.sheet}>
        <div class={classes.sheetContent}>
          {Switch(phase, {
            connected: () => (
              <>
                <h1>Account connected</h1>
                <p>Your account is ready on this computer.</p>
                <Button onClick={next}>Continue</Button>
              </>
            ),
            awaitingApproval: () => <ApprovalWaiting account={account} />,
            starting: () => (
              <>
                <h1>Connecting to Squire</h1>
                <p role="status">Getting a sign-in code…</p>
                <Button variant="ghost" onClick={account.disconnect}>
                  Cancel
                </Button>
              </>
            ),
            disconnected: () => <AccountDisconnected account={account} next={next} />,
            expired: () => (
              <AccountRetry title="Approval link expired" account={account} next={next} />
            ),
            failed: () => (
              <AccountRetry title="Couldn’t connect this computer" account={account} next={next} />
            ),
            revoked: () => (
              <AccountRetry title="Account access was revoked" account={account} next={next} />
            ),
            // A failed status request resolves to `null`, which `useAccount` reports here.
            unavailable: () => (
              <>
                <h1>Couldn’t reach Squire</h1>
                <p>
                  Check your connection and try again. Local features are available without an
                  account.
                </p>
                <Button onClick={account.retryStatus}>Try again</Button>
                <Button variant="outline" onClick={next}>
                  Skip for now
                </Button>
              </>
            ),
          })}
          {If(message, (text) => (
            <p class={classes.error} role="alert">
              {text}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
