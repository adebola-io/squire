import { Cell, For, If } from "retend";
import type { Cell as CellType } from "retend";
import { Button, Icon, ModalHeading } from "squire-ui";

import { browseWorkspaceDirectories } from "@/platform/desktopClient";

import { WorkspaceDirectoryRow } from "./WorkspaceDirectoryRow";
import { WorkspaceLocationBar } from "./WorkspaceLocationBar";

import classes from "./WorkspaceFileExplorerModal.module.css";

interface WorkspaceFileExplorerModalProps {
  addError: CellType<string | null>;
  onClearError: () => void;
  adding: CellType<boolean>;
  onAdd: (path: string) => Promise<boolean>;
  onClose: () => void;
}

export type WorkspaceFileExplorer = ReturnType<typeof useWorkspaceFileExplorer>;

interface WorkspaceDirectoryBrowserProps {
  modal: WorkspaceFileExplorer;
}

/** `/Users/me`, `C:\Projects`, `D:` or `\\server\share`: a path to open, not a filter. */
const ABSOLUTE_PATH = /^(?:\/|[a-zA-Z]:(?:[\\/]|$)|\\\\)/;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function WorkspaceDirectoryBrowser(props: WorkspaceDirectoryBrowserProps) {
  const { modal } = props;
  const {
    loading,
    browseError,
    showDirectories,
    hasVisibleDirectories,
    emptyMessage,
    visibleDirectories,
    selectedPaths,
    controlsBusy,
    retry,
    openDirectory,
    toggleDirectory,
  } = modal;

  return (
    <div class={classes.browser}>
      {If(loading, () => (
        <div class={classes.browserState} aria-live="polite">
          <Icon name="folder" aria-hidden="true" />
          <p title="Loading folders…">Loading folders…</p>
        </div>
      ))}
      {If(browseError, (message) => (
        <div class={classes.browserState} role="alert">
          <Icon name="info" aria-hidden="true" />
          <p title={message}>{message}</p>
          <Button variant="outline" type="button" disabled={controlsBusy} onClick={retry}>
            Retry
          </Button>
        </div>
      ))}
      {If(showDirectories, () =>
        If(hasVisibleDirectories, {
          true: () => (
            <ul class={classes.directoryList} aria-label="Folders">
              {For(visibleDirectories, (directory) => (
                <WorkspaceDirectoryRow
                  directory={directory}
                  selectedPaths={selectedPaths}
                  controlsBusy={controlsBusy}
                  onToggle={() => toggleDirectory(directory.path)}
                  onOpen={() => openDirectory(directory.path)}
                />
              ))}
            </ul>
          ),
          false: () => (
            <div class={classes.browserState}>
              <Icon name="folder" aria-hidden="true" />
              <p title={emptyMessage}>{emptyMessage}</p>
            </div>
          ),
        }),
      )}
    </div>
  );
}

