import { Await, Cell, If } from "retend";
import { Button } from "squire-ui";

import { AccountBlock } from "./AccountBlock";
import { ManageAccountRow } from "./ManageAccountRow";
import type { AccountStateProps } from "./useAccount";

import classes from "./Account.module.css";

function formatDay(seconds: number) {
  return new Date(seconds * 1000).toLocaleDateString(navigator.languages[0], {
    dateStyle: "medium",
  });
}

/** Connected device name and date, with an error fallback. */
function ConnectedDetail(props: AccountStateProps) {
  const { account } = props;
  const { profile } = account;
  // Resolve status fields together to prevent partially updated summaries.
  const summary = Cell.derivedAsync(async (get) => {
    const current = await get(profile);
    if (current === null) {
      return null;
    }
    return {
      deviceName: current.deviceName,
      day: formatDay(current.connectedAt),
      iso: new Date(current.connectedAt * 1000).toISOString(),
    };
  });
  const profileError = Cell.derived(() => profile.error.get()?.message ?? null);

  return If(summary, {
    true: (line) => (
      <>
        <span>Connected</span>
        <span class={classes.separator} aria-hidden="true">
          ·
        </span>
        <span class={classes.device} title={line.deviceName}>
          {line.deviceName}
        </span>
        <span class={classes.separator} aria-hidden="true">
          ·
        </span>
        <span>
          since <time dateTime={line.iso}>{line.day}</time>
        </span>
      </>
    ),
    false: () =>
      If(profileError, {
        true: (message) => (
          <span class={classes.errorText} role="alert">
            Connected, but account details could not be loaded. {message}
          </span>
        ),
        false: () => <span>Connected</span>,
      }),
  });
}

export function ConnectedState(props: AccountStateProps) {
  const { account } = props;
  const { profile, disconnectTask, busy, disconnect, retryProfile } = account;
  const email = Cell.derivedAsync(async (get) => (await get(profile))?.email ?? "Connected");
  const hasProfile = Cell.derivedAsync(async (get) => (await get(profile)) !== null);
  const profileError = Cell.derived(() => profile.error.get()?.message ?? null);
  const disconnectLabel = Cell.derived(() => {
    return disconnectTask.pending.get() ? "Disconnecting…" : "Disconnect";
  });

  return (
    <>
      <AccountBlock
        tone="success"
        // Show the confirmed connection state while profile details load.
        headline={<Await fallback={<>Connected</>}>{email}</Await>}
        title={email}
        busy={profile.pending}
        detail={
          <Await fallback={<span>Connected. Loading account details…</span>}>
            <ConnectedDetail account={account} />
          </Await>
        }
        actions={
          <>
            {If(profileError, () => (
              <Button variant="ghost" disabled={busy} onClick={retryProfile}>
                Retry
              </Button>
            ))}
            <Button variant="outline" disabled={busy} onClick={disconnect}>
              {disconnectLabel}
            </Button>
          </>
        }
      />
      {/* Retain account details when refreshing fails. */}
      {If(hasProfile, () =>
        If(profileError, (message) => (
          <p class={classes.notice} data-tone="error" role="alert">
            Couldn't refresh account details. {message}
          </p>
        )),
      )}
      <ManageAccountRow account={account} />
    </>
  );
}
