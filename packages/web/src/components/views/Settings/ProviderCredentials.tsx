import { Cell, If } from "retend";
import { Icon } from "squire-ui";

import { useLiveValue } from "@/utils/fieldValue";
import { useSecretVisibility } from "@/utils/secretField";

import type { ProviderFieldState } from "./ProviderFields";

import classes from "./Providers.module.css";

interface ProviderCredentialsProps {
  fields: ProviderFieldState;
  existing: boolean;
}

export function ProviderCredentials(props: ProviderCredentialsProps) {
  const { fields, existing } = props;
  const { secret, header } = fields;
  const showAdvanced = Cell.source(false);
  const visibility = useSecretVisibility();
  // Update the live input value after saving clears the secret cell.
  const secretRef = useLiveValue(secret);
  const placeholder = existing ? "Saved. Enter a new key to replace it" : "Paste your API key";
  const hint = existing
    ? "Leave blank to keep the saved key."
    : "Optional for local servers and services without keys.";
  const headerHint = existing
    ? "For services that route requests by conversation. Leave blank to keep the current setting."
    : "For services that route requests by conversation.";

  return (
    <>
      <label class={classes.field}>
        <span class={classes.fieldLabel}>API key</span>
        <span class={classes.inputFrame}>
          <input
            ref={secretRef}
            type={visibility.inputType}
            value={secret}
            {...{ autocomplete: "new-password" }}
            placeholder={placeholder}
            onInput={(event) => {
              secret.set((event.currentTarget as HTMLInputElement).value);
            }}
          />
          <button
            type="button"
            class={classes.inputButton}
            title={visibility.label}
            aria-label={visibility.label}
            onClick={visibility.toggle}
          >
            <Icon name={visibility.icon} aria-hidden="true" />
          </button>
        </span>
        <span class={classes.fieldHint}>{hint}</span>
      </label>
      <button
        type="button"
        class={classes.disclosure}
        aria-expanded={showAdvanced}
        onClick={() => {
          showAdvanced.set(!showAdvanced.get());
        }}
      >
        <Icon name="caret" aria-hidden="true" />
        Advanced
      </button>
      {If(showAdvanced, () => {
        return (
          <label class={classes.field}>
            <span class={classes.fieldLabel}>Session header</span>
            <input
              class={classes.input}
              value={header}
              placeholder="e.g. x-opencode-session"
              onInput={(event) => {
                header.set((event.currentTarget as HTMLInputElement).value);
              }}
            />
            <span class={classes.fieldHint}>{headerHint}</span>
          </label>
        );
      })}
    </>
  );
}
