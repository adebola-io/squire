import { FRAME, type GlyphProps } from "./frame";

import classes from "./WorkingGlyph.module.css";

/** Animate a plus sign entering the folder. */
export function FolderGlyph(props: GlyphProps) {
  const { class: className } = props;
  return (
    <svg {...FRAME} class={className}>
      <path
        class={classes.folderBody}
        d="M6.00244 11.7778C6.00244 10.5333 6.00244 9.911 6.24465 9.43565C6.4577 9.0175 6.79765 8.67755 7.2158 8.4645C7.69115 8.22229 8.31344 8.22229 9.558 8.22229H13.4186C13.9621 8.22229 14.2339 8.22229 14.4897 8.28369C14.7163 8.33812 14.9331 8.42791 15.132 8.54976C15.3562 8.68718 15.5484 8.87935 15.9328 9.26369L16.0721 9.40311C16.4564 9.78746 16.6487 9.97962 16.8729 10.117C17.0718 10.2389 17.2886 10.3287 17.5152 10.3831C17.771 10.4445 18.0428 10.4445 18.5863 10.4445H22.4469C23.6914 10.4445 24.3138 10.4445 24.7891 10.6867C25.2072 10.8998 25.5472 11.2397 25.7602 11.6579C26.0024 12.1332 26.0024 12.7555 26.0024 14.0001V20.2223C26.0024 21.4668 26.0024 22.0892 25.7602 22.5645C25.5472 22.9826 25.2072 23.3226 24.7891 23.5356C24.3138 23.7778 23.6914 23.7778 22.4469 23.7778H9.558C8.31343 23.7778 7.69115 23.7778 7.2158 23.5356C6.79765 23.3226 6.4577 22.9826 6.24465 22.5645C6.00244 22.0892 6.00244 21.4668 6.00244 20.2223V11.7778Z"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        class={classes.folderPlus}
        d="M16 14.6V19.4M13.6 17H18.4"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </svg>
  );
}
