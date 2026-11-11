import { Cell, type SourceCell } from "retend";

/**
 * Bind a cell to a text field's live value property. retend-web writes the value attribute,
 * which no longer updates dirty fields. Pass this ref with `value={cell}` for programmatic
 * resets.
 */
export function useLiveValue(cell: Cell<string>) {
  const ref = Cell.source<HTMLInputElement | HTMLTextAreaElement | null>(null);
  cell.listen((next) => {
    const field = ref.get();
    if (field !== null && field.value !== next) {
      field.value = next;
    }
  });
  return ref as SourceCell<HTMLInputElement | null>;
}
