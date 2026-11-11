import { Svg, type SVGProps } from "./Svg";

/** A conversation branch. */
export const BranchIcon = (props: SVGProps) => (
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
    <circle cx="6" cy="5" r="2" />
    <circle cx="18" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <path d="M6 7v10M18 7v2a4 4 0 0 1-4 4H6" />
  </Svg>
);
