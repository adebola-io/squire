import { AsyncCell, Cell, If, Switch } from "retend";
import { Icon } from "squire-ui";

import type { DesktopPluginPreview, DesktopPluginPreviewResult } from "@/platform/desktopClient";
import { useColorScheme } from "@/scopes/ColorSchemeScope";
import { pluralize } from "@/utils/misc";

import classes from "./Plugins.module.css";

/** Connection details to review before installation starts the server. */
function previewSummary(preview: DesktopPluginPreview): string {
  if (preview.runtime === "mcp") {
    const config = preview.mcp;
    if (config.transport === "stdio") {
      const args = config.args?.length ? ` ${config.args.join(" ")}` : "";
      const env = config.env ? Object.keys(config.env) : [];
      return `stdio: ${config.command}${args}${env.length ? ` (env: ${env.join(", ")})` : ""}`;
    }
    const headers = config.headers ? Object.keys(config.headers) : [];
    return `streamable_http: ${config.url}${headers.length ? ` (headers: ${headers.join(", ")})` : ""}`;
  }
  return pluralize(preview.actions.length, "action", "actions");
}

interface PluginPreviewProps {
  file: File;
  preview: AsyncCell<DesktopPluginPreviewResult>;
  onRemove: (file: File) => void;
}

export function PluginPreview(props: PluginPreviewProps) {
  const { file, preview, onRemove } = props;
  const colorScheme = useColorScheme();

  const pluginData = Cell.derivedAsync(async (get) => {
    const previewVal = await get(preview);
    if (!previewVal.plugin) throw new Error("No preview returned");
    return previewVal.plugin;
  });

  const state = Cell.derivedAsync((get) => {
    if (get(preview.pending)) return "pending";
    if (get(preview.error)) return "error";
    return "success";
  });

  const name = Cell.derivedAsync(async (get) => {
    if (get(preview.pending) || get(preview.error)) return file.name;
    return (await get(pluginData)).name;
  });

  const iconSrc = Cell.derivedAsync(async (get) => {
    if (get(preview.pending) || get(preview.error)) return null;
    return (await get(preview)).iconDataUrls?.[get(colorScheme)] ?? null;
  });

  const themeColor = Cell.derivedAsync(async (get) => {
    if (get(preview.pending)) return "var(--base)";
    if (get(preview.error)) return "var(--error)";
    return (await get(pluginData)).themeColor;
  });

  return (
    <li
      class={classes.pluginPreviewContainer}
      data-state={state}
      style={{ "--plugin-theme-color": themeColor }}
    >
      <div class={classes.pluginPreviewItem}>
        <div class={classes.pluginPreviewIcon}>
          {Switch(state, {
            pending: () => <Icon name="loading" />,
            error: () => <Icon name="info" />,
            success: () =>
              If(iconSrc, (src) => (
                <img class={classes.pluginPreviewIconImage} src={src} alt="Plugin icon" />
              )),
          })}
        </div>
        <div class={classes.pluginPreviewDetails}>
          {name}
          <p>
            {Switch(state, {
              pending: () => <span>Loading...</span>,
              error: () => (file.size / 1024).toFixed(2) + "KB",
              success: () =>
                If(pluginData, (data) => (
                  <span class={classes.pluginPreviewDetailsText}>
                    <span>{file.name}</span>
                    <span>{previewSummary(data)}</span>
                  </span>
                )),
            })}
          </p>
        </div>
        <button class={classes.pluginPreviewButton} type="button" onClick={() => onRemove(file)}>
          {If(pluginData, {
            true: () => <Icon name="trash" />,
            false: () => <Icon name="cancel" />,
          })}
        </button>
        {If(preview, { false: () => <input hidden type="text" required /> })}
      </div>
      {If(preview.error, (error) => {
        return (
          <span title={error.message} class={classes.error}>
            <span>{error.message}</span>
          </span>
        );
      })}
    </li>
  );
}
