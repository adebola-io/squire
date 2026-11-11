import { FRAME, type GlyphProps } from "./frame";

import classes from "./WorkingGlyph.module.css";

/** Animate the information symbol's stem and dot. */
export function InfoGlyph(props: GlyphProps) {
  const { class: className } = props;
  return (
    <svg {...FRAME} class={className}>
      <circle
        class={classes.infoRing}
        cx="16.0024"
        cy="16"
        r="9.375"
        stroke="currentColor"
        stroke-width="1.6"
      />
      <path
        class={classes.infoStem}
        d="M16.0024 14.9583V20.1667"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
      <circle class={classes.infoDot} cx="16.0024" cy="11.885" r="0.95" fill="currentColor" />
    </svg>
  );
}
