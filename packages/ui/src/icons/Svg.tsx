import type {} from "retend-web/jsx-runtime";
import type { JSX } from "retend/jsx-runtime";

export type SVGProps = JSX.IntrinsicElements["svg"];

/**
 * Default 32-unit icon frame. Icons drawn on a different grid set their own `viewBox`; a 1.2
 * stroke on the 24-unit grid matches the default 1.6 stroke at the same rendered size.
 */
export function Svg({ children, ...props }: SVGProps) {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {children}
    </svg>
  );
}
