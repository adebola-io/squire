import { For, If } from "retend";
import { Icon, SearchInput } from "squire-ui";

import type { WorkspaceFileExplorer } from "./WorkspaceFileExplorerModal";

import classes from "./WorkspaceFileExplorerModal.module.css";

interface WorkspaceLocationBarProps {
  modal: WorkspaceFileExplorer;
}

/** Drives, the filter-or-path field and the breadcrumbs above the folder list. */
export function WorkspaceLocationBar(props: WorkspaceLocationBarProps) {
  const { modal } = props;
  // The server opens the home folder when no path is given, so this works
  // even when the last listing failed and its home path is unknown.
  const goHome = () => {
    modal.openDirectory();
  };

  return (
    <>
      <div class={classes.toolbar}>
        {If(modal.hasDrives, () => (
          <div class={classes.drives} role="group" aria-label="Drives">
            {For(modal.drives, (drive) => (
              <button
                class={classes.driveButton}
                type="button"
                title={drive.path}
                aria-label={`Open drive ${drive.name}`}
                aria-pressed={String(drive.current)}
                disabled={modal.controlsBusy}
                onClick={() => {
                  modal.openDirectory(drive.path);
                }}
              >
                {drive.name}
              </button>
            ))}
          </div>
        ))}
        <SearchInput
          class={classes.pathField}
          model={modal.query}
          placeholder="Filter folders, or type a full path and press Enter"
          label="Filter folders or open a path"
          onSearch={modal.submitQuery}
        />
      </div>
      {If(modal.pathError, (message) => (
        <p class={classes.pathError} role="alert" title={message}>
          {message}
        </p>
      ))}

      <nav class={classes.breadcrumbs} aria-label="Current folder">
        <button
          class={classes.rootButton}
          type="button"
          title="Home"
          aria-label="Go to home folder"
          disabled={modal.controlsBusy}
          onClick={goHome}
        >
          <Icon name="home" aria-hidden="true" />
        </button>
        {If(modal.parentPath, (parent) => (
          <button
            class={[classes.rootButton, classes.upButton]}
            type="button"
            title={parent}
            aria-label="Go up one folder"
            disabled={modal.controlsBusy}
            onClick={() => {
              modal.openDirectory(parent);
            }}
          >
            <Icon name="arrow" aria-hidden="true" />
          </button>
        ))}
        {For(modal.breadcrumbs, (breadcrumb) => (
          <>
            <Icon class={classes.breadcrumbSeparator} name="caret" aria-hidden="true" />
            <button
              class={classes.breadcrumbButton}
              type="button"
              title={breadcrumb.path}
              disabled={modal.controlsBusy}
              onClick={() => {
                modal.openDirectory(breadcrumb.path);
              }}
            >
              {breadcrumb.name}
            </button>
          </>
        ))}
      </nav>
    </>
  );
}
