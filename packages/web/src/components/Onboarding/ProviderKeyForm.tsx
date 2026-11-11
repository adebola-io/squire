import { Cell, If } from "retend";
import { Button, Icon } from "squire-ui";

import { updateProvider, type DesktopProviderProfile } from "@/platform/desktopClient";
import { useChat } from "@/scopes/ChatScope";
import { useSecretVisibility } from "@/utils/secretField";

import classes from "./Onboarding.module.css";

export function Footnote() {
  return (
    <p class={classes.footnote}>
      <Icon name="padlock" aria-hidden="true" />
      Credentials stay on this device.
    </p>
  );
}

interface KeyFormProps {
  profile: DesktopProviderProfile;
  done: () => void;
}

/** An API key for a built-in provider, as in the "Provider API key" design. */
export function KeyForm(props: KeyFormProps) {
  const { profile, done } = props;
  const { refreshProviders } = useChat();
  const secret = Cell.source("");
  const visibility = useSecretVisibility();
  const inputId = `onboarding-key-${profile.id}`;
  const save = Cell.task(async (_: null) => {
    await updateProvider(profile.id, {
      displayName: profile.displayName,
      kind: profile.kind,
      baseUrl: profile.baseUrl,
      apiKey: secret.get().trim(),
    });
    refreshProviders();
    done();
  });
  const disabled = Cell.derived(() => save.pending.get() || secret.get().trim() === "");
  const failure = Cell.derived(() => save.error.get()?.message ?? null);
  const label = profile.keyLabel || "API key";
  const hint = profile.configured
    ? "A key is saved. Paste a new one to replace it."
    : "Paste a key to start using this provider.";
  const submit = () => {
    if (!disabled.get()) void save.runWith(null);
  };
  return (
    <form class={classes.keyForm} onSubmit--prevent={submit} aria-busy={save.pending}>
      <label class={classes.fieldLabel} for={inputId}>
        {label}
      </label>
      <div class={classes.keyField}>
        <input
          id={inputId}
          type={visibility.inputType}
          {...{ autocomplete: "new-password" }}
          placeholder="Paste your API key"
          onInput={(event: Event) => secret.set((event.currentTarget as HTMLInputElement).value)}
        />
        <button
          type="button"
          title={visibility.label}
          aria-label={visibility.label}
          onClick={visibility.toggle}
        >
          <Icon name={visibility.icon} aria-hidden="true" />
        </button>
      </div>
      <p class={classes.hint}>{hint}</p>
      {If(profile.docUrl !== "", () => (
        <a class={classes.docLink} href={profile.docUrl} target="_blank" rel="noopener noreferrer">
          Get an API key
        </a>
      ))}
      {If(failure, (message) => (
        <p class={classes.error} role="alert">
          {message}
        </p>
      ))}
      <Footnote />
      <div class={classes.actions}>
        <Button type="button" variant="outline" onClick={done}>
          Cancel
        </Button>
        <Button type="submit" disabled={disabled} loading={save.pending}>
          Save key
        </Button>
      </div>
    </form>
  );
}
