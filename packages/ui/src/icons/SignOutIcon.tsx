import { Svg, type SVGProps } from "./Svg";

/** An arrow leaving a door: ending the session on this browser. */
export const SignOutIcon = (props: SVGProps) => (
  <Svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    {...props}
  >
    <path d="M10 4H5v16h5M14 8l4 4-4 4M8 12h10" />
  </Svg>
);
