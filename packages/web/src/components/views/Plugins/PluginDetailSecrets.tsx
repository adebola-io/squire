import { Cell, For, If } from "retend";
import type { AsyncCell } from "retend";
import { FadeScroll, Icon } from "squire-ui";

import { setPluginSecret } from "@/platform/desktopClient";
import type {
  DesktopPlugin,
  DesktopPluginSecretState,
  DesktopPluginSecretsResponse,
} from "@/platform/desktopClient";
import { useSecretVisibility } from "@/utils/secretField";

import { PluginDetailPanelHeader } from "./PluginDetailPanelHeader";

import classes from "./Plugins.module.css";

interface PluginSecretListProps {
  plugin: AsyncCell<DesktopPlugin | null>;
  secretsResponse: AsyncCell<DesktopPluginSecretsResponse>;
  onSecretsRevalidate: () => void;
}

export function PluginSecretList(props: PluginSecretListProps) {
  const { plugin, secretsResponse, onSecretsRevalidate } = props;
  const search = Cell.source("");
  const pluginId = Cell.derivedAsync(async (get) => (await get(plugin))?.id ?? "");
  const secrets = Cell.derivedAsync(async (get) => {
    const query = get(search).trim().toLowerCase();
    const secretList = (await get(secretsResponse)).secrets;
    if (query === "") return secretList;
    return secretList.filter((secret) =>
      [secret.name, secret.description].join(" ").toLowerCase().includes(query),
    );
  });

  return (
    <div class={classes.detailPanel}>
      <PluginDetailPanelHeader search={search} placeholder="Search secrets" />
      <FadeScroll>
        <ul class={classes.detailList} aria-busy={secretsResponse.pending}>
          {For(
            secrets,
            (secret) => (
              <PluginSecretRow
                pluginId={pluginId}
                secret={secret}
                onSecretsRevalidate={onSecretsRevalidate}
              />
            ),
            { key: "name" },
          )}
        </ul>
      </FadeScroll>
    </div>
  );
}

interface PluginSecretRowProps {
  pluginId: AsyncCell<string>;
  secret: DesktopPluginSecretState;
  onSecretsRevalidate: () => void;
}

function PluginSecretRow(props: PluginSecretRowProps) {
  const { pluginId, secret, onSecretsRevalidate } = props;
  const draft = Cell.source("");
  const visibility = useSecretVisibility("typed secret");
  const saveSecret = Cell.task(async (value: string) => {
    await setPluginSecret(await pluginId.get(), secret.name, value);
    draft.set("");
    visibility.hide();
    // Refresh secrets independently because the plugin index does not contain them.
    onSecretsRevalidate();
  });
  const saveDisabled = Cell.derived(() => draft.get() === "" || saveSecret.pending.get());
  const saveLabel = Cell.derived(() => (saveSecret.pending.get() ? "Saving…" : "Save"));
  const error = Cell.derived(() => saveSecret.error.get()?.message ?? null);
  const inputName = Cell.derivedAsync(async (get) => `${await get(pluginId)}.${secret.name}`);
  const placeholder = secret.configured ? "************************" : "Not set";

  const onSubmit = (event: SubmitEvent | undefined) => {
    if (!event || saveDisabled.get()) return;
    saveSecret.runWith(draft.get());
  };

  return (
    <li class={classes.detailRow} data-kind="secret" aria-busy={saveSecret.pending}>
      <label class={classes.detailRowText}>
        <span class={classes.detailRowTitle}>
          <span title={secret.name}>{secret.name}</span>
        </span>
        <span class={classes.pluginSecretDescription} title={secret.description}>
          {secret.description}
        </span>
        {If(error, (message) => (
          <span class={classes.detailError} role="alert" title={message}>
            {message}
          </span>
        ))}
      </label>
      <form class={classes.detailSecretInputFrame} onSubmit--prevent={onSubmit}>
        <input
          class={classes.pluginSecretInput}
          name={inputName}
          type={visibility.inputType}
          placeholder={placeholder}
          value={draft}
          onInput={(event) => {
            if (event) {
              draft.set((event.currentTarget as HTMLInputElement).value);
            }
          }}
          disabled={saveSecret.pending}
        />
        <button
          class={classes.detailSecretToggle}
          type="button"
          title={visibility.label}
          onClick={visibility.toggle}
          disabled={saveSecret.pending}
        >
          <Icon name="eye" aria-hidden="true" />
        </button>
        <button class={classes.detailSecretSave} type="submit" disabled={saveDisabled}>
          {If(saveSecret.pending, {
            true: () => (
              <Icon class={classes.detailLoadingIcon} name="loading" aria-hidden="true" />
            ),
            false: () => saveLabel,
          })}
        </button>
      </form>
    </li>
  );
}
