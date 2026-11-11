import { Cell, If, type SourceCell } from "retend";

import { AppLink } from "@/components/ui/AppLink";
import { useChat } from "@/scopes/ChatScope";

import classes from "./Providers.module.css";

interface CheckedFieldProps {
  id: string;
  label: string;
  value: SourceCell<string>;
  error: Cell<string | null>;
  onCheck: () => boolean;
  placeholder: string;
  type?: "text" | "url";
}

/** Required text input with validation on blur. */
export function CheckedField(props: CheckedFieldProps) {
  const { id, label, value, error, onCheck, placeholder, type = "text" } = props;
  const errorId = `${id}-error`;
  const invalid = Cell.derived(() => {
    return error.get() !== null;
  });
  const setValue = (event: Event) => {
    value.set((event.currentTarget as HTMLInputElement).value);
  };
  const check = () => {
    onCheck();
  };

  return (
    <label class={classes.field}>
      <span class={classes.fieldLabel}>{label}</span>
      <input
        id={id}
        class={classes.input}
        type={type}
        value={value}
        required
        aria-invalid={invalid}
        aria-describedby={errorId}
        placeholder={placeholder}
        onInput={setValue}
        onBlur={check}
      />
      <span id={errorId} class={classes.fieldError} role="alert">
        {If(error, (message) => {
          return message;
        })}
      </span>
    </label>
  );
}

interface BuiltinHintProps {
  kind: Cell<string>;
}

/**
 * Link to the matching built-in provider while allowing a separate account or endpoint to be
 * added.
 */
export function BuiltinHint(props: BuiltinHintProps) {
  const { kind } = props;
  const { providers } = useChat();
  const match = Cell.derivedAsync(async (get) => {
    const chosen = get(kind);
    const found = (await get(providers)).profiles.find((profile) => {
      return profile.builtin && profile.kind === chosen;
    });
    return found ?? null;
  });

  return If(match, (profile) => {
    const href = `/settings/providers/${encodeURIComponent(profile.id)}?tab=connection`;
    return (
      <p class={classes.fieldHint}>
        {profile.displayName} is already in your providers.{" "}
        <AppLink href={href} class={classes.inlineLink}>
          Add your key there
        </AppLink>
        , or continue to add a second {profile.displayName} connection.
      </p>
    );
  });
}
