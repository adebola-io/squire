import { Cell, If } from "retend";
import { Button } from "squire-ui";

import type { useBrowserViewer } from "./useBrowserViewer";

import classes from "./Browser.module.css";

interface Props {
  view: ReturnType<typeof useBrowserViewer>;
}

export function BrowserViewportNotice(props: Props) {
  const { viewport, tab, currentSize, viewportChanged, send } = props.view;
  const viewportName = Cell.derived(() => {
    const size = viewport.get();
    return size.width <= 430 ? "Phone" : size.width <= 850 ? "Tablet" : "Desktop";
  });
  const defaultSize = Cell.derived(() => {
    const size = tab.get()?.defaultViewport;
    return size ? size.width + " × " + size.height : "";
  });
  const reset = () => {
    const size = tab.get()?.defaultViewport;
    if (size) send({ type: "resize", ...size });
  };
  return If(viewportChanged, () => (
    <div class={classes.viewportNotice}>
      <span>
        <strong>
          {viewportName} viewport · {currentSize}
        </strong>{" "}
        · resized
      </span>
      <Button variant="ghost" type="button" onClick={reset}>
        Reset to {defaultSize}
      </Button>
    </div>
  ));
}
