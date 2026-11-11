import { For, If } from "retend";
import { FadeScroll, Icon } from "squire-ui";

import { useImageZoom, ZoomImage, zoomImageId } from "@/components/ui/ImageZoom/ImageZoom";
import { blobAttachmentUrl } from "@/platform/desktopClient";
import type { ConversationMessage } from "@/platform/desktopEvents";

import classes from "./Chat.module.css";
interface MessageAttachmentsProps {
  message: ConversationMessage;
}

interface MessageTileFileProps {
  name: string;
}

/** File icon and name for a non-image attachment. */
export function MessageTileFile(props: MessageTileFileProps) {
  const { name } = props;
  return (
    <span class={classes.messageTileFile}>
      <Icon name="file" aria-hidden="true" />
      <span class={classes.messageTileName}>{name}</span>
    </span>
  );
}

/**
 * Render sent attachments as linked image or file tiles above the message's bubble. A plain
 * click on an image zooms it.
 */
export function MessageAttachments(props: MessageAttachmentsProps) {
  const { message } = props;
  const openZoom = useImageZoom();
  const items = message.attachments.map((attachment) => {
    return {
      ...attachment,
      id: zoomImageId(),
      url: blobAttachmentUrl(attachment.hash),
      image: attachment.mimeType.startsWith("image/"),
    };
  });
  if (items.length === 0) return null;
  return (
    <FadeScroll direction="horizontal" class={classes.sentAttachmentScroll}>
      <ul class={classes.messageAttachments} aria-label="Message attachments">
        {For(
          items,
          (attachment) => {
            const { id, url, name, image } = attachment;
            const onClick = (event: MouseEvent) => {
              if (!image || event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              openZoom({ id, src: url, alt: name });
            };
            return (
              <li>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={name}
                  class={classes.messageTile}
                  data-image={image}
                  onClick={onClick}
                >
                  {If(image, {
                    true: () => <ZoomImage id={id} src={url} alt={name} />,
                    false: () => <MessageTileFile name={name} />,
                  })}
                </a>
              </li>
            );
          },
          { key: "index" },
        )}
      </ul>
    </FadeScroll>
  );
}
