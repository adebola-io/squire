import { FRAME, type GlyphProps } from "./frame";

import classes from "./WorkingGlyph.module.css";

const LINE = {
  stroke: "currentColor",
  "stroke-width": "1.6",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
};

/** Animate the plug entering its socket, followed by sparks. */
export function PluginGlyph(props: GlyphProps) {
  const { class: className } = props;
  return (
    <svg {...FRAME} class={className}>
      <path class={classes.pluginCord} d="M16.4999 21.2083V25.375" {...LINE} />
      <path
        class={classes.pluginHead}
        d="M21.7083 12.875V16C21.7083 18.8765 19.3764 21.2083 16.4999 21.2083C13.6234 21.2083 11.2916 18.8765 11.2916 16V12.875M12.3333 6.625V9.75M20.6666 6.625V9.75M9.20825 12.875H23.7916"
        {...LINE}
      />
      <path
        class={classes.pluginSpark}
        d="M16.5 1.6V3.4M13.9 2.4L14.9 3.5M19.1 2.4L18.1 3.5"
        {...LINE}
        stroke-width="1.4"
      />
    </svg>
  );
}
