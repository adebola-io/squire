import { Cell } from "retend";
import { Icon } from "squire-ui";

import type { DesktopPluginPreview } from "@/platform/desktopClient";

import classes from "./Plugins.module.css";

interface PluginSecretFieldProps {
  pluginId: string;
  secret: DesktopPluginPreview["secrets"][number];
}

export function PluginSecretField(props: PluginSecretFieldProps) {
  const { pluginId, secret } = props;
  const inputName = `${pluginId}.${secret.name}`;
  const visible = Cell.source(false);
  const inputType = Cell.derived(() => (visible.get() ? "text" : "password"));
  const toggleTitle = Cell.derived(() => (visible.get() ? "Hide secret" : "Show secret"));
  const toggleIcon = Cell.derived(() => (visible.get() ? "eyeClosed" : "eye"));

  const toggleVisible = () => {
    visible.set(!visible.get());
  };

  return (
    <label class={classes.pluginSecretField}>
      <span>
        <span class={classes.pluginSecretFieldName} title={secret.name}>
          {secret.name}
        </span>
        <span class={classes.pluginSecretDescription} title={secret.description}>
          {secret.description}
        </span>
      </span>
      <span class={classes.pluginSecretInputFrame}>
        <input class={classes.pluginSecretInput} name={inputName} type={inputType} />
        <button
          class={classes.pluginSecretToggle}
          type="button"
          title={toggleTitle}
          onClick={toggleVisible}
        >
          <Icon name={toggleIcon} />
        </button>
      </span>
    </label>
  );
}
