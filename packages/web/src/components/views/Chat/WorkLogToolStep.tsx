import { If } from "retend";
import type { JSX } from "retend/jsx-runtime";
import { Icon, type IconName } from "squire-ui";

import type { ToolCallStatus } from "@/platform/desktopEvents";

import { ChatToolIcon } from "./ChatToolIcon";

import classes from "./WorkLog.module.css";

interface ToolStepProps {
  kind?: "reasoning";
  label: JSX.ValueOrCellOrPromise<string>;
  icon: JSX.ValueOrCellOrPromise<IconName>;
  status: JSX.ValueOrCellOrPromise<ToolCallStatus | "complete">;
  pluginId?: JSX.ValueOrCellOrPromise<string | null>;
  selected?: JSX.ValueOrCellOrPromise<boolean>;
  title?: JSX.ValueOrCellOrPromise<string>;
  outcome?: JSX.ValueOrCellOrPromise<string>;
  onSelect?: () => void;
  children?: JSX.Children;
}

/** Shared execution row. Optional content sits below the same tool label and icon. */
export function ToolStep(props: ToolStepProps) {
  const { kind, label, icon, status, pluginId, selected, title, outcome, onSelect, children } =
    props;
  const reasoning = kind === "reasoning" ? "true" : undefined;
  const selectable = onSelect !== undefined;
  const heading = (
    <span class={classes.toolMain}>
      <span class={classes.toolLabel} title={label}>
        <span class={classes.toolLabelText}>{label}</span>
      </span>
      {If(outcome !== undefined, () => (
        <span class={classes.toolMeta}>
          <span>{outcome}</span>
        </span>
      ))}
      {If(selectable, () => (
        <Icon name="caret" class={classes.chevron} aria-hidden="true" />
      ))}
    </span>
  );

  return (
    <li class={classes.step} data-kind="tool" data-status={status} data-reasoning={reasoning}>
      <span class={classes.marker} aria-hidden="true">
        <ChatToolIcon name={icon} pluginId={pluginId} />
      </span>
      {If(selectable, {
        true: () => (
          <button
            type="button"
            class={classes.toolSummary}
            data-selected={selected}
            onClick={onSelect}
            aria-label={title}
          >
            {heading}
          </button>
        ),
        false: () => <div class={classes.toolSummary}>{heading}</div>,
      })}
      {children}
    </li>
  );
}
