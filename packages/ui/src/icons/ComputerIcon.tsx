import { Svg, type SVGProps } from "./Svg";

/** A computer screen on a stand: the machine a connection runs on. */
export const ComputerIcon = (props: SVGProps) => (
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
    <rect x="3" y="4.5" width="18" height="12" rx="1.5" />
    <path d="M9 20.5h6M12 16.5v4" />
  </Svg>
);
