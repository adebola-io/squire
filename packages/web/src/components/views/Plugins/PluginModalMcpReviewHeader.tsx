import { If } from "retend";
import type { Cell } from "retend";
import { Icon } from "squire-ui";

import type { DesktopMcpCandidate } from "@/platform/desktopClient";

import classes from "./Plugins.module.css";

interface PluginModalMcpReviewHeaderProps {
  candidate: DesktopMcpCandidate;
  iconSrc: Cell<string>;
  showIcon: Cell<boolean>;
  appearanceOpen: Cell<boolean>;
  onToggleAppearance: () => void;
  onIconError: () => void;
}

export function PluginModalMcpReviewHeader(props: PluginModalMcpReviewHeaderProps) {
  const { candidate, iconSrc, showIcon, appearanceOpen, onToggleAppearance, onIconError } = props;

  return (
    <header class={classes.mcpReviewHeader}>
      <button
        class={classes.mcpReviewIcon}
        type="button"
        title="Change icon and color"
        aria-label="Change icon and color"
        aria-expanded={appearanceOpen}
        aria-controls="mcp-review-appearance"
        onClick={onToggleAppearance}
      >
        {If(showIcon, {
          true: () => <img src={iconSrc} alt="" onError={onIconError} />,
          false: () => <Icon name="plugin" aria-hidden="true" />,
        })}
        <span class={classes.mcpReviewIconBadge} aria-hidden="true">
          <Icon name="edit" aria-hidden="true" />
        </span>
      </button>
      <div class={classes.mcpReviewTitle}>
        <label class={classes.mcpReviewEditable} data-kind="name" title="Edit name">
          <input
            name="mcp-plugin-name"
            type="text"
            value={candidate.suggestedName}
            placeholder="Plugin name"
            aria-label="Name"
            required
          />
          <Icon name="edit" aria-hidden="true" />
        </label>
        <p class={classes.mcpReviewSubtitle}>
          <span title={`MCP Plugin connected to ${candidate.connection}`}>MCP Plugin</span>
          <label class={classes.mcpReviewEditable} data-kind="version" title="Edit version">
            <span aria-hidden="true">v</span>
            <input
              name="mcp-plugin-version"
              type="text"
              size={6}
              value={candidate.suggestedVersion ?? ""}
              placeholder="version"
              aria-label="Version (optional)"
            />
          </label>
        </p>
      </div>
    </header>
  );
}
