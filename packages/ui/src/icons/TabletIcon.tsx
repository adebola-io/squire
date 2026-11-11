import { Svg, type SVGProps } from "./Svg";

/** A tablet, for Squire running in Termux on an Android tablet. */
export const TabletIcon = (props: SVGProps) => (
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
    <rect x="3.5" y="3" width="17" height="18" rx="2" />
    <path d="M11.5 18h1" />
  </Svg>
);
