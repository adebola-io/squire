import { FileUpload as InnateFileUpload } from "innate-ui";

import classes from "./FileUpload.module.css";

type InnateFileUploadProps = Parameters<typeof InnateFileUpload>[0];

interface FileUploadProps extends InnateFileUploadProps {
  class?: InnateFileUploadProps["class"];
}

function FileUploadRoot(props: FileUploadProps) {
  const { class: className, ...rest } = props;
  return <InnateFileUpload {...rest} class={[classes.root, className]} />;
}

type FileUploadParts = {
  Dropzone: typeof InnateFileUpload.Dropzone;
  Trigger: typeof InnateFileUpload.Trigger;
};

export const FileUpload: typeof FileUploadRoot & FileUploadParts = Object.assign(FileUploadRoot, {
  Dropzone: InnateFileUpload.Dropzone,
  Trigger: InnateFileUpload.Trigger,
});
export type { FileUploadProps };
