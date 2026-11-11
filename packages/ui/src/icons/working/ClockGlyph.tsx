import { FRAME, type GlyphProps } from "./frame";

import classes from "./WorkingGlyph.module.css";

const HAND = {
  stroke: "currentColor",
  "stroke-width": "1.4",
  "stroke-linecap": "round",
};

/** Animate clock hands at different speeds for job status checks. */
export function ClockGlyph(props: GlyphProps) {
  const { class: className } = props;
  return (
    <svg {...FRAME} class={className}>
      <circle cx="16.0023" cy="16" r="9.3333" stroke="currentColor" stroke-width="1.4" />
      <path class={classes.clockHour} d="M16.0023 16H19.1134" {...HAND} />
      <path class={classes.clockMinute} d="M16.0023 16V10.8148" {...HAND} />
    </svg>
  );
}
