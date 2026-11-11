import { type AsyncCell, Cell, If } from "retend";
import { Button, Icon } from "squire-ui";

import { updateProvider } from "@/platform/desktopClient";
import type { DesktopProviderProfile } from "@/platform/desktopClient";
import { useChat } from "@/scopes/ChatScope";
import { useLiveValue } from "@/utils/fieldValue";
import { useSecretVisibility } from "@/utils/secretField";

import classes from "./Providers.module.css";

interface KeyStatusProps {
  label: string;
  /** Saved-key suffix, or null when no key is configured. */
  savedKey: AsyncCell<string | null>;
  hint: string;
  error: Cell<Error | null>;
  saved: Cell<boolean>;
}

/** API-key label, saved-key hint and save status. */
function KeyStatus(props: KeyStatusProps) {
  const { label, savedKey, hint, error, saved } = props;
  return (
    <div class={classes.keyText}>
      <span class={classes.keyLabel}>{label}</span>
      {If(savedKey, (text) => {
        return (
          <span class={classes.keySavedHint} title={text}>
            <Icon name="padlock" aria-hidden="true" />
            {text}
          </span>
        );
      })}
      <span class={classes.keyHint} title={hint}>
        {hint}
      </span>
      {If(error, (failure) => {
        return (
          <span class={classes.keyError} role="alert" title={failure.message}>
            {failure.message}
          </span>
        );
      })}
      {If(saved, () => {
        return (
          <span class={classes.keySaved} role="status">
            <Icon name="checkmark" aria-hidden="true" />
            Saved
          </span>
        );
      })}
    </div>
  );
}

interface ProviderKeyFormProps {
  profile: DesktopProviderProfile;
}

/** Built-in provider API-key form with visibility and save controls. */
function useKeyForm(profile: DesktopProviderProfile) {
  const { refreshProviders, providers } = useChat();
  const secret = Cell.source("");
  const visibility = useSecretVisibility();
  const hasSaved = Cell.source(false);
  const task = Cell.task(async () => {
    await updateProvider(profile.id, {
      displayName: profile.displayName,
      kind: profile.kind,
      baseUrl: profile.baseUrl,
      apiKey: secret.get() || undefined,
    });
    secret.set("");
    hasSaved.set(true);
    refreshProviders();
  });
  const saved = Cell.derived(() => {
    return hasSaved.get() && secret.get() === "";
  });
  const saveLabel = Cell.derived(() => {
    return task.pending.get() ? "Saving…" : "Save";
  });
  // Prevent no-op saves with an empty key.
  const saveDisabled = Cell.derived(() => {
    return task.pending.get() || secret.get().trim() === "";
  });
  // Show only the saved key's last four characters.
  const savedKey = Cell.derivedAsync(async (get) => {
    const current = (await get(providers)).profiles.find((candidate) => {
      return candidate.id === profile.id;
    });
    if (current === undefined || !current.configured) {
      return null;
    }
    // Fall back to a generic saved-key message for older servers without key hints.
    const last = current.keyHint ?? "";
    return last === "" ? "A key is saved." : `Saved key ends in …${last}`;
  });
  const placeholder = profile.configured ? "Paste a new key to replace it" : profile.keyPlaceholder;
  const hint = profile.configured
    ? "Paste a new key to replace the saved one."
    : "Paste a key to start using this provider.";
  const secretRef = useLiveValue(secret);

  const submit = () => {
    if (saveDisabled.get()) {
      return;
    }
    void task.runWith(null);
  };
  const setSecret = (event: Event) => {
    secret.set((event.currentTarget as HTMLInputElement).value);
  };

  return {
    secret,
    saved,
    task,
    visibility,
    saveLabel,
    saveDisabled,
    savedKey,
    placeholder,
    hint,
    secretRef,
    submit,
    setSecret,
  };
}

export function ProviderKeyForm(props: ProviderKeyFormProps) {
  const { profile } = props;
  const form = useKeyForm(profile);
  const { secret, saved, task, visibility } = form;

  return (
    <form class={classes.keyForm} onSubmit--prevent={form.submit} aria-busy={task.pending}>
      <div class={classes.keyRow}>
        <KeyStatus
          label={profile.keyLabel}
          savedKey={form.savedKey}
          hint={form.hint}
          error={task.error}
          saved={saved}
        />
        <div class={classes.keyFrame}>
          <input
            ref={form.secretRef}
            type={visibility.inputType}
            value={secret}
            {...{ autocomplete: "new-password" }}
            aria-label={profile.keyLabel}
            placeholder={form.placeholder}
            onInput={form.setSecret}
          />
          <button
            type="button"
            class={classes.keyToggle}
            title={visibility.label}
            aria-label={visibility.label}
            onClick={visibility.toggle}
          >
            <Icon name={visibility.icon} aria-hidden="true" />
          </button>
          <Button type="submit" class={classes.keySave} disabled={form.saveDisabled}>
            {form.saveLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}
