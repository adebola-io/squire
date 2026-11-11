import { Svg, type SVGProps } from "./Svg";

/**
 * Google's mark in its own four colours, as the brand guidelines require on a neutral control.
 * The colours are fixed, so this icon ignores the surrounding text colour.
 */
export const GoogleIcon = (props: SVGProps) => (
  <Svg aria-hidden="true" viewBox="0 0 24 24" {...props}>
    <path
      fill="#4285f4"
      d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
    />
    <path
      fill="#34a853"
      d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24z"
    />
    <path
      fill="#fbbc05"
      d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29A12 12 0 0 0 0 12c0 1.94.47 3.77 1.29 5.38l3.98-3.09z"
    />
    <path
      fill="#ea4335"
      d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"
    />
  </Svg>
);
