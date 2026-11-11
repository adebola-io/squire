import { Svg, type SVGProps } from "./Svg";

/** Partial ring used while work is in progress. */
export const SpinnerIcon = (props: SVGProps) => (
  <Svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    {...props}
  >
    <path d="M20 12a8 8 0 1 1-5.5-7.6" />
  </Svg>
);
