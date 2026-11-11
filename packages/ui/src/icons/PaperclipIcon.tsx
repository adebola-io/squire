import { Svg, type SVGProps } from "./Svg";

/** Paperclip for attaching files. */
export const PaperclipIcon = (props: SVGProps) => (
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
    <path d="M5.61 9.33v5.33a6.39 6.39 0 0 0 12.78 0V6.14a4.26 4.26 0 0 0-8.52 0v8.52a2.13 2.13 0 0 0 4.26 0V6.14" />
  </Svg>
);
