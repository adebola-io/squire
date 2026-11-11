import { Cell, If, Switch } from "retend";
import { Button, Icon } from "squire-ui";

import { completeOnboarding } from "@/platform/desktopClient";
import { PluginStateProvider } from "@/scopes/PluginScope";
import { WorkspaceStateProvider } from "@/scopes/WorkspaceScope";

import { AccountStep } from "./AccountStep";
import { PluginContent } from "./PluginContent";
import { ProvidersContent } from "./ProvidersContent";
import { SetupDialog } from "./SetupDialog";
import { WelcomeBackdrop } from "./WelcomeBackdrop";
import { WorkspaceContent } from "./WorkspaceContent";

import classes from "./Onboarding.module.css";

type Step = "welcome" | "account" | "workspaces" | "providers" | "plugins" | "done";

/** First-run setup. `Shell` renders it only once Squire reports onboarding as pending. */
export function Onboarding() {
  const step = Cell.source<Step>("welcome");
  const completion = Cell.task(async (_: null) => {
    await completeOnboarding();
    step.set("done");
  });
  const failure = Cell.derived(() => {
    const error = completion.error.get();
    return error === null ? null : error.message || "Could not save onboarding progress.";
  });
  const finish = () => {
    if (!completion.pending.get()) void completion.runWith(null);
  };
  return (
    <>
      {Switch(step, {
        welcome: () => (
          <div class={classes.welcome} data-color-scheme="dark">
            <WelcomeBackdrop />
            <div class={classes.welcomeContent}>
              <Icon name="squire" class={classes.mark} aria-hidden="true" />
              <h1>Squire works on your computer</h1>
              <p>
                It reads, runs and edits inside the folders you add, using the models and plugins
                you enable.
              </p>
              <Button onClick={() => step.set("account")}>
                <Icon name="arrow" aria-hidden="true" />
                Get started
              </Button>
            </div>
          </div>
        ),
        account: () => <AccountStep next={() => step.set("workspaces")} />,
        workspaces: () => {
          const next = () => step.set("providers");
          return (
            <SetupDialog id="onboarding-workspaces" label="Workspaces" onClose={next}>
              <WorkspaceStateProvider>
                <WorkspaceContent next={next} />
              </WorkspaceStateProvider>
            </SetupDialog>
          );
        },
        providers: () => {
          const next = () => step.set("plugins");
          return (
            <SetupDialog id="onboarding-providers" label="Providers" onClose={next} fill>
              <ProvidersContent next={next} />
            </SetupDialog>
          );
        },
        plugins: () => (
          <SetupDialog id="onboarding-plugins" label="Plugins" onClose={finish} fill>
            <PluginStateProvider>
              <PluginContent finish={finish} finishing={completion.pending} />
            </PluginStateProvider>
          </SetupDialog>
        ),
        done: () => null,
      })}
      {If(failure, (text) => (
        <p class={classes.saveError} role="alert">
          {text}
        </p>
      ))}
    </>
  );
}
