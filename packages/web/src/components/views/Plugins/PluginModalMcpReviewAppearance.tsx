import { Cell, For, type SourceCell } from "retend";
import { Icon } from "squire-ui";

import { PluginModalMcpReviewIcon } from "./PluginModalMcpReviewIcon";

import classes from "./Plugins.module.css";

interface ThemeSwatch {
  label: string;
  value: string;
}

const THEME_SWATCHES: ThemeSwatch[] = [
  { label: "Slate", value: "#64748b" },
  { label: "Indigo", value: "#5e6ad2" },
  { label: "Blue", value: "#3b82f6" },
  { label: "Teal", value: "#14b8a6" },
  { label: "Green", value: "#22c55e" },
  { label: "Amber", value: "#f59e0b" },
  { label: "Rose", value: "#f43f5e" },
  { label: "Violet", value: "#8b5cf6" },
];

export const DEFAULT_PLUGIN_THEME_COLOR = THEME_SWATCHES[0].value;

interface PluginModalMcpReviewSwatchProps {
  swatch: ThemeSwatch;
  themeColor: Cell<string>;
}

function PluginModalMcpReviewSwatch(props: PluginModalMcpReviewSwatchProps) {
  const { swatch, themeColor } = props;
  const checked = Cell.derived(() => themeColor.get() === swatch.value);

  return (
    <label
      class={classes.mcpReviewSwatch}
      style={{ "--swatch-color": swatch.value }}
      title={swatch.label}
    >
      <input
        type="radio"
        name="mcp-plugin-theme-swatch"
        value={swatch.value}
        checked={checked}
        aria-label={swatch.label}
      />
      <Icon name="checkmark" aria-hidden="true" />
    </label>
  );
}

interface PluginModalMcpReviewAppearanceProps {
  themeColor: Cell<string>;
  /** Icon source saved with the plugin: a URL or data URI. */
  iconSrc: SourceCell<string>;
  iconFailed: SourceCell<boolean>;
  appearanceOpen: Cell<boolean>;
  suggestedIconSrc: string | null | undefined;
}

export function PluginModalMcpReviewAppearance(props: PluginModalMcpReviewAppearanceProps) {
  const { themeColor, iconSrc, iconFailed, appearanceOpen, suggestedIconSrc } = props;
  const appearanceHidden = Cell.derived(() => !appearanceOpen.get());
  const customColor = Cell.derived(() => {
    const current = themeColor.get();
    return !THEME_SWATCHES.some((swatch) => swatch.value === current);
  });

  return (
    <div id="mcp-review-appearance" class={classes.mcpReviewAppearance} hidden={appearanceHidden}>
      <fieldset class={classes.mcpReviewSwatches}>
        <legend>Color</legend>
        <div class={classes.mcpReviewSwatchList}>
          {For(THEME_SWATCHES, (swatch) => (
            <PluginModalMcpReviewSwatch swatch={swatch} themeColor={themeColor} />
          ))}
          <label
            class={classes.mcpReviewSwatch}
            data-custom
            data-active={customColor}
            title="Custom color"
          >
            <input
              type="color"
              name="mcp-plugin-theme-color"
              value={themeColor}
              aria-label="Custom color"
            />
            <Icon name="edit" aria-hidden="true" />
          </label>
        </div>
      </fieldset>
      <PluginModalMcpReviewIcon
        iconSrc={iconSrc}
        iconFailed={iconFailed}
        suggestedIconSrc={suggestedIconSrc}
      />
    </div>
  );
}
