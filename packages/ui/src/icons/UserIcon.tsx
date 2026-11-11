import { Svg, type SVGProps } from "./Svg";

export const UserIcon = (props: SVGProps) => (
  <Svg aria-hidden="true" {...props}>
    <circle cx="16" cy="11.25" r="4.75" stroke="currentColor" stroke-width="1.6" />
    <path
      d="M7.5 25.75C7.5 21.47 11.31 18.25 16 18.25C20.69 18.25 24.5 21.47 24.5 25.75"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    />
  </Svg>
);
