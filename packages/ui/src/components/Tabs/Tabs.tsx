import { Cell, For } from "retend";
import type { JSX } from "retend/jsx-runtime";

import classes from "./Tabs.module.css";

export interface TabOption<T extends string> {
  value: T;
  label: string;
}

interface TabsProps<T extends string> {
  value: Cell<T>;
  onChange: (value: T) => void;
  tabs: TabOption<T>[];
  label: string;
  class?: JSX.ValueOrCellOrPromise<string | undefined>;
}

export function Tabs<T extends string>(props: TabsProps<T>) {
  const { value, onChange, tabs, label, class: className } = props;

  return (
    <div class={[classes.tabs, className]} role="tablist" aria-label={label}>
      {For(tabs, (tab) => {
        const selected = Cell.derived(() => value.get() === tab.value);
        return (
          <button
            class={classes.tab}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => {
              onChange(tab.value);
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
