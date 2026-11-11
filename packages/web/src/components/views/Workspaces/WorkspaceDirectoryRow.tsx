import { Cell, If } from "retend";
import type { Cell as CellType, SourceCell } from "retend";
import { Icon } from "squire-ui";

import type { DesktopDirectoryEntry } from "@/platform/desktopClient";

import classes from "./WorkspaceFileExplorerModal.module.css";

interface WorkspaceDirectoryRowProps {
  directory: DesktopDirectoryEntry;
  selectedPaths: SourceCell<string[]>;
  controlsBusy: CellType<boolean>;
  onToggle: () => void;
  onOpen: () => void;
}

export function WorkspaceDirectoryRow(props: WorkspaceDirectoryRowProps) {
  const { directory, selectedPaths, controlsBusy, onToggle, onOpen } = props;
  const selected = Cell.derived(() => {
    return selectedPaths.get().includes(directory.path);
  });

  return (
    <li>
      <button
        class={classes.directoryButton}
        type="button"
        title={`${directory.name}. Double-click or press Right Arrow to open.`}
        aria-pressed={selected}
        data-selected={selected}
        disabled={controlsBusy}
        onClick={onToggle}
        onDblClick={onOpen}
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight") return;
          onOpen();
        }}
      >
        <Icon name="folder" aria-hidden="true" />
        <span title={directory.name}>{directory.name}</span>
        <span class={classes.checkmark} aria-hidden="true">
          {If(selected, () => (
            <Icon name="checkmark" aria-hidden="true" />
          ))}
        </span>
      </button>
    </li>
  );
}
