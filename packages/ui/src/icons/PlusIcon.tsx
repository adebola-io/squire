import { Svg, type SVGProps } from "./Svg";

/** Add a new item or start a new conversation. */
export const PlusIcon = (props: SVGProps) => (
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
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
