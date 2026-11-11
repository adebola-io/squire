import { Cell, type SourceCell } from "retend";

/** Editable text fields of a form, keyed by name. */
export type FormFields = Record<string, Cell<string>>;

/** Values a form's fields were loaded or last saved with. */
export type FormBaseline = SourceCell<Record<string, string>>;

/** Values currently held by a form's fields. */
export function formValues(fields: FormFields) {
  const values: Record<string, string> = {};
  for (const [key, field] of Object.entries(fields)) {
    values[key] = field.get();
  }
  return values;
}

/** Whether any field differs from the values it was loaded or last saved with. */
export function useFormDirty(fields: FormFields, baseline: FormBaseline) {
  const dirty = Cell.derived(() => {
    const saved = baseline.get();
    return Object.entries(fields).some(([key, field]) => {
      return field.get() !== saved[key];
    });
  });
  return dirty;
}
