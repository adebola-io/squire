import { For } from "retend";

import { NestedValue } from "./ToolValue";
import { valuePages } from "./ToolValuePages";

import classes from "./ToolValue.module.css";

interface ValueTableProps {
  entries: readonly (readonly [string, unknown])[];
}

export function ValueTable(props: ValueTableProps) {
  const { entries } = props;
  const { visible, controls } = valuePages(entries, "Tool value pages", ([key]) => key);

  if (entries.length === 0) return <span class={classes.muted}>Empty object</span>;
  return (
    <div class={classes.tableGroup}>
      <div class={classes.tableScroll}>
        <table class={classes.table} aria-label="Tool data">
          <tbody>
            {For(
              visible,
              ({ value: [key, value] }) => (
                <tr>
                  <th title={key}>{key}</th>
                  <td>
                    <NestedValue value={value} name={key} />
                  </td>
                </tr>
              ),
              { key: "key" },
            )}
          </tbody>
        </table>
      </div>
      {controls}
    </div>
  );
}
