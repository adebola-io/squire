import { Cell, If } from "retend";
import { Icon } from "squire-ui";

import type { ModelInfo } from "@/platform/desktopClient";
import { useChat } from "@/scopes/ChatScope";

import { InstantSwitch } from "./InstantSwitch";
import { formatTokens, modelName, saveSwitch, type CommonCapabilities } from "./modelStore";

import classes from "./Providers.module.css";

interface ModelRowProps {
  profileId: string;
  /** Initial model data used as a fallback. */
  initial: ModelInfo;
  /** Loaded model pages, including saves and refreshes. */
  rows: Cell<ModelInfo[]>;
  common: Cell<CommonCapabilities>;
  onOpen: (id: string, opener: HTMLElement) => void;
  onSaved: (model: ModelInfo) => void;
}

/** Model summary row with a picker-visibility toggle and a settings-dialog trigger. */
export function ModelRow(props: ModelRowProps) {
  const { profileId, initial, rows, common, onOpen, onSaved } = props;
  const { refreshProviders } = useChat();
  const model = Cell.derived(() => {
    const current = rows.get().find((candidate) => {
      return candidate.id === initial.id;
    });
    return current ?? initial;
  });
  const name = Cell.derived(() => {
    return modelName(model.get());
  });
  const subtitle = Cell.derived(() => {
    const id = model.get().id;
    return name.get() === id ? null : id;
  });
  const shown = Cell.derived(() => {
    return !model.get().prefs.hidden;
  });
  const pickerLabel = Cell.derived(() => {
    return `Show ${name.get()} in the model picker`;
  });
  const settingsTitle = Cell.derived(() => {
    return `Settings for ${name.get()}`;
  });
  // Use the stable model ID as the row key.
  const id = initial.id;

  const open = (event: MouseEvent) => {
    onOpen(model.get().id, event.currentTarget as HTMLElement);
  };
  const savePicker = async (next: boolean) => {
    const saved = await saveSwitch(profileId, model.get(), { hidden: !next });
    onSaved(saved);
    refreshProviders();
  };

  return (
    <li class={classes.modelItem} data-model-id={id}>
      <button
        type="button"
        class={classes.modelRow}
        aria-haspopup="dialog"
        title={settingsTitle}
        onClick={open}
      >
        <span class={classes.modelText}>
          <span class={classes.modelName} title={name}>
            {name}
          </span>
          {If(subtitle, (value) => {
            return (
              <span class={classes.modelId} title={value}>
                {value}
              </span>
            );
          })}
        </span>
        <ModelTraits model={model} common={common} />
      </button>
      <InstantSwitch label={pickerLabel} on={shown} save={savePicker} compact />
    </li>
  );
}

interface ModelTraitsProps {
  model: Cell<ModelInfo>;
  common: Cell<CommonCapabilities>;
}

/** Show context size and capabilities that are not shared by every listed model. */
export function ModelTraits(props: ModelTraitsProps) {
  const { model, common } = props;
  const context = Cell.derived(() => {
    return `${formatTokens(model.get().metadata.contextWindow)} context`;
  });
  const tools = Cell.derived(() => {
    return model.get().metadata.tools && !common.get().tools;
  });
  const vision = Cell.derived(() => {
    return model.get().metadata.vision && !common.get().vision;
  });

  return (
    <span class={classes.chips}>
      <span class={classes.chip} title="Context window, in tokens">
        {context}
      </span>
      {If(tools, () => {
        return (
          <span class={classes.chip} title="Tool use">
            <Icon name="bolt" aria-hidden="true" />
            Tools
          </span>
        );
      })}
      {If(vision, () => {
        return (
          <span class={classes.chip} title="Image input">
            <Icon name="eye" aria-hidden="true" />
            Vision
          </span>
        );
      })}
    </span>
  );
}
