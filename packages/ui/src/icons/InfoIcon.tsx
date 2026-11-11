import { Svg, type SVGProps } from "./Svg";

export const InfoIcon = (props: SVGProps) => (
  <Svg aria-hidden="true" {...props}>
    <path
      d="M16.0024 14.9583V20.1667M16.0024 25.375C10.8248 25.375 6.62744 21.1777 6.62744 16C6.62744 10.8223 10.8248 6.625 16.0024 6.625C21.1801 6.625 25.3774 10.8223 25.3774 16C25.3774 21.1777 21.1801 25.375 16.0024 25.375ZM16.0543 11.8333V11.9375L15.9506 11.9377V11.8333H16.0543Z"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </Svg>
);
