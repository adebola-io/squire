import { Cell, If } from "retend";
import { FadeSwitch } from "squire-ui";

import { PhaseView } from "./PhaseView";
import { useAccount, type AccountPhase } from "./useAccount";

import classes from "./Account.module.css";

const ANNOUNCEMENTS: Record<AccountPhase, string> = {
  disconnected: "No Squire account connected.",
  starting: "Connecting to Squire.",
  awaitingApproval: "Waiting for approval in your browser.",
  connected: "Squire account connected.",
  expired: "The approval link expired.",
  failed: "The Squire account could not be connected.",
  revoked: "Squire account access was revoked.",
  unavailable: "Squire account status is unavailable.",
};

/** Account connection settings for this installation. */
export function Account() {
  const account = useAccount();
  const { phase, status, connectTask, disconnectTask, disconnectWarning } = account;
  const ready = Cell.derivedAsync(async (get) => (await get(phase)) !== null);
  const announcement = Cell.derivedAsync(async (get) => ANNOUNCEMENTS[await get(phase)]);

  // Display connection, disconnection and status-refresh errors after their requests finish.
  const failure = Cell.derived(() => {
    return (
      connectTask.error.get()?.message ??
      disconnectTask.error.get()?.message ??
      status.error.get()?.message ??
      null
    );
  });
  const visibleFailure = Cell.derivedAsync(async (get) => {
    const current = await get(phase);
    if (current === "unavailable" || current === "starting") {
      return null;
    }
    return get(failure);
  });
  // Show remote-disconnection instructions if only the local disconnect succeeded.
  const warning = Cell.derivedAsync(async (get) => {
    return (await get(phase)) === "disconnected" ? get(disconnectWarning) : null;
  });

  return (
    <section class={classes.page}>
      <div class={classes.content}>
        <h1 class={classes.title}>Account</h1>
        <p class={classes.srOnly} aria-live="polite">
          {announcement}
        </p>
        <div class={classes.identity}>
          {If(ready, {
            true: () => (
              <FadeSwitch
                value={phase}
                keyOf={(current) => current}
                render={(current) => <PhaseView phase={current} account={account} />}
              />
            ),
            false: () => (
              <p class={classes.checking} role="status" aria-busy="true">
                Checking account…
              </p>
            ),
          })}
        </div>
        {If(visibleFailure, (message) => (
          <p class={classes.notice} data-tone="error" role="alert">
            {message}
          </p>
        ))}
        {If(warning, (message) => (
          <p class={classes.notice} role="status">
            {message}
          </p>
        ))}
      </div>
    </section>
  );
}
