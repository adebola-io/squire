import { Await, Cell, For, If } from "retend";
import { Button, EmptyScreen, ViewHeader } from "squire-ui";

import { LoadingState } from "@/components/ui/LoadingState";
import { useWorkspaceState, WorkspaceStateProvider } from "@/scopes/WorkspaceScope";

import { AddWorkspaceButton } from "./AddWorkspaceButton";
import { WorkspaceRow } from "./WorkspaceRow";

import classes from "./Workspaces.module.css";

/** Mutation error display with a retry action for the workspace list. */
function WorkspaceError() {
  const { error, revalidate } = useWorkspaceState();
  return If(error, (message) => (
    <div class={classes.error} role="alert">
      <p title={message}>{message}</p>
      <Button variant="outline" type="button" onClick={revalidate}>
        Retry
      </Button>
    </div>
  ));
}

function WorkspacesContent() {
  const { roots, busyPath } = useWorkspaceState();
  const hasRoots = Cell.derivedAsync(async (get) => {
    return (await get(roots)).length > 0;
  });
  const addIsBusy = Cell.derived(() => {
    return busyPath.get() === "add";
  });

  return If(hasRoots, {
    true: () => (
      <section class={classes.page} aria-busy={addIsBusy}>
        <div class={classes.workspaces}>
          <header class={classes.header}>
            <ViewHeader
              title="Workspaces"
              subtitle="Folders Squire can inspect, search, read, and edit."
            />
            <AddWorkspaceButton class={classes.addButton} />
          </header>
          <WorkspaceError />
          <ul class={classes.rootList}>{For(roots, WorkspaceRow)}</ul>
        </div>
      </section>
    ),
    false: () => (
      <div class={classes.emptyWorkspaces} aria-busy={addIsBusy}>
        <EmptyScreen icon="grid" text="No workspace folders configured." />
        <div class={classes.emptyActions}>
          <AddWorkspaceButton class={classes.addButton} />
        </div>
        <WorkspaceError />
      </div>
    ),
  });
}

function WorkspaceLoading() {
  const { roots, error, revalidate } = useWorkspaceState();
  const loadError = Cell.derived(() => error.get() ?? roots.error.get()?.message ?? null);
  return (
    <LoadingState screen label="Fetching workspaces…" error={loadError} onRetry={revalidate} />
  );
}

export function Workspaces() {
  return (
    <WorkspaceStateProvider>
      <Await fallback={<WorkspaceLoading />}>
        <WorkspacesContent />
      </Await>
    </WorkspaceStateProvider>
  );
}
