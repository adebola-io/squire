import { Cell, If, type SourceCell } from "retend";
import { Button } from "squire-ui";

import { useLiveValue } from "@/utils/fieldValue";

import classes from "./Providers.module.css";

interface CustomModelFormProps {
  open: Cell<boolean>;
  onSetUp: (id: string) => void;
}

/** Custom-model setup by explicit ID. */
export function CustomModelForm(props: CustomModelFormProps) {
  const { open, onSetUp } = props;
  const customId = Cell.source("");
  const customRef = useLiveValue(customId);
  const disabled = Cell.derived(() => {
    return customId.get().trim() === "";
  });
  const setId = (event: Event) => {
    customId.set((event.currentTarget as HTMLInputElement).value);
  };
  const submit = () => {
    const id = customId.get().trim();
    if (id === "") {
      return;
    }
    customId.set("");
    onSetUp(id);
  };

  return If(open, () => {
    return (
      <form class={classes.customModel} onSubmit--prevent={submit}>
        <label class={classes.field}>
          <span class={classes.fieldLabel}>Model ID</span>
          <input
            ref={customRef}
            class={classes.input}
            value={customId}
            placeholder="e.g. provider/model-name"
            onInput={setId}
          />
        </label>
        <Button type="submit" variant="outline" class={classes.quietButton} disabled={disabled}>
          Set up
        </Button>
      </form>
    );
  });
}

interface ModelListEmptyProps {
  noModels: Cell<boolean>;
  noMatches: Cell<boolean>;
  searchTerm: Cell<string>;
  showCustom: SourceCell<boolean>;
  onUseSearch: () => void;
  onClearSearch: () => void;
}

/** Empty and filtered-empty states with setup and search actions. */
export function ModelListEmpty(props: ModelListEmptyProps) {
  const { noModels, noMatches, searchTerm, showCustom, onUseSearch, onClearSearch } = props;
  const openCustom = () => {
    showCustom.set(true);
  };

  return (
    <>
      {If(noModels, () => {
        return (
          <div class={classes.emptyRow}>
            <p class={classes.status}>This provider listed no models.</p>
            <Button variant="outline" class={classes.quietButton} onClick={openCustom}>
              Set up a model by ID
            </Button>
          </div>
        );
      })}
      {If(noMatches, () => {
        return (
          <div class={classes.emptyRow}>
            <p class={classes.status} title={searchTerm}>
              No models match “{searchTerm}”.
            </p>
            <Button variant="outline" class={classes.quietButton} onClick={onUseSearch}>
              Set up “{searchTerm}” by ID
            </Button>
            <Button variant="ghost" class={classes.quietButton} onClick={onClearSearch}>
              Clear search
            </Button>
          </div>
        );
      })}
    </>
  );
}
