import { useImageZoom, ZoomImage, zoomImageId } from "@/components/ui/ImageZoom/ImageZoom";
import { blobAttachmentUrl } from "@/platform/desktopClient";

import type { ResultAttachment } from "./chatModel";

import classes from "./WorkLog.module.css";

interface ToolAttachmentsProps {
  attachments: ResultAttachment[];
}

/** Render image results inline, zooming on a plain click, and other attachments as links. */
export function ToolAttachments(props: ToolAttachmentsProps) {
  const { attachments } = props;
  const openZoom = useImageZoom();
  const items = attachments.map((attachment) => {
    const url = blobAttachmentUrl(attachment.hash);
    const name = `Attachment ${attachment.index + 1}`;
    if (attachment.mimeType.startsWith("image/")) {
      const id = zoomImageId();
      const onClick = (event: MouseEvent) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        openZoom({ id, src: url, alt: name });
      };
      return (
        <a
          class={classes.attachment}
          href={url}
          target="_blank"
          rel="noreferrer"
          title={name}
          onClick={onClick}
        >
          <ZoomImage id={id} src={url} alt={name} />
        </a>
      );
    }
    return (
      <a class={classes.attachmentFile} href={url} target="_blank" rel="noreferrer">
        {name} · {attachment.mimeType}
      </a>
    );
  });

  return (
    <section class={classes.io}>
      <h3 class={classes.ioHeading}>Attachments</h3>
      <div class={classes.attachments}>{items}</div>
    </section>
  );
}
