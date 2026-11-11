import { Cell, If } from "retend";
import { useDerivedAsyncValue } from "retend-utils/hooks";
import type { JSX } from "retend/jsx-runtime";
import { Icon, isWorkingGlyph, WorkingGlyph, type IconName } from "squire-ui";

import { pluginIconUrl } from "@/platform/desktopClient";
import { useColorScheme } from "@/scopes/ColorSchemeScope";

import classes from "./Chat.module.css";

interface ChatToolIconProps {
  name: JSX.ValueOrCellOrPromise<IconName>;
  pluginId?: JSX.ValueOrCellOrPromise<string | null>;
  motion?: IconName;
}

/**
 * Shared icon frame for thinking, tool calls and plugin actions. Use `WorkingGlyph` for
 * animated activity icons.
 */
export function ChatToolIcon(props: ChatToolIconProps) {
  const { name, pluginId = null, motion = null } = props;
  const colorScheme = useColorScheme();
  const plugin = useDerivedAsyncValue(pluginId);
  const source = Cell.derivedAsync(async (get) => {
    const id = await get(plugin);
    return id === null ? null : pluginIconUrl(id, get(colorScheme));
  });

  return (
    <span class={classes.toolIcon} data-motion={motion} aria-hidden="true">
      {If(source, {
        true: (src) => {
          return <img class={classes.toolIconLogo} src={src} alt="" />;
        },
        false: () => {
          if (motion !== null && isWorkingGlyph(motion)) {
            return <WorkingGlyph name={motion} class={classes.toolIconGlyph} />;
          }
          return <Icon name={name} class={classes.toolIconGlyph} />;
        },
      })}
    </span>
  );
}
