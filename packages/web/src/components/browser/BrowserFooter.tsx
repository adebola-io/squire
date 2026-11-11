import { Cell, If } from "retend";

import type { useBrowserViewer } from "./useBrowserViewer";

import classes from "./Browser.module.css";

interface BrowserFooterProps {
  view: ReturnType<typeof useBrowserViewer>;
  error: Cell<string | null>;
}

export function BrowserFooter(props: BrowserFooterProps) {
  const { view, error } = props;
  const { status, detachError } = view;
  const feedback = Cell.derived(() => detachError.get() ?? error.get() ?? status.get());
  return If(feedback, (message) => (
    <footer class={classes.footer} role="status">
      {message}
    </footer>
  ));
}
