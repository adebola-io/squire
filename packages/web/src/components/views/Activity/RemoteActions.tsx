import { Cell, If } from "retend";
import { Button } from "squire-ui";

import { cardIs, type RemoteAccessModel } from "./useRemoteAccess";

import classes from "./RemoteAccess.module.css";

/** The website's install command, which also updates an existing install. */
const UPDATE_URL = "https://use-squire.com/";

interface RemoteActionsProps {
  remote: RemoteAccessModel;
}

/** What the current Remote Access state asks of the person, if anything. */
export function RemoteActions(props: RemoteActionsProps) {
  const { remote } = props;
  const connecting = cardIs(remote, "connecting");
  const signedOut = cardIs(remote, "signedOut");
  const expired = cardIs(remote, "expired");
  const incompatible = cardIs(remote, "incompatible");
  const attempt = Cell.derivedAsync(async (get) => {
    return `Attempt ${Math.max(1, (await get(remote.status)).attempt)}`;
  });
  const cancel = () => {
    void remote.turnOff();
  };

  return (
    <>
      {If(connecting, () => (
        <>
          <div class={classes.progress} role="progressbar" aria-label="Connecting" />
          <div class={classes.foot}>
            <span>{attempt}</span>
            <button type="button" class={classes.footAction} onClick={cancel}>
              Cancel
            </button>
          </div>
        </>
      ))}
      {If(signedOut, () => (
        <div class={classes.actions}>
          <Button disabled={remote.busy} onClick={remote.signIn}>
            Sign in
          </Button>
          <Button variant="outline" disabled={remote.busy} onClick={remote.signIn}>
            Create an account
          </Button>
        </div>
      ))}
      {If(expired, () => (
        <div class={classes.actions}>
          <Button disabled={remote.busy} onClick={remote.signIn}>
            Sign in again
          </Button>
        </div>
      ))}
      {If(incompatible, () => (
        <div class={classes.actions}>
          <a class={classes.linkButton} href={UPDATE_URL} target="_blank" rel="noopener">
            How to update
          </a>
        </div>
      ))}
    </>
  );
}
