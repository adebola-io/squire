import type { JSX } from "retend/jsx-runtime";

type SVGProps = JSX.IntrinsicElements["svg"];

export function BrowserBackIcon(props: SVGProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      {...props}
    >
      <path d="m15 6-6 6 6 6" />
    </svg>
  );
}

export function BrowserForwardIcon(props: SVGProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      {...props}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
