import { FRAME, type GlyphProps } from "./frame";

import classes from "./WorkingGlyph.module.css";

const LINE = {
  stroke: "currentColor",
  "stroke-width": "1.31511",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
};

/** Lift the bin lid and animate a scrap falling inside. */
export function TrashGlyph(props: GlyphProps) {
  const { class: className } = props;
  return (
    <svg {...FRAME} class={className}>
      <path
        class={classes.trashBody}
        d="M9.64707 10.3932V23.0185C9.64707 23.7889 10.2716 24.4134 11.0421 24.4134H20.9638C21.7342 24.4134 22.3588 23.7889 22.3588 23.0185V10.3932"
        {...LINE}
      />
      <g class={classes.trashLid}>
        <path d="M6.77734 10.3932H25.2273" {...LINE} />
        <path
          d="M11.9433 9.84124V8.23206C11.9433 7.43951 12.5859 6.797 13.3784 6.797H18.6263C19.4188 6.797 20.0613 7.43951 20.0613 8.23206V9.84124"
          {...LINE}
        />
      </g>
      <path class={classes.trashScrap} d="M-1.6 -1.6H1.6V1.6H-1.6Z" {...LINE} />
    </svg>
  );
}
