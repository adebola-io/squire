import { Cell, onSetup } from "retend";

import {
  connectAccount,
  disconnectAccount,
  getAccountProfile,
  getAccountStatus,
  type AccountProfile,
  type AccountState,
  type AccountStatus,
} from "@/platform/desktopClient";
import { onDesktopEvent } from "@/scopes/DesktopEventsScope";
import { debounce } from "@/utils/misc";

/**
 * Account UI phases. `starting` means an approval URL is pending; `unavailable` means the local
 * status request failed.
 */
export type AccountPhase = AccountState | "starting" | "unavailable";

/** Minimum interval between account checks on return to the app. */
const PROFILE_RECHECK_MS = 60_000;
const CLOCK_TICK_MS = 15_000;

/**
 * Manage account connection requests and react to server events. The server handles enrollment
 * and polling; local timers only update display state.
 */
export function useAccount() {
  const status = Cell.derivedAsync(async (_get, signal): Promise<AccountStatus | null> => {
    return await getAccountStatus(signal);
  });

  // Load profiles only while connected. Unchanged status does not refetch, and status changes
  // abort stale profile requests.
  const profile = Cell.derivedAsync(async (get, signal): Promise<AccountProfile | null> => {
    const current = await get(status);
    if (current?.state !== "connected") {
      return null;
    }
    return await getAccountProfile(signal);
  });

  const refresh = debounce(() => status.revalidate(), 50);
  onDesktopEvent("account", refresh);
  // Refresh after reconnect to recover missed account events.
  onDesktopEvent("connection.opened", refresh);

  /**
   * Wait for refreshed status and derived phase before releasing the button's pending state.
   */
  const settle = async () => {
    status.revalidate();
    await status.peek();
    await phase.peek();
  };

  // Connecting only requests a code. The approval page opens when the person chooses
  // "Open the approval page", after the code is on screen: the browser asks them to check that
  // the codes match, which only works if Squire showed its code first.
  const connectTask = Cell.task(async (_: null) => {
    const next = await connectAccount();
    await settle();
    return next;
  });

  // Keep a remote-disconnection warning until the next attempt if Squire could not be reached.
  const disconnectWarning = Cell.source<string | null>(null);

  const disconnectTask = Cell.task(async (_: null) => {
    const result = await disconnectAccount();
    await settle();
    disconnectWarning.set(result.warning ?? null);
    return result;
  });

  const busy = Cell.derived(() => {
    return connectTask.pending.get() || disconnectTask.pending.get();
  });

  const phase = Cell.derivedAsync(async (get): Promise<AccountPhase> => {
    const current = await get(status);
    if (current === null) {
      return "unavailable";
    }
    const starting = get(connectTask.pending);
    if (starting && current.state !== "awaitingApproval" && current.state !== "connected") {
      return "starting";
    }
    return current.state;
  });

  const connect = () => {
    if (busy.get()) {
      return;
    }
    disconnectWarning.set(null);
    void connectTask.runWith(null);
  };

  /** Cancel approval, disconnect the account, or clear a failed attempt. */
  const disconnect = () => {
    if (disconnectTask.pending.get()) {
      return;
    }
    void disconnectTask.runWith(null);
  };

  const openApproval = async () => {
    const url = (await status.get())?.approvalUrl;
    if (url) {
      window.open(url, "_blank", "noopener");
    }
  };

  // Recheck status after a profile failure to detect revoked installations.
  profile.error.listen((error) => {
    if (error !== null) {
      refresh();
    }
  });

  // Recheck remote revocation when the app regains focus instead of polling continuously.
  onSetup(() => {
    let checkedAt = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      // Recover the latest approval status after returning from the website, even if an
      // account event was missed while the browser tab was in the background.
      refresh();
      if (Date.now() - checkedAt < PROFILE_RECHECK_MS) {
        return;
      }
      checkedAt = Date.now();
      profile.revalidate();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  });

  // Update the expiry countdown without network requests.
  const now = Cell.source(Date.now());
  onSetup(() => {
    const timer = window.setInterval(() => now.set(Date.now()), CLOCK_TICK_MS);
    return () => {
      window.clearInterval(timer);
    };
  });
  const expiresInMs = Cell.derivedAsync(async (get) => {
    const expiresAt = (await get(status))?.expiresAt;
    if (expiresAt === undefined) {
      return null;
    }
    // Recompute expiry from the latest status timestamp rather than the previous timer tick.
    get(now);
    return Math.max(0, expiresAt * 1000 - Date.now());
  });

  const userCode = Cell.derivedAsync(async (get) => (await get(status))?.userCode ?? null);

  return {
    status,
    profile,
    phase,
    userCode,
    busy,
    connectTask,
    disconnectTask,
    disconnectWarning,
    expiresInMs,
    connect,
    disconnect,
    openApproval,
    retryStatus: () => status.revalidate(),
    retryProfile: () => profile.revalidate(),
  };
}

export type AccountModel = ReturnType<typeof useAccount>;

export interface AccountStateProps {
  account: AccountModel;
}
