import { Cell, onSetup } from "retend";

import { useAccount } from "@/components/views/Settings/Account/useAccount";
import { getRemoteStatus, setRemoteEnabled, type RemoteState } from "@/platform/desktopClient";
import { onDesktopEvent } from "@/scopes/DesktopEventsScope";
import { debounce, errorMessage } from "@/utils/misc";

/** The card the Connections page shows; one per connection state, not per page state. */
export type RemoteCard =
  | "signedOut"
  | "off"
  | "connecting"
  | "connected"
  | "offline"
  | "expired"
  | "incompatible";

function cardFor(state: RemoteState, accountRevoked: boolean): RemoteCard {
  switch (state) {
    case "disabled":
      return "off";
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "reconnecting":
      return "offline";
    case "revoked":
      return "expired";
    case "incompatible":
      return "incompatible";
    case "signedOut":
      // A session the service refused leaves the account revoked rather than never signed in.
      return accountRevoked ? "expired" : "signedOut";
  }
}

/** State and actions for Remote Access, setup instructions, and diagnostics. */
export function useRemoteAccess() {
  const account = useAccount();
  const status = Cell.derivedAsync(async (_get, signal) => getRemoteStatus(signal));
  const card = Cell.derivedAsync(async (get) => {
    const current = await get(status);
    const accountState = (await get(account.status))?.state;
    return cardFor(current.state, accountState === "revoked");
  });

  const change = Cell.task(async (enabled: boolean) => {
    await setRemoteEnabled(enabled);
    status.revalidate();
  });
  const busy = Cell.derived(() => change.pending.get() || account.busy.get());
  const error = Cell.derived(() => {
    const failure = change.error.get() ?? account.connectTask.error.get();
    return failure === null ? null : errorMessage(failure);
  });

  const on = Cell.derivedAsync(async (get) => {
    const current = await get(card);
    return (await get(status)).enabled && current !== "expired";
  });
  const switchDisabled = Cell.derivedAsync(async (get) => {
    const current = await get(card);
    return current === "signedOut" || current === "expired" || get(busy);
  });

  const setEnabled = async (enabled: boolean) => {
    if (busy.get()) return;
    await change.runWith(enabled);
  };
  const toggle = async () => setEnabled(!(await status.get()).enabled);

  const copied = Cell.source(false);
  let copyTimer: number | null = null;
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      copied.set(true);
      if (copyTimer !== null) window.clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => copied.set(false), 1400);
    } catch {
      copied.set(false);
    }
  };

  const refresh = debounce(() => status.revalidate(), 50);
  onDesktopEvent("remote", refresh);
  onDesktopEvent("account", refresh);
  onDesktopEvent("connection.opened", refresh);
  onSetup(() => () => {
    if (copyTimer !== null) window.clearTimeout(copyTimer);
  });

  return {
    status,
    card,
    busy,
    error,
    on,
    switchDisabled,
    copied,
    toggle,
    turnOff: () => setEnabled(false),
    copy,
    signIn: account.connect,
    refresh,
    refreshStatus: () => status.revalidate(),
  };
}

export type RemoteAccessModel = ReturnType<typeof useRemoteAccess>;

/** Whether the card is one of `cards`. */
export function cardIs(remote: RemoteAccessModel, ...cards: RemoteCard[]) {
  return Cell.derivedAsync(async (get) => cards.includes(await get(remote.card)));
}
