import { Cell, If } from "retend";
import { Button, Icon } from "squire-ui";

import { BrowserOverview } from "./BrowserOverview";
import type { useBrowserViewer, BrowserViewerProps } from "./useBrowserViewer";

import classes from "./Browser.module.css";

interface Props {
  view: ReturnType<typeof useBrowserViewer>;
  kind: BrowserViewerProps["kind"];
  id: string;
  tabs: BrowserViewerProps["tabs"];
  onClose: () => void;
}

export function BrowserStage(props: Props) {
  const { view, kind, id, tabs, onClose } = props;
  const {
    stage,
    picture,
    zoom,
    overview,
    hasFrame,
    surfaceWidth,
    surfaceHeight,
    click,
    wheel,
    touchStart,
    touchMove,
    keyDown,
    changeTab,
    remove,
  } = view;

  return (
    <main
      class={classes.stage}
      ref={stage}
      data-zoom={zoom}
      tabIndex={0}
      onKeyDown={keyDown}
      onWheel={wheel}
      onTouchStart={touchStart}
      onTouchMove={touchMove}
    >
      <div class={classes.surface} style={{ width: surfaceWidth, height: surfaceHeight }}>
        <canvas
          ref={picture}
          class={classes.frame}
          role="img"
          aria-label="Live browser tab"
          data-ready={hasFrame}
          onClick={click}
          style={{ width: surfaceWidth, height: surfaceHeight }}
        />
      </div>
      {If(overview, () => (
        <BrowserOverview tabs={tabs} kind={kind} id={id} onSelect={changeTab} onRemove={remove} />
      ))}
      <BrowserStatusOverlay view={view} onClose={onClose} />
    </main>
  );
}

function BrowserStatusOverlay(props: Pick<Props, "view" | "onClose">) {
  const { view, onClose } = props;
  const { state, overview, connectionStatusVisible, hasFrame, refresh } = view;
  const showStatus = Cell.derived(
    () =>
      !overview.get() &&
      (state.get() === "offline" || (state.get() !== "live" && connectionStatusVisible.get())),
  );
  const connecting = Cell.derived(() => state.get() === "connecting");
  const reconnecting = Cell.derived(() => state.get() === "reconnecting");
  const offline = Cell.derived(() => state.get() === "offline");

  return If(showStatus, () => (
    <div class={classes.statusOverlay} data-previous-frame={hasFrame} role="status">
      {If(connecting, () => (
        <div class={classes.statusPill}>
          <span class={classes.statusSpinner} aria-hidden="true" />
          <span>Connecting to the browser…</span>
        </div>
      ))}
      {If(reconnecting, () => (
        <div class={classes.statusPill}>
          <span class={classes.statusSpinner} aria-hidden="true" />
          <span class={classes.statusMessage}>
            Connection lost. Reconnecting…
            <small>Input is paused until the stream is back</small>
          </span>
        </div>
      ))}
      {If(offline, () => (
        <div class={classes.offlineCard}>
          <span class={classes.offlineIcon}>
            <Icon name="browser" aria-hidden="true" />
          </span>
          <h2>Can’t reach the browser host</h2>
          <p>
            The computer running this browser may be asleep, offline, or no longer running Squire.
            Your tabs remain open there and can reappear when the connection returns.
          </p>
          <div class={classes.offlineActions}>
            <Button variant="outline" type="button" class={classes.offlineRetry} onClick={refresh}>
              Try again
            </Button>
            <Button variant="ghost" type="button" onClick={onClose}>
              Back to chat
            </Button>
          </div>
        </div>
      ))}
    </div>
  ));
}
