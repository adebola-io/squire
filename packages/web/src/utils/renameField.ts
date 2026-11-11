/**
 * Shared title-editing controls: select all on focus, commit and blur on Enter, restore and
 * blur on Escape.
 */

export function selectFieldText(event: FocusEvent) {
  (event.currentTarget as HTMLInputElement).select();
}

interface RenameFieldKeys {
  onCommit: () => void;
  onCancel: () => void;
}

export function renameFieldKeyDown(keys: RenameFieldKeys) {
  return (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      keys.onCommit();
      (event.currentTarget as HTMLElement).blur();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      keys.onCancel();
      (event.currentTarget as HTMLElement).blur();
    }
  };
}
