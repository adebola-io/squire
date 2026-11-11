import { Svg, type SVGProps } from "./Svg";

export const BrowserIcon = (props: SVGProps) => (
  <Svg aria-hidden="true" {...props}>
    <path
      d="M6.75317 20.7932V11.1407C6.75317 9.68679 7.93179 8.50818 9.38567 8.50818H22.6143C24.0682 8.50818 25.2468 9.68679 25.2468 11.1407V20.7932C25.2468 22.2471 24.0682 23.4257 22.6143 23.4257H9.38567C7.93179 23.4257 6.75317 22.2471 6.75317 20.7932Z"
      stroke="currentColor"
      stroke-width="1.49175"
      stroke-linecap="round"
    />
    <path d="M6.75317 12.9H25.2468" stroke="currentColor" stroke-width="1.49175" />
    <circle cx="9.75" cy="10.7" r="0.8" fill="currentColor" />
    <circle cx="12.15" cy="10.7" r="0.8" fill="currentColor" />
    <circle cx="14.55" cy="10.7" r="0.8" fill="currentColor" />
  </Svg>
);
