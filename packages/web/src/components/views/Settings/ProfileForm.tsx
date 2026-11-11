import { Cell, If } from "retend";
import type { AsyncCell } from "retend";
import { Button, Icon } from "squire-ui";

import { createProvider, updateProvider } from "@/platform/desktopClient";
import type { DesktopProviderProfile } from "@/platform/desktopClient";
import { useChat } from "@/scopes/ChatScope";
import { formValues, useFormDirty, type FormBaseline } from "@/utils/formBaseline";

import { ProviderFields } from "./ProviderFields";

import classes from "./Providers.module.css";

/** Validate the provider base URL, returning an error or null. */
function urlProblem(text: string) {
  if (text === "") {
    return "Enter the address the provider's API answers on.";
  }
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "Use an http:// or https:// address.";
    }
    return null;
  } catch {
    return "That isn't a full address. It should start with https://";
  }
}

function useProfileForm(
  profile: DesktopProviderProfile | undefined,
  live: AsyncCell<DesktopProviderProfile | null> | undefined,
  onSaved?: (saved: DesktopProviderProfile) => void,
) {
  const { refreshProviders } = useChat();
  // Values the fields were loaded or last saved with. `dirty` and `saved` are derived from them,
  // so no field listener has to keep the indicator in step.
  const baseline: FormBaseline = Cell.source({
    displayName: profile?.displayName ?? "",
    kind: profile?.kind ?? "custom",
    baseUrl: profile?.baseUrl ?? "",
    header: "",
    secret: "",
  });
  const displayName = Cell.source(baseline.get().displayName);
  const kind = Cell.source(baseline.get().kind);
  const baseUrl = Cell.source(baseline.get().baseUrl);
  const secret = Cell.source(baseline.get().secret);
  const header = Cell.source(baseline.get().header);
  const fields = { displayName, kind, baseUrl, secret, header };
  const hasSaved = Cell.source(false);
  const nameError = Cell.source<string | null>(null);
  const urlError = Cell.source<string | null>(null);
  const task = Cell.task(async () => {
    const input = {
      displayName: displayName.get(),
      kind: kind.get(),
      baseUrl: baseUrl.get(),
      apiKey: secret.get() || undefined,
      sessionHeader: header.get() || undefined,
    };
    const result =
      profile === undefined ? await createProvider(input) : await updateProvider(profile.id, input);
    secret.set("");
    // The fields now match what the server holds.
    baseline.set(formValues(fields));
    hasSaved.set(true);
    refreshProviders();
    onSaved?.(result);
  });
  const dirty = useFormDirty(fields, baseline);
  const saved = Cell.derived(() => {
    return hasSaved.get() && !dirty.get();
  });

  // Validate on blur and submit, not on every input event.
  const checkName = () => {
    const message = displayName.get().trim() === "" ? "Give the provider a name." : null;
    nameError.set(message);
    return message === null;
  };
  const checkUrl = () => {
    const message = urlProblem(baseUrl.get().trim());
    urlError.set(message);
    return message === null;
  };
  const submit = () => {
    if (task.pending.get()) {
      return;
    }
    // Run both checks so all validation errors appear together.
    const nameOk = profile !== undefined || checkName();
    const urlOk = checkUrl();
    if (!nameOk || !urlOk) {
      return;
    }
    void task.runWith(null);
  };

  // Adopt a name saved elsewhere until this field is edited, so a late read cannot overwrite
  // typing.
  live?.listen(async (value) => {
    const current = await value;
    if (current === null) {
      return;
    }
    const saved = baseline.get();
    if (displayName.get() === saved.displayName) {
      displayName.set(current.displayName);
    }
    baseline.set({ ...saved, displayName: current.displayName });
  });

  return {
    fields,
    errors: { name: nameError, url: urlError, checkName, checkUrl },
    task,
    saved,
    submit,
  };
}

interface ProfileFormProps {
  profile?: DesktopProviderProfile;
  /** Current provider data, including name changes. */
  live?: AsyncCell<DesktopProviderProfile | null>;
  onSaved?: (saved: DesktopProviderProfile) => void;
  onCancel?: () => void;
}

/** Custom provider connection form. */
export function ProfileForm(props: ProfileFormProps) {
  const { profile, live, onSaved, onCancel } = props;
  const { fields, errors, task, saved, submit } = useProfileForm(profile, live, onSaved);
  const submitLabel = Cell.derived(() => {
    if (task.pending.get()) {
      return "Saving…";
    }
    return profile === undefined ? "Add provider" : "Save changes";
  });

  // Use inline application errors instead of native validation popups.
  return (
    <form class={classes.form} onSubmit--prevent={submit} aria-busy={task.pending} noValidate>
      {/* Keep the field editable to preserve focus; the task rejects duplicate submissions. */}
      <fieldset class={classes.fieldset}>
        <ProviderFields fields={fields} errors={errors} existing={profile !== undefined} />
      </fieldset>
      {If(task.error, (error) => {
        return (
          <p class={classes.error} role="alert" title={error.message}>
            {error.message}
          </p>
        );
      })}
      <footer class={classes.formFooter}>
        <span class={classes.saved} role="status">
          {If(saved, () => {
            return (
              <>
                <Icon name="checkmark" aria-hidden="true" />
                Saved
              </>
            );
          })}
        </span>
        {If(onCancel !== undefined, () => {
          return (
            <Button variant="ghost" type="button" class={classes.quietButton} onClick={onCancel}>
              Cancel
            </Button>
          );
        })}
        <Button type="submit" aria-disabled={task.pending} class={classes.submitButton}>
          {submitLabel}
        </Button>
      </footer>
    </form>
  );
}
