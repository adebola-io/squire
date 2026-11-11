import { Cell, If } from "retend";
import type { SourceCell } from "retend";
import { Field, Textarea } from "squire-ui";

export interface PairField {
  id: string;
  error: SourceCell<string | null>;
  invalid: Cell<boolean>;
  validate: (event: Event) => void;
}

export function usePairField(id: string): PairField {
  const error = Cell.source<string | null>(null);
  const invalid = Cell.derived(() => error.get() !== null);
  const validate = (event: Event) => {
    const target = event.currentTarget as HTMLTextAreaElement;
    error.set(validatePairs(target.value));
  };
  return { id, error, invalid, validate };
}

function validatePairs(value: string): string | null {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const separator = lines[index].indexOf("=");
    const name = separator > 0 ? lines[index].slice(0, separator).trim() : "";
    const itemValue = separator > 0 ? lines[index].slice(separator + 1).trim() : "";
    if (separator <= 0 || !name || !itemValue) {
      return `Line ${index + 1} must use NAME=value.`;
    }
  }
  return null;
}

interface PairTextareaProps {
  field: PairField;
  label: string;
  name: string;
  placeholder: string;
}

export function PairTextarea(props: PairTextareaProps) {
  const { field, label, name, placeholder } = props;
  return (
    <Field id={field.id} invalid={field.invalid}>
      <Field.Label>{label}</Field.Label>
      <Textarea name={name} rows={3} placeholder={placeholder} onInput={field.validate} />
      {If(field.error, (message) => (
        <Field.ErrorMessage>{message}</Field.ErrorMessage>
      ))}
    </Field>
  );
}
