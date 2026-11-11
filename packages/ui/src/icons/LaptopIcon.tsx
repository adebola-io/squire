import { Svg, type SVGProps } from "./Svg";

/** An open laptop, paired with the shared 24-unit computer icon. */
export const LaptopIcon = (props: SVGProps) => (
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
    <rect x="4.5" y="4" width="15" height="12" rx="1.5" />
    <path d="M2.5 19.5h19l-2-3.5h-15z" />
  </Svg>
);
