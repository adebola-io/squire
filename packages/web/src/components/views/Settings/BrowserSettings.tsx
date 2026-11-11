import { Await, If } from "retend";

import { LoadingState } from "@/components/ui/LoadingState";

import { BrowserConfirmation } from "./BrowserConfirmation";
import { BrowserSettingsForm } from "./BrowserSettingsForm";
import { useBrowserSettings } from "./useBrowserSettings";

import classes from "./SettingsEditor.module.css";

export function BrowserSettings() {
  const model = useBrowserSettings();
  // Show loading or retry feedback until the first successful read. Reuse settings already
  // loaded at startup.
  const unavailable = () => {
    return (
      <LoadingState
        region
        label="Loading browser settings…"
        error={model.loadError}
        onRetry={model.redetect}
      />
    );
  };
  return (
    <section class={classes.page}>
      <div class={classes.content}>
        <header class={classes.heading}>
          <h1 class={classes.title} title="Browser">
            Browser
          </h1>
          <p class={classes.subtitle}>Website logins are saved in Squire’s managed browser.</p>
        </header>
        <Await fallback={unavailable()}>
          {If(
            model.settings,
            (settings) => {
              return <BrowserSettingsForm model={model} settings={settings} />;
            },
            unavailable,
          )}
        </Await>
        {If(model.open, () => {
          return <BrowserConfirmation model={model} />;
        })}
      </div>
    </section>
  );
}
