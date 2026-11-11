import { AsyncCell, Cell, createScope, useScopeContext } from "retend";
import type { JSX } from "retend/jsx-runtime";

import { type AccountProfile, getAccountProfile, getAccountStatus } from "@/platform/desktopClient";
import { onDesktopEvent } from "@/scopes/DesktopEventsScope";
import { debounce } from "@/utils/misc";

/** Account data displayed in the sidebar. */
export type AccountView =
  | { state: "signedOut" }
  | { state: "signedIn"; name: string; image: string | null };

interface AccountState {
  /** Connected profile; null when disconnected or unavailable. */
  profile: AsyncCell<AccountProfile | null>;
  view: AsyncCell<AccountView>;
}

const AccountScope = createScope<AccountState>();

interface AccountProviderProps {
  children: JSX.Children;
}

/** Shared account data for components outside Settings. */
export function AccountProvider(props: AccountProviderProps) {
  const { children } = props;
  // Derive connected state from status, not profile availability, so profile errors do not
  // appear as sign-outs.
  const connected = Cell.derivedAsync(async (_get, signal) => {
    try {
      return (await getAccountStatus(signal)).state === "connected";
    } catch {
      return false;
    }
  });
  const profile = Cell.derivedAsync(async (get, signal) => {
    if (!(await get(connected))) return null;
    try {
      return await getAccountProfile(signal);
    } catch {
      // The next account event refreshes status after offline or revocation errors.
      return null;
    }
  });
  const view = Cell.derivedAsync(async (get): Promise<AccountView> => {
    if (!(await get(connected))) return { state: "signedOut" };
    const details = await get(profile);
    // Hide email addresses in the sidebar, which may be screen-shared. Also filter legacy
    // profiles that stored an email as the name.
    const name = details?.name?.trim();
    return {
      state: "signedIn",
      name: name && !name.includes("@") ? name : "Your account",
      image: details?.image ?? null,
    };
  });
  const refresh = debounce(() => connected.revalidate(), 50);
  onDesktopEvent("account", refresh);
  onDesktopEvent("connection.opened", refresh);

  return <AccountScope.Provider value={{ profile, view }}>{children}</AccountScope.Provider>;
}

export function useAccountProfile() {
  return useScopeContext(AccountScope).profile;
}

export function useAccountView() {
  return useScopeContext(AccountScope).view;
}
