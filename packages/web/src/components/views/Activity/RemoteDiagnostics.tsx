import { Cell, If, onSetup, type SourceCell } from "retend";

import { Events } from "./RemoteDiagnosticsLists";
import type { RemoteAccessModel } from "./useRemoteAccess";

import classes from "./RemoteAccess.module.css";

/** Lease countdown and socket age move every second; the snapshot behind them every few. */
const TICK_MS = 1000;
const REFRESH_MS = 5000;
const LEASE_INTERVAL_MS = 60_000;

const clock = (at: number) =>
  new Date(at).toLocaleTimeString(navigator.languages[0], { hour12: false });

interface RemoteDiagnosticsProps {
  remote: RemoteAccessModel;
}

/** Connection facts and Remote Access events, behind the card's ⋯ button. */
export function RemoteDiagnostics(props: RemoteDiagnosticsProps) {
  const { remote } = props;
  const now = Cell.source(Date.now());

  onSetup(() => {
    const tick = window.setInterval(() => now.set(Date.now()), TICK_MS);
    const refresh = window.setInterval(() => remote.refreshStatus(), REFRESH_MS);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(refresh);
    };
  });

  return (
    <div class={classes.diagnostics}>
      <h2 class={classes.diagnosticsTitle}>Diagnostics</h2>
      <ConnectionFacts remote={remote} now={now} />
      <Events remote={remote} />
    </div>
  );
}

interface ConnectionFactsProps {
  remote: RemoteAccessModel;
  now: SourceCell<number>;
}

function ConnectionFacts(props: ConnectionFactsProps) {
  const { remote, now } = props;
  const { status } = remote;
  const device = Cell.derivedAsync(async (get) => (await get(status)).deviceName);
  const socket = Cell.derivedAsync(async (get) => {
    const current = await get(status);
    if (current.connectedSince !== null) return `connected ${clock(current.connectedSince)}`;
    if (current.state === "disabled") return "closed";
    return `${current.state} · attempt ${current.attempt}`;
  });
  const lease = Cell.derivedAsync(async (get) => {
    const current = await get(status);
    if (current.connectedSince === null || current.lastLeaseAt === null) return "—";
    const left = Math.round((current.lastLeaseAt + LEASE_INTERVAL_MS - get(now)) / 1000);
    return left > 0 ? `renews in ${left}s` : "renewing";
  });
  const protocol = Cell.derivedAsync(async (get) => {
    const current = await get(status);
    const support = current.state === "incompatible" ? "unsupported" : "supported";
    return `v${current.protocolVersion} · ${support}`;
  });
  const lastError = Cell.derivedAsync(async (get) => {
    const current = await get(status);
    if (!current.error) return null;
    if (current.errorAt === null) return current.error;
    return `${current.error} · ${clock(current.errorAt)}`;
  });

  return (
    <section class={classes.diagnosticsSection}>
      <h3 class={classes.label}>Connection</h3>
      <dl class={classes.kv}>
        <dt>Device</dt>
        <dd>{device}</dd>
        <dt>Socket</dt>
        <dd>{socket}</dd>
        <dt>Lease</dt>
        <dd>{lease}</dd>
        <dt>Protocol</dt>
        <dd>{protocol}</dd>
        {If(lastError, (message) => (
          <>
            <dt>Last error</dt>
            <dd data-tone="error">{message}</dd>
          </>
        ))}
      </dl>
    </section>
  );
}
