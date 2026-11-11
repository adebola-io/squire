import { Cell, For, If } from "retend";
import type { Cell as ReadCell } from "retend";
import { Button } from "squire-ui";

import { Select } from "@/components/ui/Select";
import type { BrowserApplication, BrowserSettingsResponse } from "@/platform/desktopClient";

import { SettingRow } from "./SettingRow";
import type { BrowserSettingsModel } from "./useBrowserSettings";

import browserClasses from "./BrowserSettings.module.css";
import deletion from "./DataDeletionSettings.module.css";
import classes from "./SettingsEditor.module.css";

interface ApplicationOptionProps {
  browser: BrowserApplication;
  selection: ReadCell<string>;
}
function ApplicationOption(props: ApplicationOptionProps) {
  const { browser, selection } = props;
  const selected = Cell.derived(() => selection.get() === browser.executable);
  return (
    <option value={browser.executable} selected={selected}>
      {browser.label}
    </option>
  );
}
interface FormProps {
  model: BrowserSettingsModel;
  settings: BrowserSettingsResponse;
}
export function BrowserSettingsForm(props: FormProps) {
  const { model, settings } = props;
  const available = settings.browsers.length > 0;
  // Prefer an unapplied browser selection to the saved selection.
  const selection = Cell.derived(() => model.choice.get() ?? settings.selected);
  const browserDisabled = Cell.derived(() => model.busy.get() || !available);
  const openDisabled = Cell.derived(() => model.busy.get() || !settings.graphical || !available);
  let openHint =
    "This host has no graphical session. Browser tasks run headlessly; opening a window is unavailable.";
  if (settings.graphical) {
    openHint = "Open the browser to sign in or complete website verification.";
  }
  return (
    <form class={classes.form} aria-busy={model.busy}>
      <div class={classes.groupFields}>
        <SettingRow
          label="Browser application"
          labelFor="browser-application"
          hint="Choose an installed browser. Changing it clears saved website data after confirmation."
        >
          <Select
            id="browser-application"
            class={classes.input}
            disabled={browserDisabled}
            onChange={(event: Event) => {
              model.choose(event, settings);
            }}
          >
            {If(!available, () => {
              return <option value="">No compatible browser installed</option>;
            })}
            {For(
              settings.browsers,
              (browser) => {
                return <ApplicationOption browser={browser} selection={selection} />;
              },
              { key: "executable" },
            )}
          </Select>
          {If(!available, () => {
            return (
              <>
                <p class={classes.notice}>Install Chrome, Edge, Brave or Chromium, then retry.</p>
                <Button variant="outline" disabled={model.busy} onClick={model.redetect}>
                  Retry
                </Button>
              </>
            );
          })}
        </SettingRow>
        <SettingRow label="Managed browser" hint={openHint}>
          <Button
            class={[classes.saveButton, browserClasses.action]}
            disabled={openDisabled}
            onClick={model.openBrowser}
          >
            Open Browser
          </Button>
        </SettingRow>
        <SettingRow
          label="Saved website data"
          hint="Clear saved website logins and site state in the shared browser."
        >
          <Button
            variant="outline"
            class={[deletion.trigger, classes.saveButton, browserClasses.action]}
            disabled={model.busy}
            onClick={model.reset}
          >
            Reset browser data
          </Button>
        </SettingRow>
      </div>
      {If(model.success, (message) => {
        return (
          <p class={classes.success} role="status">
            {message}
          </p>
        );
      })}
      {If(model.error, (message) => {
        return (
          <p class={classes.error} role="alert">
            {message}
          </p>
        );
      })}
    </form>
  );
}
