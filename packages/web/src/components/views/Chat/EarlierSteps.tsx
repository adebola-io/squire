import { Cell } from "retend";

import classes from "./WorkLog.module.css";

interface EarlierStepsProps {
  count: number | null;
  loading: Cell<boolean>;
  onShow: () => void;
}

/** Reveal the previous page of execution steps. */
export function EarlierSteps(props: EarlierStepsProps) {
  const { count, loading, onShow } = props;
  const label =
    count === null
      ? "Load earlier steps"
      : count === 1
        ? "Show 1 earlier step"
        : `Show ${count} earlier steps`;

  return (
    <li class={classes.earlier}>
      <button type="button" class={classes.earlierButton} disabled={loading} onClick={onShow}>
        {label}
      </button>
    </li>
  );
}
