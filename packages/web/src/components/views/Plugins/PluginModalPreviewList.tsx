import { AsyncCell, Cell, For } from "retend";
import { FadeScroll } from "squire-ui";

import type { DesktopPluginPreviewResult } from "@/platform/desktopClient";

import { PluginPreview } from "./PluginPreview";

import classes from "./Plugins.module.css";

interface PluginPreviewListProps {
  files: Cell<File[]>;
  previews: AsyncCell<DesktopPluginPreviewResult[]>;
  onRemove: (file: File) => void;
}

/** Let the preview list expand within the modal body's shared scroll area. */
export function PluginPreviewList(props: PluginPreviewListProps) {
  const { files, previews, onRemove } = props;

  return (
    <FadeScroll>
      <ul class={classes.pluginPreviewList}>
        {For(files, (file, index) => (
          <PluginPreview
            file={file}
            preview={Cell.derivedAsync(async (get) => {
              const preview = (await get(previews))[get(index)];
              if (preview.error) throw new Error(preview.error);
              return preview;
            })}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </FadeScroll>
  );
}
