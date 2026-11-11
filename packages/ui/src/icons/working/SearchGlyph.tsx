import { FRAME, type GlyphProps } from "./frame";

import classes from "./WorkingGlyph.module.css";

/** Move the search lens between positions and animate its highlight. */
export function SearchGlyph(props: GlyphProps) {
  const { class: className } = props;
  return (
    <svg {...FRAME} class={className}>
      <g transform="translate(16 16) scale(0.88) translate(-16 -16)">
        <g class={classes.searchLens}>
          <circle cx="14.81" cy="14.97" r="8.78" stroke="currentColor" stroke-width="1.8" />
          <path
            class={classes.searchGlint}
            d="M14.93 10.24A4.6 4.6 0 0 1 18.44 12.3"
            stroke="currentColor"
            stroke-width="2.1"
            stroke-linecap="round"
          />
          <path
            d="M21.14 21.14L25.96 25.96"
            stroke="currentColor"
            stroke-width="2.13"
            stroke-linecap="round"
          />
        </g>
      </g>
    </svg>
  );
}
