import { Cell, For, If, Switch } from "retend";
import type { AsyncCell } from "retend";
import { useRouteQuery } from "retend/router";
import { Icon, Tabs } from "squire-ui";
import type { TabOption } from "squire-ui";

import { AppLink } from "@/components/ui/AppLink";
import type { DesktopProviderProfile } from "@/platform/desktopClient";
import { useChat } from "@/scopes/ChatScope";

import { ChatGPTConnection } from "./ChatGPTConnection";
import { ProfileForm } from "./ProfileForm";
import { ProviderKeyForm } from "./ProviderKeyForm";
import { ProviderMark } from "./ProviderMark";
import { ProviderModels } from "./ProviderModels";
import { ProviderTitle } from "./ProviderTitle";
import { RemoveProvider } from "./RemoveProvider";

import classes from "./Providers.module.css";

type ProviderTab = "models" | "connection";

const PROVIDER_TABS: TabOption<ProviderTab>[] = [
  { value: "models", label: "Models" },
  { value: "connection", label: "Connection" },
];

interface ProviderDetailProps {
  providerId: string;
}

/** Provider details with Models and Connection tabs. */
export function ProviderDetail(props: ProviderDetailProps) {
  const { providerId } = props;
  const { providers } = useChat();
  const profile = Cell.derivedAsync(async (get) => {
    const result = await get(providers);
    return (
      result.profiles.find((candidate) => {
        return candidate.id === providerId;
      }) ?? null
    );
  });
  // Key by provider ID to preserve the page, tab and draft during connection updates.
  const slots = Cell.derivedAsync(async (get) => {
    const current = await get(profile);
    return current === null ? [] : [{ key: providerId, initial: current }];
  });
  const missing = Cell.derivedAsync(async (get) => {
    return (await get(profile)) === null;
  });

  return (
    <section class={classes.page} aria-busy={providers.pending}>
      <div class={classes.content}>
        <AppLink href="/settings/providers" class={classes.backLink} title="All providers">
          <Icon name="caret" aria-hidden="true" />
          Providers
        </AppLink>
        {If(missing, () => {
          return (
            <div class={classes.empty}>
              <h2>This provider is gone</h2>
              <p>It may have been removed. Your other providers are still in the list.</p>
            </div>
          );
        })}
        {For(
          slots,
          ({ initial }) => {
            return <ProviderPage initial={initial} profile={profile} />;
          },
          { key: "key" },
        )}
      </div>
    </section>
  );
}

interface ProviderPageProps {
  /** Initial provider values for form initialization. */
  initial: DesktopProviderProfile;
  /** Current provider values for display fields. */
  profile: AsyncCell<DesktopProviderProfile | null>;
}

function isProviderTab(value: string | null): value is ProviderTab {
  return value === "models" || value === "connection";
}

function ProviderPage(props: ProviderPageProps) {
  const { initial, profile } = props;
  const query = useRouteQuery();
  const tabParam = query.get("tab");
  // Read the selected tab from `?tab=`. Default unconfigured built-in providers to Connection;
  // otherwise default to Models.
  const fallbackTab: ProviderTab = initial.builtin && !initial.configured ? "connection" : "models";
  const tab = Cell.derived((): ProviderTab => {
    const value = tabParam.get();
    return isProviderTab(value) ? value : fallbackTab;
  });
  const name = Cell.derivedAsync(async (get) => {
    return (await get(profile))?.displayName ?? initial.displayName;
  });
  const needsKey = Cell.derivedAsync(async (get) => {
    const current = (await get(profile)) ?? initial;
    return current.builtin && current.kind !== "chatgpt" && !current.configured;
  });
  let keyNotice = null;
  if (initial.docUrl !== "") {
    keyNotice = (
      <>
        {" "}
        Get one at{" "}
        <a href={initial.docUrl} target="_blank" rel="noopener noreferrer">
          {initial.docUrl}
        </a>
        .
      </>
    );
  }

  return (
    <>
      <header class={classes.detailHeader}>
        <ProviderMark icon={initial.icon} name={initial.displayName} large />
        <div class={classes.detailText}>
          <ProviderTitle initial={initial} profile={profile} />
        </div>
        {If(
          Cell.derivedAsync(async (get) => initial.kind === "chatgpt" || (await get(needsKey))),
          {
            true: () => null,
            false: () => <RemoveProvider profile={initial} name={name} />,
          },
        )}
      </header>
      {If(needsKey, () => {
        return (
          <p class={classes.keyNotice}>
            Add your {initial.displayName} API key to use its models.
            {keyNotice}
          </p>
        );
      })}
      <Tabs
        class={classes.tabs}
        value={tab}
        onChange={(value) => {
          void query.set("tab", value);
        }}
        tabs={PROVIDER_TABS}
        label="Provider"
      />
      {Switch(tab, {
        models: () => {
          return <ProviderModels profileId={initial.id} />;
        },
        connection: () => {
          if (initial.kind === "chatgpt") {
            return <ChatGPTConnection />;
          }
          if (initial.builtin) {
            return <ProviderKeyForm profile={initial} />;
          }
          return (
            <div class={classes.tabPanel}>
              <ProfileForm profile={initial} live={profile} />
            </div>
          );
        },
      })}
    </>
  );
}
