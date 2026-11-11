import { Svg, type SVGProps } from "./Svg";

/** Arrow pointing right, used for sending and advancing. */
export const ArrowIcon = (props: SVGProps) => (
  <Svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.2"
    stroke-linecap="round"
    stroke-linejoin="round"
    {...props}
  >
    <path d="M4 12h16M14 6l6 6-6 6" />
  </Svg>
);
