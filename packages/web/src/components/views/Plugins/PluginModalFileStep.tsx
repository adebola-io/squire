import { Cell, If } from "retend";
import type { AsyncCell, SourceCell } from "retend";
import { ModalHeading } from "squire-ui";

import type { DesktopPluginPreviewResult } from "@/platform/desktopClient";

import { PluginModalDropZone } from "./PluginModalDropZone";
import { PluginPreviewList } from "./PluginModalPreviewList";

import classes from "./Plugins.module.css";

interface PluginModalFileStepProps {
  files: SourceCell<File[]>;
  previews: AsyncCell<DesktopPluginPreviewResult[]>;
}

export function PluginModalFileStep(props: PluginModalFileStepProps) {
  const { files, previews } = props;
  const hasRows = Cell.derived(() => files.get().length > 0);
  const needsFile = Cell.derived(() => !hasRows.get());

  const removeFile = (file: File) => {
    files.set(files.get().filter((f) => f !== file));
  };

  return (
    <>
      <ModalHeading title="Add Plugins" subtitle="Import plugin.zip packages to install them." />
      <PluginModalDropZone files={files} />
      {If(hasRows, {
        true: () => <PluginPreviewList files={files} previews={previews} onRemove={removeFile} />,
        false: () => null,
      })}
      {If(needsFile, () => (
        <input class={classes.pluginValidityInput} required aria-label="Choose a plugin package" />
      ))}
    </>
  );
}
