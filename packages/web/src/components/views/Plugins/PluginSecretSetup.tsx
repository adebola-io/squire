import { Cell, For, If } from "retend";
import type { AsyncCell } from "retend";
import { FadeScroll, Icon } from "squire-ui";

import type { DesktopPluginPreview, DesktopPluginPreviewIcons } from "@/platform/desktopClient";
import { useColorScheme } from "@/scopes/ColorSchemeScope";
import { pluralize } from "@/utils/misc";

import { PluginSecretField } from "./PluginSecretField";

import classes from "./Plugins.module.css";

export interface PluginWithSecrets {
  iconDataUrls?: DesktopPluginPreviewIcons;
  plugin: DesktopPluginPreview;
}

interface PluginSecretSetupProps {
  plugins: AsyncCell<PluginWithSecrets[]>;
}

function PluginSecretGroup(props: PluginWithSecrets) {
  const { iconDataUrls, plugin } = props;
  const colorScheme = useColorScheme();
  const collapsed = Cell.source(false);
  const iconDataUrl = Cell.derived(() => iconDataUrls?.[colorScheme.get()] ?? null);
  const expanded = Cell.derived(() => !collapsed.get());
  const toggleTitle = Cell.derived(() => (collapsed.get() ? "Show secrets" : "Hide secrets"));

  const toggleCollapsed = () => {
    collapsed.set(!collapsed.get());
  };

  return (
    <li class={classes.pluginSecretGroup} data-collapsed={collapsed}>
      <button
        class={classes.pluginSecretHeader}
        type="button"
        title={toggleTitle}
        onClick={toggleCollapsed}
      >
        <div
          class={classes.pluginPreviewIcon}
          style={{ "--plugin-theme-color": plugin.themeColor }}
        >
          {If(iconDataUrl, (src) => (
            <img class={classes.pluginPreviewIconImage} src={src} alt="" />
          ))}
        </div>
        <span>
          <span class={classes.pluginSecretName} title={plugin.name}>
            {plugin.name}
          </span>
          <span class={classes.pluginSecretCount}>
            {pluralize(plugin.secrets.length, "secret", "secrets")}
          </span>
        </span>
        <Icon name="caret" />
      </button>
      {If(expanded, () => (
        <div class={classes.pluginSecretFields}>
          {For(plugin.secrets, (secret) => (
            <PluginSecretField pluginId={plugin.id} secret={secret} />
          ))}
        </div>
      ))}
    </li>
  );
}

export function PluginSecretSetup(props: PluginSecretSetupProps) {
  const { plugins } = props;

  return If(plugins, (plugins) => (
    <FadeScroll class={classes.pluginSecretListScroll}>
      <ul class={classes.pluginSecretList}>
        {For(plugins, ({ iconDataUrls, plugin }) => (
          <PluginSecretGroup iconDataUrls={iconDataUrls} plugin={plugin} />
        ))}
      </ul>
    </FadeScroll>
  ));
}
