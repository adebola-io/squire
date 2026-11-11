import type { Cell, SourceCell } from "retend";
import { Icon } from "squire-ui";

import classes from "./Plugins.module.css";

interface AdvancedToggleProps {
  showAdvanced: SourceCell<boolean>;
  label: Cell<string>;
  onToggle: () => void;
}

export function AdvancedToggle(props: AdvancedToggleProps) {
  const { showAdvanced, label, onToggle } = props;
  return (
    <button
      type="button"
      class={classes.mcpAdvancedToggle}
      onClick={onToggle}
      aria-expanded={showAdvanced}
    >
      <Icon name="caret" aria-hidden="true" />
      <span title={label}>{label}</span>
    </button>
  );
}
