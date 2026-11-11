import { For } from "retend";

import { NestedValue } from "./ToolValue";
import { valuePages } from "./ToolValuePages";

import classes from "./ToolValue.module.css";

interface ValueArrayProps {
  items: readonly unknown[];
}

/** Render arrays as lists and objects as key/value tables. */
export function ValueArray(props: ValueArrayProps) {
  const { items } = props;
  const { visible, controls } = valuePages(items, "Array pages", (_, index) => String(index));

  if (items.length === 0) return <span class={classes.muted}>Empty array</span>;
  return (
    <div class={classes.arrayGroup}>
      <ul class={classes.arrayValues}>
        {For(
          visible,
          ({ value }) => (
            <li class={classes.arrayItem}>
              <NestedValue value={value} name="item" />
            </li>
          ),
          { key: "key" },
        )}
      </ul>
      {controls}
    </div>
  );
}
