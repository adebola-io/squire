import { For } from "retend";

import type { FilePreviewModel, PreviewLine } from "./previewRows";

import classes from "./FileToolDetails.module.css";

/** Unified-diff markers for each row type. */
const MARKERS: Record<PreviewLine["kind"], string> = {
  add: "+",
  remove: "-",
  context: "",
  gap: "",
};

interface FilePreviewProps {
  preview: FilePreviewModel;
}

/** Render preview rows prepared with the tool call. */
export function FilePreview(props: FilePreviewProps) {
  const { preview } = props;
  return (
    <pre class={classes.code} data-mode={preview.mode}>
      <code>
        {For(preview.lines, (line) => (
          <span class={classes.codeLine} data-kind={line.kind}>
            <span class={classes.codeNumber}>{line.label}</span>
            <span class={classes.codeMarker} aria-hidden="true">
              {MARKERS[line.kind]}
            </span>
            <span class={classes.codeText} dangerouslySetInnerHTML={{ __html: line.html }} />
          </span>
        ))}
      </code>
    </pre>
  );
}