function useWorkspaceFileExplorer(props: WorkspaceFileExplorerModalProps) {
  const { addError, adding, onAdd, onClose, onClearError } = props;
  const explorerRef = Cell.source<HTMLElement | null>(null);
  const requestedPath = Cell.source<string | undefined>(undefined);
  const listing = Cell.derivedAsync(async (get, signal) => {
    return await browseWorkspaceDirectories(get(requestedPath), signal);
  });
  const directories = Cell.derivedAsync(async (get) => {
    return (await get(listing))?.directories ?? [];
  });
  const breadcrumbs = Cell.derivedAsync(async (get) => {
    return (await get(listing))?.breadcrumbs ?? [];
  });
  const parentPath = Cell.derivedAsync(async (get) => {
    return (await get(listing))?.parentPath ?? null;
  });
  const drives = Cell.derivedAsync(async (get) => {
    return (await get(listing))?.drives ?? [];
  });
  // A single drive is nothing to switch between.
  const hasDrives = Cell.derivedAsync(async (get) => {
    return (await get(drives)).length > 1;
  });

  /** Filters this folder's subfolders, or, when it is a full path, opens it on Enter. */
  const query = Cell.source("");
  const pathError = Cell.source<string | null>(null);
  query.listen(() => pathError.set(null));
  const visibleDirectories = Cell.derivedAsync(async (get) => {
    const text = get(query).trim();
    const all = await get(directories);
    if (text === "" || ABSOLUTE_PATH.test(text)) return all;
    const needle = text.toLowerCase();
    return all.filter((directory) => directory.name.toLowerCase().includes(needle));
  });
  const hasVisibleDirectories = Cell.derivedAsync(async (get) => {
    return (await get(visibleDirectories)).length > 0;
  });
  const emptyMessage = Cell.derivedAsync(async (get) => {
    const text = get(query).trim();
    const all = await get(directories);
    return all.length === 0 ? "This folder has no subfolders." : `No folders match “${text}”.`;
  });

  const selectedPaths = Cell.source<string[]>([]);
  const submitting = Cell.task(async (paths: string[]) => {
    for (const path of paths) {
      const added = await onAdd(path);
      if (!added) {
        return;
      }
    }
    onClose();
  });
  const loading = listing.pending;
  const browseError = Cell.derived(() => {
    return listing.error.get()?.message ?? null;
  });
  const showDirectories = Cell.derived(() => {
    return !loading.get() && browseError.get() === null;
  });
  const controlsBusy = Cell.derived(() => {
    return loading.get() || adding.get() || submitting.pending.get();
  });
  const hasSelection = Cell.derived(() => {
    return selectedPaths.get().length > 0;
  });
  const addDisabled = Cell.derived(() => {
    return controlsBusy.get() || !hasSelection.get();
  });
  /** Opens `path`, or the home folder when it is omitted. */
  const openDirectory = (path?: string) => {
    onClearError();
    query.set("");
    requestedPath.set(path);
  };

  // Check a typed path before leaving the current folder, so a typo shows
  // under the field instead of replacing the listing with an error.
  const openingTypedPath = Cell.task(async (path: string) => {
    try {
      const target = await browseWorkspaceDirectories(path);
      openDirectory(target.path);
    } catch (error) {
      pathError.set(errorMessage(error));
    }
  });
  const submitQuery = () => {
    const text = query.get();
    if (ABSOLUTE_PATH.test(text) && !controlsBusy.get()) {
      void openingTypedPath.runWith(text);
    }
  };

  const toggleDirectory = (path: string) => {
    const selected = selectedPaths.get();
    if (selected.includes(path)) {
      selectedPaths.set(selected.filter((selectedPath) => selectedPath !== path));
      return;
    }
    selectedPaths.set([...selected, path]);
  };

  const retry = () => {
    listing.revalidate();
  };
  const addSelectedWorkspaces = async () => {
    if (addDisabled.get()) {
      return;
    }
    await submitting.runWith(selectedPaths.get());
  };

  return {
    addDisabled,
    addError,
    addSelectedWorkspaces,
    breadcrumbs,
    browseError,
    controlsBusy,
    drives,
    emptyMessage,
    explorerRef,
    hasDrives,
    hasSelection,
    hasVisibleDirectories,
    loading,
    onClose,
    openDirectory,
    parentPath,
    pathError,
    query,
    retry,
    selectedPaths,
    showDirectories,
    submitQuery,
    submitting: submitting.pending,
    toggleDirectory,
    visibleDirectories,
  };
}

export function WorkspaceFileExplorerModal(props: WorkspaceFileExplorerModalProps) {
  const { addError, adding, onAdd, onClose, onClearError } = props;
  const modal = useWorkspaceFileExplorer({ addError, adding, onAdd, onClose, onClearError });

  return (
    <section ref={modal.explorerRef} class={classes.fileExplorer} aria-busy={modal.controlsBusy}>
      <ModalHeading
        title="Add workspaces"
        subtitle="Select folders to use as Squire workspace roots."
      />

      <WorkspaceLocationBar modal={modal} />

      <WorkspaceDirectoryBrowser modal={modal} />

      {If(modal.addError, (message) => (
        <p class={classes.addError} role="alert" title={message}>
          {message}
        </p>
      ))}

      <footer class={classes.footer}>
        <Button variant="outline" type="button" onClick={modal.onClose}>
          Cancel
        </Button>
        {If(modal.hasSelection, () => (
          <Button
            class={classes.confirmButton}
            type="button"
            disabled={modal.addDisabled}
            onClick={modal.addSelectedWorkspaces}
          >
            {If(modal.submitting, {
              true: () => "Adding…",
              false: () => "Add Workspaces",
            })}
          </Button>
        ))}
      </footer>
    </section>
  );
}
