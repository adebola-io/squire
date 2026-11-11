import type { SourceCell } from "retend";
import { FileUpload, Icon } from "squire-ui";

import classes from "./Plugins.module.css";

interface PluginModalDropZoneProps {
  files: SourceCell<File[]>;
}

export function PluginModalDropZone(props: PluginModalDropZoneProps) {
  const { files } = props;

  const changeFiles = (next: ReadonlyArray<File>) => {
    files.set(Array.from(next));
  };

  return (
    <FileUpload value={files} onChange={changeFiles} accept=".zip,application/zip" multiple>
      <FileUpload.Dropzone class={classes.pluginDropZone}>
        <Icon class={classes.pluginDropIcon} name="folder" aria-hidden="true" />
        <p>Drop plugin packages here.</p>
        <FileUpload.Trigger class={classes.pluginChooseButton}>
          <Icon name="upload" aria-hidden="true" />
          Choose .zip files
        </FileUpload.Trigger>
      </FileUpload.Dropzone>
    </FileUpload>
  );
}
