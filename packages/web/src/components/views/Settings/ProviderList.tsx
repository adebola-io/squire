import { type AsyncCell, Cell, For, If } from "retend";
import { Button, Icon } from "squire-ui";

import { AppLink } from "@/components/ui/AppLink";
import type { DesktopProviderProfile } from "@/platform/desktopClient";
import { useChat } from "@/scopes/ChatScope";

import { AddProvider } from "./AddProvider";
import { ProviderMark } from "./ProviderMark";

import classes from "./Providers.module.css";

/** A custom provider or a configured built-in provider. */
export function isConnected(profile: DesktopProviderProfile) {
  return !profile.builtin || profile.configured;
}

export function providerPath(id: string) {
  return `/settings/providers/${encodeURIComponent(id)}`;
}

interface ProviderRowProps {
  profile: DesktopProviderProfile;
}

function ProviderRow(props: ProviderRowProps) {
  const { profile } = props;
  return (
    <li>
      <AppLink href={providerPath(profile.id)} class={classes.providerRow}>
        <ProviderMark icon={profile.icon} name={profile.displayName} />
        <span class={classes.cardName} title={profile.displayName}>
          {profile.displayName}
        </span>
        <Icon name="caret" class={classes.rowCaret} aria-hidden="true" />
      </AppLink>
    </li>
  );
}

interface ProviderGroupProps {
  id: string;
  heading: string;
  hint: string;
  profiles: AsyncCell<DesktopProviderProfile[]>;
}

function ProviderGroup(props: ProviderGroupProps) {
  const { id, heading, hint, profiles } = props;
  const hasAny = Cell.derivedAsync(async (get) => {
    return (await get(profiles)).length > 0;
  });
  return If(hasAny, () => {
    return (
      <section class={classes.providerGroup} aria-labelledby={id}>
        <header class={classes.sectionHeader}>
          <h2 id={id}>{heading}</h2>
          <p>{hint}</p>
        </header>
        <ul class={classes.providerList}>
          {For(
            profiles,
            (profile) => {
              return <ProviderRow profile={profile} />;
            },
            { key: "id" },
          )}
        </ul>
      </section>
    );
  });
}

/** Group configured providers before providers that still need credentials. */
export function ProviderList() {
  const { providers, refreshProviders } = useChat();
  const profiles = Cell.derivedAsync(async (get) => {
    return (await get(providers)).profiles;
  });
  const connected = Cell.derivedAsync(async (get) => {
    return (await get(profiles)).filter(isConnected);
  });
  const available = Cell.derivedAsync(async (get) => {
    return (await get(profiles)).filter((profile) => {
      return !isConnected(profile);
    });
  });
  const noneConnected = Cell.derivedAsync(async (get) => {
    return !get(providers.pending) && (await get(connected)).length === 0;
  });
  const providersError = Cell.derived(() => {
    return providers.error.get();
  });

  return (
    <section class={classes.page} aria-busy={providers.pending}>
      <div class={classes.content}>
        <header class={classes.pageHeader}>
          <h1 class={classes.pageTitle}>Providers</h1>
          <AddProvider />
        </header>
        {If(providersError, (error) => {
          return (
            <div class={classes.notice} role="alert">
              <p title={error.message}>Couldn't load providers: {error.message}</p>
              <Button variant="outline" onClick={refreshProviders}>
                Retry
              </Button>
            </div>
          );
        })}
        {If(noneConnected, () => {
          return (
            <div class={classes.empty}>
              <span class={classes.emptyIcon}>
                <Icon name="extension" aria-hidden="true" />
              </span>
              <h2>Connect your first provider</h2>
              <p>
                Connect an account, add an API key, or configure a local model server. Its models
                will then be available in Chat.
              </p>
            </div>
          );
        })}
        <ProviderGroup
          id="providers-connected"
          heading="Connected"
          hint="Chat can use these now."
          profiles={connected}
        />
        <ProviderGroup
          id="providers-available"
          heading="Available"
          hint="Connect an account or add a key."
          profiles={available}
        />
        <p class={classes.footnote}>
          <Icon name="padlock" aria-hidden="true" />
          Credentials stay on this device.
        </p>
      </div>
    </section>
  );
}
