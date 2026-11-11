import { Cell, If } from "retend";

import { TOOL_VALUE_PAGE_SIZE } from "./ToolValue";

import classes from "./ToolValue.module.css";

/** Shared pagination controls for array and object output. */
export function valuePages<T>(
  items: readonly T[],
  label: string,
  key: (item: T, index: number) => string,
) {
  const page = Cell.source(0);
  const count = Math.ceil(items.length / TOOL_VALUE_PAGE_SIZE);
  const visible = Cell.derived(() => {
    const start = page.get() * TOOL_VALUE_PAGE_SIZE;
    return items.slice(start, start + TOOL_VALUE_PAGE_SIZE).map((value, index) => ({
      key: key(value, start + index),
      value,
    }));
  });
  const previousDisabled = Cell.derived(() => page.get() === 0);
  const nextDisabled = Cell.derived(() => page.get() + 1 >= count);
  const position = Cell.derived(() => `${page.get() + 1} of ${count}`);
  const controls = If(count > 1, () => (
    <nav class={classes.pages} aria-label={label}>
      <button type="button" disabled={previousDisabled} onClick={() => page.set(page.get() - 1)}>
        Previous
      </button>
      <span>{position}</span>
      <button type="button" disabled={nextDisabled} onClick={() => page.set(page.get() + 1)}>
        Next
      </button>
    </nav>
  ));
  return { visible, controls };
}
