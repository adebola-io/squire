import { Popover } from "innate-ui";
import { Cell, If } from "retend";
import { Icon } from "squire-ui";

import { useChat } from "@/scopes/ChatScope";

import { effortLabel, useSelectedEffort } from "./effort";
import { useModelMark, useModelName } from "./modelDisplay";
import { ModelPicker } from "./ModelPicker";

import classes from "./Chat.module.css";

export function ModelChooser() {
  const { selectedModel, modelIntent } = useChat();
  const open = Cell.source(false);
  const selectedEffort = useSelectedEffort();
  const effort = Cell.derivedAsync(async (get) => {
    const selected = await get(selectedEffort);
    return selected ? effortLabel(selected.effort) : "";
  });
  const modelMark = useModelMark((get) => get(selectedModel), "brain");
  const modelLabel = useModelName((get) => get(selectedModel), "Choose model");
  modelIntent.listen((model) => {
    if (model?.modelId) open.set(false);
  });
  return (
    <div class={classes.modelOptions}>
      <Popover open={open} onOpenChange={(next) => open.set(next)} side="top" align="end">
        <Popover.Trigger>
          <button
            type="button"
            class={classes.modelTrigger}
            title={modelLabel}
            aria-label="Choose model"
          >
            <Icon name={modelMark} aria-hidden="true" />
            <span class={classes.modelLabel}>
              <span class={classes.modelName}>{modelLabel}</span>
              {If(effort, (level) => (
                <span class={classes.modelEffort}>{level}</span>
              ))}
            </span>
            <Icon name="caret" class={classes.modelTriggerCaret} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Content
          class={classes.modelPickerPopover}
          aria-label="Choose model"
          autoFocus={false}
          showArrow={false}
          onPointerDownOutside={(event) => {
            // The effort menu is portalled outside this popover.
            if (
              event.target instanceof Element &&
              event.target.closest('[role="menu"][aria-label="Reasoning effort"]')
            ) {
              event.preventDefault();
            }
          }}
        >
          <ModelPicker onSelect={() => open.set(false)} />
        </Popover.Content>
      </Popover>
    </div>
  );
}
