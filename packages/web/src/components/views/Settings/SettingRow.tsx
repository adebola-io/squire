import { If } from "retend";
import type { JSX } from "retend/jsx-runtime";

import classes from "./SettingRow.module.css";

interface SettingRowProps {
  label: string;
  labelFor?: string;
  hint: JSX.Children;
  children: JSX.Children;
}

/** Shared settings-row layout for label, description and control. */
export function SettingRow(props: SettingRowProps) {
  const { label, labelFor, hint, children } = props;
  return (
    <div class={classes.row}>
      <div class={classes.text}>
        {If(labelFor !== undefined, {
          true: () => (
            <label class={classes.label} for={labelFor} title={label}>
              {label}
            </label>
          ),
          false: () => (
            <span class={classes.label} title={label}>
              {label}
            </span>
          ),
        })}
        <div class={classes.hint}>{hint}</div>
      </div>
      <div class={classes.control}>{children}</div>
    </div>
  );
}
