import { Cell, If } from "retend";

import { updateDesktopSettings } from "@/platform/desktopClient";
import type { DesktopSettingsResponse } from "@/platform/desktopClient";
import { errorMessage } from "@/utils/misc";

import { DataDeletionSettings } from "./DataDeletionSettings";
import { draftChanges, fieldsOf, makeDraft, PAGES } from "./SettingsDefinitions";
import type { DraftValues, SettingsKind, SettingsPageDefinition } from "./SettingsDefinitions";
import { SettingsFooter, SettingsGroups } from "./SettingsFormParts";

import classes from "./SettingsEditor.module.css";

interface SettingsFormProps {
  initial: DesktopSettingsResponse;
  definition: SettingsPageDefinition;
  onUpdated?: (response: DesktopSettingsResponse) => void;
}

function SettingsForm(props: SettingsFormProps) {
  const { initial, definition, onUpdated } = props;
  const saved = Cell.source(initial.settings);
  const draft = Cell.source<DraftValues>(makeDraft(initial.settings, definition));
  const errors = Cell.source<Record<string, string>>({});
  const restartRequired = Cell.source(initial.restartRequired);
  const success = Cell.source(false);
  const fields = fieldsOf(definition);
  const update = Cell.task(async (changes: Parameters<typeof updateDesktopSettings>[0]) => {
    success.set(false);
    const response = await updateDesktopSettings(changes);
    saved.set(response.settings);
    draft.set(makeDraft(response.settings, definition));
    errors.set({});
    restartRequired.set(response.restartRequired);
    success.set(true);
    onUpdated?.(response);
  });
  const busy = update.pending;
  const error = Cell.derived(() => {
    const cause = update.error.get();
    return cause === null ? null : errorMessage(cause);
  });

  const dirty = Cell.derived(() => {
    const values = draft.get();
    const baseline = makeDraft(saved.get(), definition);
    return fields.some((field) => String(values[field.key]) !== String(baseline[field.key]));
  });
  const disabled = Cell.derived(() => busy.get() || !dirty.get());
  const buttonLabel = Cell.derived(() => (busy.get() ? "Saving…" : "Save changes"));
  const showSave = Cell.derived(() => dirty.get() || busy.get());
  const showSuccess = Cell.derived(() => success.get() && !dirty.get() && !restartRequired.get());
  const showFooter = Cell.derived(
    () => showSave.get() || showSuccess.get() || error.get() !== null,
  );

  const save = async (event: SubmitEvent | undefined) => {
    if (!event || busy.get() || !dirty.get()) {
      return;
    }

    const { changes, errors: nextErrors } = draftChanges(definition, saved.get(), draft.get());

    if (Object.keys(nextErrors).length > 0) {
      errors.set(nextErrors);
      return;
    }

    await update.runWith(changes);
  };

  return (
    <form class={classes.form} onSubmit--prevent={save} aria-busy={busy}>
      {If(restartRequired, () => (
        <p class={classes.notice} role="status">
          Changes are saved. Restart Squire for them to take effect.
        </p>
      ))}
      <SettingsGroups definition={definition} draft={draft} errors={errors} busy={busy} />
      <SettingsFooter
        error={error}
        showFooter={showFooter}
        showSuccess={showSuccess}
        showSave={showSave}
        disabled={disabled}
        buttonLabel={buttonLabel}
      />
    </form>
  );
}

interface SettingsEditorProps {
  kind: SettingsKind;
  initial: DesktopSettingsResponse;
  onUpdated?: (response: DesktopSettingsResponse) => void;
}

/** Editor for persisted non-secret settings. */
export function SettingsEditor(props: SettingsEditorProps) {
  const { kind, initial, onUpdated } = props;
  const definition: SettingsPageDefinition = PAGES[kind];

  return (
    <section class={classes.page}>
      <div class={classes.content}>
        <header class={classes.heading}>
          <h1 class={classes.title} title={definition.title}>
            {definition.title}
          </h1>
          {If(definition.subtitle !== undefined, () => (
            <p class={classes.subtitle} title={definition.subtitle}>
              {definition.subtitle}
            </p>
          ))}
        </header>
        <SettingsForm initial={initial} definition={definition} onUpdated={onUpdated} />
        {If(kind === "privacy", () => (
          <DataDeletionSettings />
        ))}
      </div>
    </section>
  );
}
