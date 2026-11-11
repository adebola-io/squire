import { Await, Cell, If } from "retend";
import { useRouteQuery } from "retend/router";

import { LoadingState } from "@/components/ui/LoadingState";
import { type PanelContent, preparedPanel, SidePanel } from "@/components/ui/RightPanel/RightPanel";
import { ActivityProvider, useActivity } from "@/scopes/ActivityScope";

import { ConnectionsHistory } from "./ConnectionsHistory";
import { RemoteAccess } from "./RemoteAccess";
import { RemoteApps } from "./RemoteApps";
import { RemoteDiagnostics } from "./RemoteDiagnostics";
import { loadToolCallPanel, ToolCallPanel } from "./ToolCallPanel";
import { useRemoteAccess } from "./useRemoteAccess";

import classes from "./Activity.module.css";

const DIAGNOSTICS = "diagnostics";

export function Connections() {
  return (
    <ActivityProvider>
      <ConnectionsContent />
    </ActivityProvider>
  );
}

/**
 * Remote Access state, client setup instructions, then recorded activity. One column,
 * no tabs: diagnostics and tool calls open in the side panel.
 */
function ConnectionsContent() {
  const { threads, refresh } = useActivity();
  const remote = useRemoteAccess();
  const query = useRouteQuery();
  const openEntry = query.get("entry");
  const diagnosticsOpen = Cell.source(false);
  const loadError = Cell.derived(() => threads.error.get()?.message ?? null);

  // Threads need a registered computer; setup instructions also work while access is off.
  const showThreads = Cell.derivedAsync(async (get) => (await get(remote.card)) !== "signedOut");
  const showBanner = Cell.derivedAsync(async (get) => {
    const card = await get(remote.card);
    return card === "connected" || card === "connecting" || card === "offline" || card === "off";
  });

  const panel = Cell.derived((): PanelContent | null => {
    if (diagnosticsOpen.get()) {
      return preparedPanel(
        DIAGNOSTICS,
        async () => null,
        () => <RemoteDiagnostics remote={remote} />,
        "Diagnostics",
      );
    }
    const id = openEntry.get();
    if (id === null) return null;
    return preparedPanel(
      id,
      (signal) => loadToolCallPanel(id, signal),
      (prepared) => <ToolCallPanel entryId={id} prepared={prepared} />,
    );
  });
  const openDiagnostics = () => {
    void query.delete("entry");
    diagnosticsOpen.set(true);
  };
  const closePanel = () => {
    diagnosticsOpen.set(false);
    void query.delete("entry");
  };

  // A thread and the diagnostics share the side panel; opening one closes the other.
  openEntry.listen((id) => {
    if (id !== null) diagnosticsOpen.set(false);
  });

  return (
    <Await
      fallback={
        <LoadingState screen label="Fetching connections…" error={loadError} onRetry={refresh} />
      }
    >
      <section class={classes.connections}>
        <h1 class={classes.connectionsTitle}>Connections</h1>
        <RemoteAccess remote={remote} onDiagnostics={openDiagnostics} />
        {If(showThreads, () => (
          <>
            {If(showBanner, () => (
              <RemoteApps remote={remote} />
            ))}
            <ConnectionsHistory />
          </>
        ))}
      </section>
      <SidePanel content={panel} onClose={closePanel} />
    </Await>
  );
}
