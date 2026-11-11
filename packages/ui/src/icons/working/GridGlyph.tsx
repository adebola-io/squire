import { FRAME, type GlyphProps } from "./frame";

import classes from "./WorkingGlyph.module.css";

/** Draw the divider and branch of a directory tree. */
export function GridGlyph(props: GlyphProps) {
  const { class: className } = props;
  return (
    <svg {...FRAME} class={className}>
      <path
        d="M6.75317 20.7932V11.1407C6.75317 9.68679 7.93179 8.50818 9.38567 8.50818H21.6707C23.1246 8.50818 24.3032 9.68679 24.3032 11.1407V20.7932C24.3032 22.2471 23.1246 23.4257 21.6707 23.4257H9.38567C7.93179 23.4257 6.75317 22.2471 6.75317 20.7932Z"
        stroke="currentColor"
        stroke-width="1.49175"
        stroke-linecap="round"
      />
      <path
        class={classes.gridDivider}
        d="M12.521 8.81018V22.4792"
        pathLength={1}
        stroke="currentColor"
        stroke-width="1.96255"
        stroke-linecap="round"
      />
      <path
        class={classes.gridBranch}
        d="M12.521 16.1004H24.3675"
        pathLength={1}
        stroke="currentColor"
        stroke-width="1.82254"
      />
    </svg>
  );
}
