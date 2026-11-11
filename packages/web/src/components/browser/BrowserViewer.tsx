import { Textarea } from "squire-ui";

import { BrowserFooter } from "./BrowserFooter";
import { BrowserStage } from "./BrowserStage";
import { BrowserTabs } from "./BrowserTabs";
import { BrowserToolbar } from "./BrowserToolbar";
import { BrowserViewportNotice } from "./BrowserViewportNotice";
import { useBrowserViewer, type BrowserViewerProps } from "./useBrowserViewer";

import classes from "./Browser.module.css";

export function BrowserViewer(props: BrowserViewerProps) {
  const { kind, id, tabs, onClose, error } = props;
  const view = useBrowserViewer(props);
  const {
    selected,
    overview,
    keyboard,
    fieldInput,
    fieldKeyDown,
    fieldCompositionStart,
    fieldCompositionEnd,
    changeTab,
    remove,
  } = view;

  return (
    <div class={classes.viewer}>
      <BrowserTabs
        tabs={tabs}
        selected={selected}
        onSelect={changeTab}
        onRemove={remove}
        onOverview={() => overview.set(!overview.get())}
        onClose={onClose}
      />
      <BrowserToolbar view={view} />
      <BrowserViewportNotice view={view} />
      <BrowserStage view={view} kind={kind} id={id} tabs={tabs} onClose={onClose} />
      <BrowserFooter view={view} error={error} />
      <Textarea
        ref={keyboard}
        class={classes.mobileKeyboard}
        aria-label="Type into browser page"
        autoCapitalize="off"
        autoCorrect="off"
        onInput={fieldInput}
        onKeyDown={fieldKeyDown}
        onCompositionStart={fieldCompositionStart}
        onCompositionEnd={fieldCompositionEnd}
      />
    </div>
  );
}
