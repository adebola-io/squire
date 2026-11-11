import { type AsyncCell, Cell, createScope, useScopeContext } from "retend";
import type { JSX } from "retend/jsx-runtime";

import { getBrowserSettings } from "@/platform/desktopClient";
import type { BrowserSettingsResponse } from "@/platform/desktopClient";

interface RefreshOptions {
  /** Bypass cached browser detection. */
  redetect?: boolean;
}

interface BrowserSettingsState {
  /**
   * Retain the last successful settings during refreshes and expose failures through
   * `settings.error`. Null before the first successful read.
   */
  settings: AsyncCell<BrowserSettingsResponse | null>;
  /** Refetch settings and cancel the previous request. */
  refresh: (options?: RefreshOptions) => void;
}

const BrowserSettingsScope = createScope<BrowserSettingsState>();

interface BrowserSettingsProviderProps {
  children: JSX.Children;
}

/**
 * Load browser settings at startup. Detect installed browsers on the first read and use cached
 * detection for subsequent reads.
 */
export function BrowserSettingsProvider(props: BrowserSettingsProviderProps) {
  const { children } = props;
  let redetect = true;
  const settings = Cell.derivedAsync(
    async (_get, signal): Promise<BrowserSettingsResponse | null> => {
      const refresh = redetect;
      redetect = false;
      return await getBrowserSettings(signal, refresh);
    },
  );
  const refresh = (options: RefreshOptions = {}) => {
    redetect = options.redetect ?? false;
    settings.revalidate();
  };

  return (
    <BrowserSettingsScope.Provider value={{ settings, refresh }}>
      {children}
    </BrowserSettingsScope.Provider>
  );
}

export function useBrowserSettingsState() {
  return useScopeContext(BrowserSettingsScope);
}
