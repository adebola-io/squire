import { Cell } from "retend";
import { Icon } from "squire-ui";

import type { DesktopMcpCandidate } from "@/platform/desktopClient";

import { PluginModalMcpReviewActions } from "./PluginModalMcpReviewActions";
import {
  DEFAULT_PLUGIN_THEME_COLOR,
  PluginModalMcpReviewAppearance,
} from "./PluginModalMcpReviewAppearance";
import { PluginModalMcpReviewHeader } from "./PluginModalMcpReviewHeader";

import classes from "./Plugins.module.css";

interface PluginModalMcpReviewStepProps {
  candidate: DesktopMcpCandidate;
}

export function PluginModalMcpReviewStep(props: PluginModalMcpReviewStepProps) {
  const { candidate } = props;
  const themeColor = Cell.source(DEFAULT_PLUGIN_THEME_COLOR);
  const iconSrc = Cell.source(candidate.suggestedIconSrc ?? "");
  const iconFailed = Cell.source(false);
  const appearanceOpen = Cell.source(false);

  const showIcon = Cell.derived(() => iconSrc.get() !== "" && !iconFailed.get());

  const toggleAppearance = () => {
    appearanceOpen.set(!appearanceOpen.get());
  };

  // Delegate appearance changes to update the preview icon.
  const onAppearanceInput = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    switch (target.name) {
      case "mcp-plugin-theme-swatch":
      case "mcp-plugin-theme-color":
        themeColor.set(target.value);
        return;
      default:
        return;
    }
  };

  return (
    <div
      class={classes.mcpReview}
      style={{ "--plugin-theme-color": themeColor }}
      onInput={onAppearanceInput}
    >
      <PluginModalMcpReviewHeader
        candidate={candidate}
        iconSrc={iconSrc}
        showIcon={showIcon}
        appearanceOpen={appearanceOpen}
        onToggleAppearance={toggleAppearance}
        onIconError={() => iconFailed.set(true)}
      />

      <PluginModalMcpReviewAppearance
        themeColor={themeColor}
        iconSrc={iconSrc}
        iconFailed={iconFailed}
        appearanceOpen={appearanceOpen}
        suggestedIconSrc={candidate.suggestedIconSrc}
      />

      <label class={classes.mcpReviewEditable} data-kind="description" title="Edit description">
        {/* Set initial text through children; binding `value` would overwrite edits. */}
        <textarea
          name="mcp-plugin-description"
          rows={2}
          placeholder="What this Plugin does"
          aria-label="Description"
          required
        >
          {candidate.suggestedDescription}
        </textarea>
        <Icon name="edit" aria-hidden="true" />
      </label>

      <PluginModalMcpReviewActions actions={candidate.actions} connection={candidate.connection} />
    </div>
  );
}
