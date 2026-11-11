import { Menu } from "innate-ui";
import { Cell, If } from "retend";
import { Button, Icon } from "squire-ui";

import { BrowserViewportIcon } from "./BrowserChromeControls";
import { BrowserBackIcon, BrowserForwardIcon } from "./BrowserChromeIcons";
import type { useBrowserViewer } from "./useBrowserViewer";

import classes from "./Browser.module.css";

interface Props {
  view: ReturnType<typeof useBrowserViewer>;
}

export function BrowserToolbar(props: Props) {
  const { view } = props;
  const { tab, cannotInput, send } = view;
  const url = Cell.derived(() => tab.get()?.url ?? "");
  const address = Cell.derived(() => {
    const value = url.get();
    try {
      const page = new URL(value);
      return page.protocol === "http:" || page.protocol === "https:"
        ? page.host + page.pathname + page.search + page.hash
        : value;
    } catch {
      return value || "No live tab";
    }
  });
  const secure = Cell.derived(() => url.get().startsWith("https://"));

  return (
    <div class={classes.toolbar}>
      <Button
        variant="ghost"
        type="button"
        class={classes.iconButton}
        title="Back"
        aria-label="Back"
        disabled={cannotInput}
        onClick={() => send({ type: "back" })}
      >
        <BrowserBackIcon />
      </Button>
      <Button
        variant="ghost"
        type="button"
        class={classes.iconButton}
        title="Forward"
        aria-label="Forward"
        disabled={cannotInput}
        onClick={() => send({ type: "forward" })}
      >
        <BrowserForwardIcon />
      </Button>
      <Button
        variant="ghost"
        type="button"
        class={classes.iconButton}
        title="Reload"
        aria-label="Reload"
        disabled={cannotInput}
        onClick={() => send({ type: "reload" })}
      >
        <Icon name="refresh" aria-hidden="true" />
      </Button>
      <div class={classes.address} title={url}>
        {If(secure, () => (
          <Icon name="padlock" aria-hidden="true" />
        ))}
        <span>{address}</span>
      </div>
      <BrowserViewportMenu view={view} />
    </div>
  );
}

function BrowserViewportMenu(props: Props) {
  const { view } = props;
  const { currentSize, cannotInput, chooseSize } = view;
  return (
    <Menu side="bottom" align="end">
      <Menu.Trigger>
        <Button
          variant="ghost"
          type="button"
          class={classes.resizeTrigger}
          title="Change this tab’s browser viewport size"
          aria-label="Change browser viewport size"
          disabled={cannotInput}
        >
          <BrowserViewportIcon />
          <span class={classes.viewportValue}>{currentSize}</span>
          <Icon name="caret" class={classes.viewportCaret} aria-hidden="true" />
        </Button>
      </Menu.Trigger>
      <Menu.Content
        class={classes.viewportMenu}
        data-color-scheme="dark"
        aria-label="Browser viewport size"
      >
        <Menu.Label class={classes.viewportMenuLabel}>Tab viewport</Menu.Label>
        <Menu.Item class={classes.viewportMenuItem} onClick={() => chooseSize("desktop")}>
          Desktop · 1280 × 720
        </Menu.Item>
        <Menu.Item class={classes.viewportMenuItem} onClick={() => chooseSize("laptop")}>
          Laptop · 1120 × 630
        </Menu.Item>
        <Menu.Item class={classes.viewportMenuItem} onClick={() => chooseSize("tablet")}>
          Tablet · 820 × 1180
        </Menu.Item>
        <Menu.Item class={classes.viewportMenuItem} onClick={() => chooseSize("phone")}>
          Phone · 390 × 844
        </Menu.Item>
        <Menu.Item class={classes.viewportMenuItem} onClick={() => chooseSize("match")}>
          Match viewing area
        </Menu.Item>
        <Menu.Item class={classes.viewportMenuItem} onClick={() => chooseSize("reset")}>
          Restore original viewport
        </Menu.Item>
        <Menu.Label class={classes.viewportMenuLabel}>Preview only</Menu.Label>
        <Menu.Item class={classes.viewportMenuItem} onClick={() => chooseSize("fit")}>
          Fit entire page
        </Menu.Item>
        <Menu.Item class={classes.viewportMenuItem} onClick={() => chooseSize("zoom")}>
          Zoom and pan
        </Menu.Item>
      </Menu.Content>
    </Menu>
  );
}
