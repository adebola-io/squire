import { Cell, If } from "retend";
import { Button, Dialog, Icon } from "squire-ui";

import { saveModelPrefs } from "@/platform/desktopClient";
import type { ModelInfo, ModelPrefs } from "@/platform/desktopClient";
import { useChat } from "@/scopes/ChatScope";
import { formValues, useFormDirty, type FormBaseline } from "@/utils/formBaseline";

import { groupTokens, ModelCapabilities, parseTokens } from "./ModelCapabilities";
import { blankModel, modelName, saveSwitch, type SwitchChange } from "./modelStore";
import { ModelSwitches } from "./ModelSwitches";

import classes from "./Providers.module.css";

interface ModelEditorProps {
  profileId: string;
  modelId: string;
  /** Loaded model records updated by saves. */
  rows: Cell<ModelInfo[]>;
  /** Whether the first model page is still loading. */
  pending: Cell<boolean>;
  onSaved: (model: ModelInfo) => void;
  onClose: () => void;
}

function emptyOptions(value: unknown) {
  return value === null || value === undefined || JSON.stringify(value) === "{}";
}

function useModelEditor(
  profileId: string,
  model: Cell<ModelInfo>,
  onSaved: (model: ModelInfo) => void,
) {
  const { refreshProviders } = useChat();
  const start = model.get();
  // Field text as it was loaded or last saved. `dirty` and `saved` are derived from it, so no
  // field listener has to keep the indicator in step.
  const baseline: FormBaseline = Cell.source({
    alias: start.prefs.alias ?? "",
    contextWindow: groupTokens(start.metadata.contextWindow),
    maxOutput: groupTokens(start.metadata.maxOutput),
    options: emptyOptions(start.prefs.nativeOptions)
      ? ""
      : JSON.stringify(start.prefs.nativeOptions, null, 2),
  });
  const alias = Cell.source(baseline.get().alias);
  const contextWindow = Cell.source(baseline.get().contextWindow);
  const maxOutput = Cell.source(baseline.get().maxOutput);
  const options = Cell.source(baseline.get().options);
  const edits = { alias, contextWindow, maxOutput, options };
  const contextError = Cell.source<string | null>(null);
  const outputError = Cell.source<string | null>(null);
  const optionsError = Cell.source<string | null>(null);
  const hasSaved = Cell.source(false);

  const save = Cell.task(async () => {
    const current = model.get();
    const context = parseTokens(contextWindow.get());
    const output = parseTokens(maxOutput.get());
    if (Number.isNaN(context) || Number.isNaN(output)) {
      throw new Error("Fix the highlighted limits, then save.");
    }
    if (context <= output) {
      outputError.set("Longest response must be smaller than the context window.");
      throw new Error("Fix the highlighted limits, then save.");
    }
    let nativeOptions: unknown = {};
    const optionsText = options.get().trim();
    if (optionsText !== "") {
      try {
        nativeOptions = JSON.parse(optionsText);
      } catch {
        optionsError.set("Provider options must be valid JSON.");
        throw new Error("Fix the provider options, then save.");
      }
    }
    const limitsChanged =
      context !== current.metadata.contextWindow || output !== current.metadata.maxOutput;
    const metadata = { ...current.metadata, contextWindow: context, maxOutput: output };
    const prefs: ModelPrefs = {
      ...current.prefs,
      alias: alias.get().trim() || null,
      nativeOptions,
      // Preserve catalog metadata unless the limits changed; renaming alone must not create an
      // override.
      metadata: limitsChanged ? metadata : current.prefs.metadata,
    };
    await saveModelPrefs({ profileId, modelId: current.id }, prefs);
    // The fields now match what the server holds.
    baseline.set(formValues(edits));
    hasSaved.set(true);
    onSaved({ ...current, prefs, metadata: limitsChanged ? metadata : current.metadata });
    refreshProviders();
  });
  const dirty = useFormDirty(edits, baseline);
  const saved = Cell.derived(() => {
    return hasSaved.get() && !dirty.get();
  });
  const submit = () => {
    if (save.pending.get()) {
      return;
    }
    void save.runWith(null);
  };
  const saveChange = async (change: SwitchChange) => {
    const next = await saveSwitch(profileId, model.get(), change);
    onSaved(next);
    refreshProviders();
  };

  return {
    alias,
    fields: { contextWindow, maxOutput, options, contextError, outputError, optionsError },
    saved,
    save,
    submit,
    saveChange,
  };
}

