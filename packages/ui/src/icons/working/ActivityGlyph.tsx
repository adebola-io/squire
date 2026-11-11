import { FRAME, type GlyphProps } from "./frame";

import classes from "./WorkingGlyph.module.css";

/** Animate a pulse over a static activity line for work between named steps. */
const PULSE = "M5.9 19L8.93 15L11.9 18.6L15 8.8L19 21.9L22.9 11.8L26.1 14.8";

export function ActivityGlyph(props: GlyphProps) {
  const { class: className } = props;
  return (
    <svg {...FRAME} class={className}>
      <path
        class={classes.activityTrack}
        d={PULSE}
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        class={classes.activityTrace}
        d={PULSE}
        pathLength={1}
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}
