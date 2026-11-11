import type { Cell } from "retend";
import type { JSX } from "retend/jsx-runtime";

import classes from "./PendingPage.module.css";

interface PendingPageProps {
  /** Whether a replacement page is loading. */
  switching: Cell<boolean>;
  children: JSX.Children;
}

/**
 * Keep the current page visible while its replacement loads. Make it inert and dim it
 * immediately without adding a layout wrapper.
 */
export function PendingPage(props: PendingPageProps) {
  const { switching, children } = props;
  return (
    <div
      class={classes.pendingPage}
      data-pending={switching}
      inert={switching}
      aria-busy={switching}
    >
      {children}
    </div>
  );
}
