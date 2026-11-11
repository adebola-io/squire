import { Cell, createScope, onSetup, useScopeContext, type SourceCell } from "retend";
import type { JSX } from "retend/jsx-runtime";

import { getBrowserPresence, type BrowserPresence } from "@/platform/browserViewer";
import { onDesktopEvent } from "@/scopes/DesktopEventsScope";

interface BrowserPresenceContext {
  presence: SourceCell<BrowserPresence>;
}

interface BrowserPresenceProviderProps {
  children: JSX.Children;
}

const BrowserPresenceScope = createScope<BrowserPresenceContext>();
const EMPTY: BrowserPresence = { conversations: [], threads: [] };

/** One presence request for Chat and Connections, invalidated by desktop push. */
export function BrowserPresenceProvider(props: BrowserPresenceProviderProps) {
  const { children } = props;
  const presence = Cell.source<BrowserPresence>(EMPTY);
  const load = Cell.task(async () => presence.set(await getBrowserPresence()));
  let queued = false;
  const refresh = () => {
    if (load.pending.get()) {
      queued = true;
      return;
    }
    void load.runWith(null).finally(() => {
      if (queued) {
        queued = false;
        refresh();
      }
    });
  };
  onSetup(refresh);
  onDesktopEvent("browser.tabs.changed", (event) => {
    if (!event.metadataOnly) refresh();
  });
  onDesktopEvent("connection.opened", refresh);
  onDesktopEvent("resync", refresh);
  return (
    <BrowserPresenceScope.Provider value={{ presence }}>{children}</BrowserPresenceScope.Provider>
  );
}

export function useBrowserPresence() {
  return useScopeContext(BrowserPresenceScope).presence;
}
