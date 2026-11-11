import { Cell, If, type SourceCell } from "retend";
import { Toggle } from "squire-ui";

import { SettingRow } from "./SettingRow";
import { fieldError } from "./SettingsDefinitions";
import type { DraftValues, SettingField } from "./SettingsDefinitions";

import classes from "./SettingsEditor.module.css";

interface SettingsFieldProps {
  field: SettingField;
  draft: SourceCell<DraftValues>;
  errors: SourceCell<Record<string, string>>;
  busy: Cell<boolean>;
}

export function FieldInput(props: SettingsFieldProps) {
  const { field, draft, errors, busy } = props;
  const id = `settings-${field.key.replaceAll(".", "-")}`;
  const labelFor = field.kind === "toggle" ? undefined : id;
  const value = Cell.derived(() => String(draft.get()[field.key]));
  const validation = Cell.derived(() => errors.get()[field.key] ?? null);
  const invalid = Cell.derived(() => validation.get() !== null);
  const update = (next: string | boolean) => {
    draft.set({ ...draft.get(), [field.key]: next });
    if (errors.get()[field.key] !== undefined) {
      const updated = { ...errors.get() };
      delete updated[field.key];
      errors.set(updated);
    }
  };
  const validate = (event: FocusEvent) => {
    const input = event.currentTarget as HTMLInputElement;
    const reason = input.validity.valid
      ? fieldError(field, draft.get()[field.key])
      : input.validationMessage;
    const updated = { ...errors.get() };
    if (reason === null) {
      delete updated[field.key];
    } else {
      updated[field.key] = reason;
    }
    errors.set(updated);
  };

  let control;
  if (field.kind === "toggle") {
    const on = Cell.derived(() => draft.get()[field.key] === true);
    control = (
      <div class={classes.toggleWrap}>
        <Toggle
          on={on}
          title={field.label}
          aria-label={field.label}
          disabled={busy}
          onChange={() => {
            update(!on.get());
          }}
        />
      </div>
    );
  } else {
    const step = field.kind === "text" ? undefined : field.scale === undefined ? "1" : "any";
    control = (
      <div class={classes.inputWrap}>
        <input
          id={id}
          class={classes.input}
          name={field.key}
          type={field.kind}
          required
          min={field.min}
          max={field.max}
          step={step}
          value={value}
          disabled={busy}
          aria-invalid={invalid}
          aria-describedby={`${id}-hint ${id}-error`}
          onInput={(event: Event) => {
            update((event.currentTarget as HTMLInputElement).value);
          }}
          onBlur={validate}
        />
        {If(field.unit !== undefined, () => (
          <span class={classes.unit} title={field.unit}>
            {field.unit}
          </span>
        ))}
      </div>
    );
  }

  return (
    <SettingRow
      label={field.label}
      labelFor={labelFor}
      hint={
        <p id={`${id}-hint`} title={field.hint}>
          {field.hint}
        </p>
      }
    >
      {control}
      {If(validation, (message) => (
        <p class={classes.fieldError} role="alert" id={`${id}-error`} title={message}>
          {message}
        </p>
      ))}
    </SettingRow>
  );
}
