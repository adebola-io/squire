import { Cell } from "retend";

import type { ModelInfo } from "@/platform/desktopClient";

import { InstantSwitch } from "./InstantSwitch";
import type { SwitchChange } from "./modelStore";

import classes from "./Providers.module.css";

interface ModelSwitchesProps {
  model: Cell<ModelInfo>;
  saveChange: (change: SwitchChange) => Promise<void>;
}

/** Model capability toggles with immediate persistence. */
export function ModelSwitches(props: ModelSwitchesProps) {
  const { model, saveChange } = props;
  const shown = Cell.derived(() => {
    return !model.get().prefs.hidden;
  });
  const tools = Cell.derived(() => {
    return model.get().metadata.tools;
  });
  const vision = Cell.derived(() => {
    return model.get().metadata.vision;
  });
  const saveShown = (next: boolean) => {
    return saveChange({ hidden: !next });
  };
  const saveTools = (next: boolean) => {
    return saveChange({ tools: next });
  };
  const saveVision = (next: boolean) => {
    return saveChange({ vision: next });
  };

  return (
    <section class={classes.section}>
      <div class={classes.switchList}>
        <InstantSwitch
          label="Show in the model picker"
          hint="Off keeps it out of the list when choosing a model."
          on={shown}
          save={saveShown}
        />
        <InstantSwitch
          label="Tool use"
          hint="Can call tools while it works."
          on={tools}
          save={saveTools}
        />
        <InstantSwitch
          label="Image input"
          hint="Can read images you attach."
          on={vision}
          save={saveVision}
        />
      </div>
    </section>
  );
}
