import { Cell, If } from "retend";
import { Button, Icon } from "squire-ui";

import classes from "./LoadingState.module.css";

interface LoadingStateProps {
  label: string;
  /** Fill the route content cell. */
  screen?: boolean;
  /** Fill the available space within a panel or content region. */
  region?: boolean;
  error?: Cell<string | null>;
  onRetry?: () => void;
}

/** Async loading indicator with delayed display and retryable errors. */
export function LoadingState(props: LoadingStateProps) {
  const { label, screen = false, region = false, error, onRetry } = props;
  const failure = Cell.derived(() => error?.get() ?? null);
  const busy = Cell.derived(() => failure.get() === null);
  return (
    <div class={classes.loading} data-screen={screen} data-region={region} aria-busy={busy}>
      {If(failure, {
        true: (message) => (
          <div class={classes.failure} role="alert">
            <p title={message}>{message}</p>
            {If(onRetry, () => (
              <Button variant="outline" onClick={onRetry}>
                Retry
              </Button>
            ))}
          </div>
        ),
        false: () => (
          <div class={classes.waiting} role="status" aria-label={label}>
            <Icon name="loading" class={classes.spinner} aria-hidden="true" />
            <span>{label}</span>
          </div>
        ),
      })}
    </div>
  );
}
