import { Cell, For, If, Switch } from "retend";
import { Button, FadeScroll, Icon, isIconName } from "squire-ui";

import { ChatGPTConnection } from "@/components/views/Settings/ChatGPTConnection";
import { ProfileForm } from "@/components/views/Settings/ProfileForm";
import { initialLetter } from "@/components/views/Settings/ProviderMark";
import type { DesktopProviderProfile } from "@/platform/desktopClient";
import { useChat } from "@/scopes/ChatScope";

import { Footnote, KeyForm } from "./ProviderKeyForm";
import { ProviderRow } from "./ProviderRow";

import classes from "./Onboarding.module.css";

interface StepProps {
  next: () => void;
}

type Selection = { type: "profile"; profile: DesktopProviderProfile } | { type: "custom" };

/** Provider kinds listed first, in this order. */
const FEATURED = ["chatgpt", "openai", "anthropic", "google", "openrouter"];

/** Model providers, from a list to one provider's connection, inside one dialog. */
export function ProvidersContent(props: StepProps) {
  const { next } = props;
  const { providers, refreshProviders } = useChat();
  const selected = Cell.source<Selection | null>(null);
  const back = () => {
    refreshProviders();
    selected.set(null);
  };
  // The services most people start with first, as in the design, then the other built-in
  // services, then providers the person already added.
  const rows = Cell.derivedAsync(async (get) => {
    const { profiles } = await get(providers);
    const rank = (p: DesktopProviderProfile) => {
      const featured = FEATURED.indexOf(p.kind);
      if (featured !== -1) return featured;
      return p.builtin ? FEATURED.length : FEATURED.length + 1;
    };
    return [...profiles].sort((a, b) => rank(a) - rank(b));
  });
  const view = Cell.derived(() => {
    const current = selected.get();
    if (current === null) return "list";
    if (current.type === "custom") return "custom";
    return current.profile.kind === "chatgpt" ? "chatgpt" : "key";
  });
  const chosen = () => {
    const current = selected.get();
    return current?.type === "profile" ? current.profile : null;
  };
  const backLink = () => (
    <button type="button" class={classes.backLink} onClick={back}>
      <Icon name="caret" aria-hidden="true" />
      Providers
    </button>
  );

  return Switch(view, {
    list: () => (
      <>
        <h1>Providers</h1>
        <p>Connect a model service to chat in Squire. You can add more later in Settings.</p>
        {If(providers.error, (error) => (
          <p class={classes.error} role="alert">
            Couldn’t load providers: {error.message}{" "}
            <button class={classes.retryLink} type="button" onClick={refreshProviders}>
              Try again
            </button>
          </p>
        ))}
        <FadeScroll class={classes.scroller}>
          <ul class={classes.providerRows}>
            {For(
              rows,
              (profile) => (
                <ProviderRow
                  profile={profile}
                  select={() => selected.set({ type: "profile", profile })}
                />
              ),
              { key: "id" },
            )}
            <li>
              <button type="button" onClick={() => selected.set({ type: "custom" })}>
                <span class={classes.customMark} aria-hidden="true">
                  <Icon name="extension" />
                </span>
                <span class={classes.rowText}>
                  <strong>Local or custom</strong>
                  <span>Connect a local model server</span>
                </span>
                <span class={classes.rowAction}>
                  Set up
                  <Icon name="caret" class={classes.rowCaret} aria-hidden="true" />
                </span>
              </button>
            </li>
          </ul>
        </FadeScroll>
        <Footnote />
        <div class={classes.actions}>
          <Button variant="outline" onClick={next}>
            Skip
          </Button>
          <Button onClick={next}>Continue</Button>
        </div>
      </>
    ),
    key: () => {
      const profile = chosen();
      if (profile === null) return null;
      const mark = isIconName(profile.icon) ? (
        <Icon name={profile.icon} />
      ) : (
        initialLetter(profile.displayName)
      );
      return (
        <>
          {backLink()}
          <h1>Connect {profile.displayName}</h1>
          <p>Add your {profile.displayName} API key to use its models in Chat.</p>
          <div class={classes.selectedProvider}>
            <span class={classes.customMark} aria-hidden="true">
              {mark}
            </span>
            <span class={classes.rowText}>
              <strong>{profile.displayName}</strong>
              <span>API key connection</span>
            </span>
          </div>
          <KeyForm profile={profile} done={back} />
        </>
      );
    },
    chatgpt: () => (
      <>
        {backLink()}
        <h1>Connect ChatGPT</h1>
        <p>Use your ChatGPT subscription in Squire.</p>
        <FadeScroll class={classes.scroller}>
          <ChatGPTConnection />
        </FadeScroll>
        <Footnote />
        <div class={classes.actions}>
          <Button variant="outline" onClick={back}>
            Back to providers
          </Button>
        </div>
      </>
    ),
    custom: () => (
      <>
        {backLink()}
        <h1>Local or custom</h1>
        <p>Connect a local model server or another OpenAI-compatible service.</p>
        <FadeScroll class={classes.scroller}>
          <ProfileForm onSaved={back} onCancel={back} />
        </FadeScroll>
      </>
    ),
  });
}
