import { Menu } from "innate-ui";
import { Cell, For, If } from "retend";
import { Icon } from "squire-ui";

import { saveModelPrefs } from "@/platform/desktopClient";
import { useChat } from "@/scopes/ChatScope";

import {
  EFFORT_LABELS as LABELS,
  effortLabel,
  useSelectedEffort,
  withEffort,
  type Effort,
} from "./effort";

import classes from "./Chat.module.css";

interface ModelPickerReasoningProps {
  onSelect?: () => void;
}

/** Reasoning-effort menu in the model-picker footer. */
export function ModelPickerReasoning(props: ModelPickerReasoningProps) {
  const { onSelect } = props;
  const { selectedModel, modelDiscovery, nativeOptions, busy, snapshot } = useChat();
  const open = Cell.source(false);
  const selected = useSelectedEffort();

  const save = Cell.task(async (next: Effort) => {
    const current = await selected.get();
    if (current === null) return;
    const options = withEffort(nativeOptions.get() ?? current.info.prefs.nativeOptions, next);
    await saveModelPrefs(current.model, {
      ...current.info.prefs,
      nativeOptions: options,
    });
    const active = await selectedModel.get();
    if (active?.profileId === current.model.profileId && active.modelId === current.model.modelId) {
      nativeOptions.set(options);
    }
    modelDiscovery.refresh(current.model.profileId);
  });
  const blocked = Cell.derived(() => {
    return (
      save.pending.get() || busy.get() || snapshot.get()?.conversation.executionStatus === "running"
    );
  });
  // Close the picker only once the preference is saved, so a failure stays visible below.
  const commit = async (next: Effort) => {
    if (blocked.get()) return;
    await save.runWith(next);
    if (save.error.get() === null) onSelect?.();
  };

  return If(selected, (current) => (
    <>
      <Menu
        open={open}
        onOpenChange={(next) => {
          open.set(next);
        }}
        side="left"
        align="end"
      >
        <Menu.Trigger>
          <button
            type="button"
            class={classes.modelPickerReasoningTrigger}
            disabled={blocked}
            aria-busy={save.pending}
          >
            <Icon name="brain" aria-hidden="true" />
            <span>Effort</span>
            <span class={classes.modelPickerReasoningValue} aria-live="polite">
              {If(save.pending, {
                true: () => "Saving…",
                false: () => effortLabel(current.effort),
              })}
            </span>
            {If(save.pending, {
              true: () => (
                <Icon
                  name="loading"
                  class={classes.modelPickerReasoningSpinner}
                  aria-hidden="true"
                />
              ),
              false: () => (
                <Icon name="caret" class={classes.modelPickerReasoningCaret} aria-hidden="true" />
              ),
            })}
          </button>
        </Menu.Trigger>
        <Menu.Content class={classes.modelPickerReasoningMenu} aria-label="Reasoning effort">
          <Menu.Label class={classes.reasoningHint}>
            More effort may help, but takes longer.
          </Menu.Label>
          <Menu.RadioGroup<Effort>
            value={current.effort}
            onChange={(effort) => {
              void commit(effort);
              open.set(false);
            }}
          >
            {For(current.supported, (level) => (
              <Menu.RadioItem value={level} disabled={blocked}>
                {LABELS[level]}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu>
      {If(save.error, (failure) => (
        <p class={classes.reasoningError} role="alert">
          {failure.message}
        </p>
      ))}
    </>
  ));
}
