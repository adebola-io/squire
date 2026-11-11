import { Cell, For, If } from "retend";
import { useDocumentVisibility, useLiveDate } from "retend-utils/hooks";
import { useRouteQuery } from "retend/router";
import { Dialog } from "squire-ui";

import { deleteConnectionThread } from "@/platform/desktopClient";
import {
  MAX_CONNECTION_ROWS,
  CONNECTION_PAGE_SIZE,
  useActivity,
  type Thread,
} from "@/scopes/ActivityScope";
import { useBrowserPresence } from "@/scopes/BrowserPresenceScope";
import { errorMessage } from "@/utils/misc";

import { ThreadDeleteDialog } from "./ThreadDeleteDialog";
import { ThreadsOverview } from "./ThreadsOverview";

import classes from "./Activity.module.css";

/** A single ordered prefix of the history; refetching it preserves every row. */
function useConnectionThreads() {
  const { threads, limit, refresh } = useActivity();
  const routeQuery = useRouteQuery();
  const documentIsVisible = useDocumentVisibility();
  const liveTime = useLiveDate();
  const presence = useBrowserPresence();
  const browserCounts = Cell.derived(
    () => new Map(presence.get().threads.map(({ id, count }) => [id, count])),
  );
  const deleted = Cell.source(new Set<string>());
  const deleteTarget = Cell.source<Thread | null>(null);
  const deleteOpen = Cell.derived(() => deleteTarget.get() !== null);
  // Use the shared reactive clock; compare deadlines against monotonic time.
  const clock = Cell.derived(() => {
    liveTime.get();
    return performance.now();
  });

  const rows = Cell.derivedAsync(async (get) => {
    const page = await get(threads);
    const removed = get(deleted);
    return page.threads.filter((thread) => !removed.has(thread.id));
  });
  const hasMore = Cell.derivedAsync(async (get) => {
    const page = await get(threads);
    return page.threads.length < page.total && page.threads.length < MAX_CONNECTION_ROWS;
  });
  const loading = threads.pending;
  const error = Cell.derived(() => {
    const cause = threads.error.get();
    return cause === null ? null : errorMessage(cause);
  });
  const showMore = () => {
    if (!loading.get())
      limit.set(Math.min(MAX_CONNECTION_ROWS, limit.get() + CONNECTION_PAGE_SIZE));
  };

  // Revalidate when returning to the app, in case activity events were missed.
  documentIsVisible.listen((visible) => {
    if (visible) refresh();
  });

  const deletion = Cell.task(async (target: Thread) => {
    await deleteConnectionThread(target.id);
    deleted.set(new Set([...deleted.get(), target.id]));
    refresh();
    deleteTarget.set(null);
    if (routeQuery.get("entry").get() === target.id) {
      void routeQuery.delete("entry");
    }
  });
  const deleteBusy = deletion.pending;
  const deleteError = Cell.derived(() => {
    const cause = deletion.error.get();
    return cause === null ? null : errorMessage(cause);
  });
  const requestDelete = (thread: Thread) => {
    deletion.error.set(null);
    deleteTarget.set(thread);
  };
  const cancelDelete = () => {
    if (!deleteBusy.get()) deleteTarget.set(null);
  };
  const confirmDelete = async () => {
    const target = deleteTarget.get();
    if (target === null || deleteBusy.get()) return;
    await deletion.runWith(target);
  };

  return {
    rows,
    clock,
    browserCounts,
    hasMore,
    loading,
    error,
    showMore,
    requestDelete,
    deleteTarget,
    deleteOpen,
    deleteBusy,
    deleteError,
    cancelDelete,
    confirmDelete,
  };
}

export function ThreadList() {
  const state = useConnectionThreads();
  return (
    <>
      <ul class={classes.threadList} aria-label="External agent threads" aria-busy={state.loading}>
        {For(
          state.rows,
          (item) => {
            const thread = Cell.derivedAsync(async (get) => {
              return (await get(state.rows)).find((entry) => entry.id === item.id) ?? item;
            });
            return (
              <ThreadsOverview
                thread={thread}
                clock={state.clock}
                browserCounts={state.browserCounts}
                onDeleteRequest={state.requestDelete}
              />
            );
          },
          { key: "id" },
        )}
        {If(state.hasMore, () => (
          <li class={classes.seeOlder}>
            <button
              type="button"
              class={classes.olderLink}
              disabled={state.loading}
              onClick={state.showMore}
            >
              {If(state.loading, { true: () => "Loading…", false: () => "Show more" })}
            </button>
            {If(state.error, (message) => (
              <p role="alert" title={message}>
                {message}
              </p>
            ))}
          </li>
        ))}
      </ul>
      {If(state.deleteTarget, (target) => (
        <Dialog
          id="delete-connection-thread"
          open={state.deleteOpen}
          onOpenChange={(next) => {
            if (!next) state.cancelDelete();
          }}
        >
          <Dialog.Content size="medium" ariaLabel="Delete thread">
            <ThreadDeleteDialog
              title={target.title}
              busy={state.deleteBusy}
              error={state.deleteError}
              onCancel={state.cancelDelete}
              onConfirm={state.confirmDelete}
            />
          </Dialog.Content>
        </Dialog>
      ))}
    </>
  );
}
