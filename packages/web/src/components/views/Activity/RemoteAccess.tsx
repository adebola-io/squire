import { Cell, If } from "retend";
import { Icon, Toggle } from "squire-ui";

import { RemoteActions } from "./RemoteActions";
import { cardIs, type RemoteAccessModel, type RemoteCard } from "./useRemoteAccess";

import classes from "./RemoteAccess.module.css";

const LABELS: Record<RemoteCard, string> = {
  signedOut: "Signed out",
  off: "Off",
  connecting: "Connecting",
  connected: "Connected",
  offline: "Offline",
  expired: "Signed out",
  incompatible: "Update needed",
};

const TONES: Record<RemoteCard, string> = {
  signedOut: "idle",
  off: "idle",
  connecting: "pending",
  connected: "success",
  offline: "pending",
  expired: "error",
  incompatible: "error",
};

const LINES: Partial<Record<RemoteCard, string>> = {
  signedOut: "Sign in to register this computer. Apps you connect then reach it at one address.",
  off: "Remote Access is paused. Turn it back on to make this computer available again.",
  offline: "This computer is unreachable. Requests will resume when it reconnects.",
  expired: "Sign in again to resume Remote Access to this computer.",
  incompatible:
    "This Squire is older than the Remote Access service expects, so calls are refused. Run the install command again to update.",
};

interface RemoteAccessProps {
  remote: RemoteAccessModel;
  onDiagnostics: () => void;
}

/** The computer, its connection state, and the one control that state needs. */
export function RemoteAccess(props: RemoteAccessProps) {
  const { remote, onDiagnostics } = props;
  const line = Cell.derivedAsync(async (get) => LINES[await get(remote.card)] ?? null);

  return (
    <section class={classes.remote} aria-label="Remote Access" aria-busy={remote.busy}>
      <RemoteHead remote={remote} onDiagnostics={onDiagnostics} />
      {If(line, (text) => (
        <p class={classes.line}>{text}</p>
      ))}
      <RemoteActions remote={remote} />
      {If(remote.error, (message) => (
        <p role="alert" class={classes.error} title={message}>
          {message}
        </p>
      ))}
    </section>
  );
}

/** Device · system · state, then diagnostics and the switch. */
function RemoteHead(props: RemoteAccessProps) {
  const { remote, onDiagnostics } = props;
  const signedOut = cardIs(remote, "signedOut");
  const hasDiagnostics = cardIs(remote, "connected", "offline", "incompatible");
  const label = Cell.derivedAsync(async (get) => LABELS[await get(remote.card)]);
  const tone = Cell.derivedAsync(async (get) => TONES[await get(remote.card)]);
  const deviceName = Cell.derivedAsync(async (get) => (await get(remote.status)).deviceName);
  const os = Cell.derivedAsync(async (get) => (await get(remote.status)).os);
  const toggle = () => {
    void remote.toggle();
  };

  return (
    <div class={classes.head}>
      <p class={classes.meta}>
        {If(signedOut, {
          false: () => (
            <>
              <span class={classes.deviceName} title={deviceName}>
                {deviceName}
              </span>
              <span class={classes.os}>{os}</span>
            </>
          ),
        })}
        <span class={classes.state} data-tone={tone}>
          {label}
        </span>
      </p>
      <div class={classes.controls}>
        {If(hasDiagnostics, () => (
          <button
            type="button"
            class={classes.iconButton}
            title="Diagnostics"
            aria-label="Diagnostics"
            onClick={onDiagnostics}
          >
            <Icon name="threeDots" aria-hidden="true" />
          </button>
        ))}
        <Toggle
          on={remote.on}
          disabled={remote.switchDisabled}
          title="Remote Access"
          aria-label="Remote Access"
          onChange={toggle}
        />
      </div>
    </div>
  );
}
