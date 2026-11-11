import { Svg, type SVGProps } from "./Svg";

/** Stop the current operation. */
export const StopIcon = (props: SVGProps) => (
  <Svg aria-hidden="true" viewBox="0 0 24 24" fill="none" {...props}>
    <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
  </Svg>
);
