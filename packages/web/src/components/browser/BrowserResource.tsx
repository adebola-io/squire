import { Cell, For, If, onSetup } from "retend";
import { Button, Dialog, Icon } from "squire-ui";

import {
  getBrowserTabs,
  type BrowserScopeKind,
  type BrowserTab,
  type BrowserViewport,
} from "@/platform/browserViewer";
import { onDesktopEvent } from "@/scopes/DesktopEventsScope";

import { BrowserFavicon } from "./BrowserFavicon";
import { BrowserViewer } from "./BrowserViewer";

import classes from "./Browser.module.css";

interface BrowserResourceProps {
  kind: BrowserScopeKind;
  id: string;
  variant?: "chat" | "thread";
}

/** Resource state belongs to the scope, not to the modal's short-lived stream. */
export function BrowserResource(props: BrowserResourceProps) {
  const { kind, id, variant } = props;
  const isThread = variant === "thread";
  const tabs = Cell.source<BrowserTab[]>([]);
  const opened = Cell.source(false);
  const shellViewport = Cell.source<BrowserViewport>({ width: 1120, height: 630 });
  const threadMode = Cell.source(isThread);
  const chatMode = Cell.source(!isThread);
  const load = Cell.task(async () => {
    const result = await getBrowserTabs(kind, id);
    tabs.set(result);
    if (opened.get() && result.length === 0) opened.set(false);
    if (!opened.get() && result[0]?.viewport) shellViewport.set(result[0].viewport);
  });
  const shellWidth = Cell.derived(() => shellViewport.get().width + "px");
  const shellAspect = Cell.derived(() =>
    String(shellViewport.get().width / shellViewport.get().height),
  );
  const shellInverseAspect = Cell.derived(() =>
    String(shellViewport.get().height / shellViewport.get().width),
  );
  const count = Cell.derived(() => tabs.get().length);
  const hasTabs = Cell.derived(() => count.get() > 0);
  const viewerReady = Cell.derived(() => opened.get() && tabs.get().length > 0);
  const viewerLoading = Cell.derived(() => opened.get() && tabs.get().length === 0);
  const label = Cell.derived(
    () => "Browser · " + count.get() + (count.get() === 1 ? " tab" : " tabs"),
  );
  const previewTabs = Cell.derived(() => tabs.get().slice(0, 3));
  const remaining = Cell.derived(() => Math.max(0, count.get() - 3));
  const showChatRemaining = Cell.derived(() => !isThread && remaining.get() > 0);
  const threadTabText = Cell.derived(() => (count.get() === 1 ? "1 tab" : count.get() + " tabs"));
  const rootClass = isThread ? classes.threadResource : classes.chatResource;
  const scope = kind + ":" + id;
  const failure = Cell.derived(() => load.error.get()?.message ?? null);
  const waitingWithoutError = Cell.derived(() => failure.get() === null);

  let queued = false;
  const refresh = async () => {
    if (load.pending.get()) {
      queued = true;
      return;
    }
    await load.runWith(null);
    if (queued) {
      queued = false;
      await refresh();
    }
  };
  const close = () => opened.set(false);

  onSetup(() => {
    void refresh();
  });
  onDesktopEvent("browser.tabs.changed", (event) => {
    if (!event.scope || event.scope === scope) void refresh();
  });
  onDesktopEvent("connection.opened", () => void refresh());

  return If(hasTabs, () => (
    <Dialog
      id={"browser-viewer-" + kind + "-" + id}
      open={opened}
      onOpenChange={(next) => opened.set(next)}
    >
      <div class={rootClass}>
        <Dialog.Trigger>
          <Button variant="outline" type="button" class={classes.resourcePill} aria-label={label}>
            <Icon name="browser" class={classes.resourceIcon} aria-hidden="true" />
            <span class={classes.resourceLabel}>Browser</span>
            {If(threadMode, () => (
              <span class={classes.threadLiveDot} title="Browser active" />
            ))}
            {If(threadMode, () => (
              <span class={classes.threadTabCount}>{threadTabText}</span>
            ))}
            {If(chatMode, () => (
              <span class={classes.resourceFavicons} aria-hidden="true">
                {For(
                  previewTabs,
                  (tab) => (
                    <span class={classes.resourceFavicon}>
                      <BrowserFavicon url={tab.url} />
                    </span>
                  ),
                  { key: "tab" },
                )}
              </span>
            ))}
            {If(showChatRemaining, () => (
              <span class={classes.resourceExtra}>+{remaining}</span>
            ))}
          </Button>
        </Dialog.Trigger>
      </div>
      <Dialog.Content
        size="larger"
        class={classes.dialog}
        ariaLabel="Browser viewer"
        data-color-scheme="dark"
        style={{
          "--browser-content-width": shellWidth,
          "--browser-content-aspect": shellAspect,
          "--browser-content-inverse-aspect": shellInverseAspect,
        }}
      >
        {If(viewerLoading, () => (
          <div class={classes.viewerLoading} role="status">
            {If(waitingWithoutError, () => (
              <span>Opening browser…</span>
            ))}
            {If(failure, (message) => (
              <div>
                <p>{message}</p>
                <Button variant="ghost" type="button" onClick={() => void refresh()}>
                  Try again
                </Button>
              </div>
            ))}
          </div>
        ))}
        {If(viewerReady, () => (
          <BrowserViewer
            kind={kind}
            id={id}
            tabs={tabs}
            onRefresh={refresh}
            onClose={close}
            onViewportChange={(size) => shellViewport.set(size)}
            error={failure}
          />
        ))}
      </Dialog.Content>
    </Dialog>
  ));
}