interface ModelEditorHeadingProps {
  heading: Cell<string>;
  modelId: string;
  showsId: Cell<boolean>;
  onClose: () => void;
}

/** Model name, optional distinct ID, and dialog close control. */
function ModelEditorHeading(props: ModelEditorHeadingProps) {
  const { heading, modelId, showsId, onClose } = props;
  return (
    <header class={classes.dialogHeading}>
      <div>
        <Dialog.Title>
          <span title={heading}>{heading}</span>
        </Dialog.Title>
        {If(showsId, () => {
          return (
            <Dialog.Description>
              <span class={classes.modelId} title={modelId}>
                {modelId}
              </span>
            </Dialog.Description>
          );
        })}
      </div>
      <button
        type="button"
        class={classes.iconButton}
        onClick={onClose}
        title="Close"
        aria-label="Close"
      >
        <Icon name="cancel" aria-hidden="true" />
      </button>
    </header>
  );
}

/**
 * Model settings dialog. Toggle changes save immediately; other fields save together on submit.
 */
export function ModelEditor(props: ModelEditorProps) {
  const { profileId, modelId, rows, pending, onSaved, onClose } = props;
  const model = Cell.derived(() => {
    const current = rows.get().find((candidate) => {
      return candidate.id === modelId;
    });
    return current ?? blankModel(modelId);
  });
  const unlisted = Cell.derived(() => {
    const listed = rows.get().some((candidate) => {
      return candidate.id === modelId;
    });
    return !listed && !pending.get();
  });
  const heading = Cell.derived(() => {
    return modelName(model.get());
  });
  // Show the ID separately only when the heading differs from it.
  const showsId = Cell.derived(() => {
    return heading.get() !== modelId;
  });
  const editor = useModelEditor(profileId, model, onSaved);
  const { alias, fields, saved, save } = editor;
  const submitLabel = Cell.derived(() => {
    return save.pending.get() ? "Saving…" : "Save";
  });
  const setAlias = (event: Event) => {
    alias.set((event.currentTarget as HTMLInputElement).value);
  };

  return (
    <form class={classes.modelEditor} onSubmit--prevent={editor.submit} aria-busy={save.pending}>
      <ModelEditorHeading heading={heading} modelId={modelId} showsId={showsId} onClose={onClose} />
      {If(unlisted, () => {
        return (
          <p class={classes.rowNote}>
            Not in this provider's list, so its settings start from defaults.
          </p>
        );
      })}
      <ModelSwitches model={model} saveChange={editor.saveChange} />
      {/* Keep the field editable to preserve focus; the task rejects duplicate submissions. */}
      <fieldset class={classes.fieldset}>
        <label class={classes.field}>
          <span class={classes.fieldLabel}>Display name</span>
          <input
            class={classes.input}
            value={alias}
            placeholder="Shown in chat instead of the model ID"
            onInput={setAlias}
          />
        </label>
        <ModelCapabilities fields={fields} />
      </fieldset>
      <footer class={classes.formFooter}>
        {If(save.error, (error) => {
          return (
            <p class={classes.error} role="alert" title={error.message}>
              {error.message}
            </p>
          );
        })}
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
        <Button variant="ghost" type="button" class={classes.quietButton} onClick={onClose}>
          Done
        </Button>
        <Button type="submit" aria-disabled={save.pending} class={classes.submitButton}>
          {submitLabel}
        </Button>
      </footer>
    </form>
  );
}
