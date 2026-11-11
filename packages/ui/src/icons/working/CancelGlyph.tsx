import { FRAME, type GlyphProps } from "./frame";

import classes from "./WorkingGlyph.module.css";

const STROKE = {
  pathLength: 1,
  stroke: "currentColor",
  "stroke-width": "1.6",
  "stroke-linecap": "round",
};

/** Draw both cross strokes, then shake the cancellation icon. */
export function CancelGlyph(props: GlyphProps) {
  const { class: className } = props;
  return (
    <svg {...FRAME} class={className}>
      <g class={classes.cancelCross}>
        <path
          class={classes.cancelTrack}
          d="M9.89256 10.1074L21.6777 21.8926M21.6777 10.1074L9.89256 21.8926"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
        <path class={classes.cancelFirst} d="M9.89256 10.1074L21.6777 21.8926" {...STROKE} />
        <path class={classes.cancelSecond} d="M21.6777 10.1074L9.89256 21.8926" {...STROKE} />
      </g>
    </svg>
  );
}
