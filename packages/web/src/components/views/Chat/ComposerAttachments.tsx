import { Cell, For, If, type SourceCell } from "retend";
import type { JSX } from "retend/jsx-runtime";
import { FadeScroll, Icon } from "squire-ui";

import type { AttachmentInput } from "@/platform/desktopClient";

import { ModelChooser } from "./ModelChooser";

import classes from "./Chat.module.css";
interface ComposerAttachmentsProps {
  attachments: SourceCell<AttachmentInput[]>;
  disabled: Cell<boolean>;
  reading: Cell<boolean>;
}

/** Base64 decoded byte count, excluding padding. */
const decodedBytes = (data: string) => {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** File extension, falling back to MIME subtype. */
const fileKind = (file: AttachmentInput) => {
  const dot = file.name.lastIndexOf(".");
  const extension = dot > 0 ? file.name.slice(dot + 1) : "";
  if (extension !== "" && extension.length <= 5) {
    return extension.toUpperCase();
  }
  const subtype = file.mimeType.split("/")[1] ?? "file";
  return subtype === "octet-stream" ? "File" : subtype.toUpperCase();
};

/**
 * Preview staged attachments above the composer. Use image or file tiles with remove controls
 * and placeholders while loading.
 */
export function ComposerAttachments(props: ComposerAttachmentsProps) {
  const { attachments, disabled, reading } = props;
  const uploadItems = Cell.derived(() => {
    return attachments.get().map((file, index) => {
      const image = file.mimeType.startsWith("image/");
      return {
        key: `${file.name}:${file.data.length}:${index}`,
        file,
        index,
        image,
        kind: image ? "image" : "file",
        meta: `${fileKind(file)} · ${formatBytes(decodedBytes(file.data))}`,
        preview: image ? `data:${file.mimeType};base64,${file.data}` : "",
      };
    });
  });
  return (
    <FadeScroll direction="horizontal" class={classes.attachmentShelf}>
      <ul class={classes.attachmentList} aria-label="Staged attachments">
        {For(
          uploadItems,
          (item) => {
            const label = `Remove ${item.file.name}`;
            return (
              <li class={classes.attachThumb} data-kind={item.kind} title={item.file.name}>
                {If(item.image, {
                  true: () => {
                    return (
                      <span class={classes.attachPreview}>
                        <img src={item.preview} alt={item.file.name} />
                      </span>
                    );
                  },
                  false: () => {
                    return (
                      <span class={[classes.attachPreview, classes.attachFile]}>
                        <span class={classes.attachFileIcon}>
                          <Icon name="file" aria-hidden="true" />
                        </span>
                        <span class={classes.attachFileText}>
                          <span class={classes.attachFileName}>{item.file.name}</span>
                          <span class={classes.attachFileMeta}>{item.meta}</span>
                        </span>
                      </span>
                    );
                  },
                })}
                <button
                  type="button"
                  class={classes.attachRemove}
                  disabled={disabled}
                  title={label}
                  aria-label={label}
                  onClick={() => {
                    attachments.set(
                      attachments.get().filter((_file, position) => {
                        return position !== item.index;
                      }),
                    );
                  }}
                >
                  <Icon name="cancel" aria-hidden="true" />
                </button>
              </li>
            );
          },
          { key: "key" },
        )}
        {If(reading, () => {
          return (
            <li
              class={classes.attachPending}
              role="status"
              aria-label="Reading attachments"
              title="Reading attachments"
            >
              <Icon name="spinner" class={classes.spinner} aria-hidden="true" />
            </li>
          );
        })}
      </ul>
    </FadeScroll>
  );
}
interface AttachmentChooserProps {
  disabled: Cell<boolean>;
  onFiles: (files: File[]) => void;
  children?: JSX.Template;
}
export function AttachmentChooser(props: AttachmentChooserProps) {
  const { disabled, onFiles, children } = props;
  const fileRef = Cell.source<HTMLInputElement | null>(null);
  const chooseFiles = () => fileRef.get()?.click();
  const loadFiles = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    if (input.files !== null) onFiles(Array.from(input.files));
    input.value = "";
  };
  return (
    <div class={classes.composerTools}>
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        aria-label="Attach files"
        onChange={loadFiles}
      />
      <button
        type="button"
        class={classes.attachButton}
        disabled={disabled}
        onClick={chooseFiles}
        title="Attach files"
        aria-label="Attach files"
      >
        <Icon name="paperclip" aria-hidden="true" />
        <span>Attach</span>
      </button>
      {children}
      <ModelChooser />
    </div>
  );
}
