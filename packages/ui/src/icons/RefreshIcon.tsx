import { Svg, type SVGProps } from "./Svg";

/** A single circular arrow, for reloading a list in place. */
export const RefreshIcon = (props: SVGProps) => (
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
    <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" />
    <path d="M20.5 3v5h-5" />
  </Svg>
);
