import { Cell, For, onConnected } from "retend";
import { Teleport } from "retend-web";
import { FadeScroll } from "squire-ui";

import {
  useImageZoom,
  ZoomImage,
  type ZoomableImage,
  zoomImageId,
} from "@/components/ui/ImageZoom/ImageZoom";
import { openLocalPath } from "@/platform/desktopClient";
import { errorMessage } from "@/utils/misc";

import { listenForCodeCopy } from "./codeCopy";
import { LOCAL_PATH_SELECTOR, peekMarkdown, renderMarkdown } from "./markdownRender";
import { onRichClick, onRichSubmit } from "./richEvents";

import "./richHTML.css";
import classes from "./Chat.module.css";

interface MarkdownProps {
  text: string;
  class?: string;
  interactive?: boolean;
}

interface ImageGallery {
  id: string;
  html: string;
}

let lastGalleryId = 0;

/**
 * Intercept local-file links because browsers cannot navigate to them directly. Delegate click
 * and auxiliary-click handling at document level to avoid empty tabs.
 */
function openLinkedFile(event: MouseEvent) {
  if (event.type === "auxclick" && event.button !== 1) return;
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLAnchorElement>(LOCAL_PATH_SELECTOR);
  const path = link?.dataset.localPath;
  if (!link || !path) return;
  event.preventDefault();
  delete link.dataset.openError;
  openLocalPath(path).then(
    (result) => {
      link.title =
        result.action === "revealed" ? `Shown in its folder, not run: ${result.path}` : result.path;
    },
    (error: unknown) => {
      link.dataset.openError = "";
      link.title = `Couldn't open ${path}: ${errorMessage(error)}`;
    },
  );
}

let listening = false;
function listenForFileLinks() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("click", openLinkedFile);
  document.addEventListener("auxclick", openLinkedFile);
}

/**
 * Swap a reply's plain images (not linked, styled or diagram images) for empty slots that a
 * `ZoomImage` can be teleported into, since Retend can only move an image it rendered.
 */
function slotImages(root: HTMLElement): ZoomableImage[] {
  const images = root.querySelectorAll("img:not([class], [data-scheme], a img)");
  return Array.from(images, (image) => {
    const slot = document.createElement("span");
    slot.id = zoomImageId();
    slot.dataset.zoom = "";
    const src = image.getAttribute("src") ?? "";
    image.replaceWith(slot);
    return {
      id: slot.id,
      src,
      alt: image.getAttribute("alt") ?? "",
    };
  });
}

/** Share delegated file-link and copy handlers across completed replies. */
export function listenForMarkdownInteractions() {
  listenForFileLinks();
  listenForCodeCopy();
}

/**
 * Render prepared markup synchronously; otherwise await highlighting. Escape user and work-log
 * HTML, sanitize assistant HTML, and highlight escaped code.
 */
export function Markdown(props: MarkdownProps) {
  const { text, class: className, interactive = false } = props;
  const mode = interactive ? "rich" : "plain";

  listenForMarkdownInteractions();
  const openZoom = useImageZoom();
  const root = Cell.source<HTMLElement | null>(null);
  const images = Cell.source<ZoomableImage[]>([]);
  const galleries = Cell.source<ImageGallery[]>([]);
  const onClick = (event: MouseEvent) => {
    if (!interactive) return;
    const slot = event.target instanceof Element ? event.target.closest("[data-zoom]") : null;
    const image = images.get().find((item) => item.id === slot?.id);
    if (image) openZoom(image);
    else onRichClick(event);
  };
  const onSubmit = (event: SubmitEvent) => {
    if (interactive) onRichSubmit(event);
  };
  const frame = {
    ref: root,
    class: [classes.answer, className],
    "data-mode": mode,
    onClick,
    onSubmit,
  };
  const html =
    peekMarkdown(text, interactive) ??
    Cell.derivedAsync(async () => renderMarkdown(text, interactive));

  // Slot the images once the reply's markup is in place; their teleports need the slots to exist.
  const adoptImages = () => {
    const element = root.get();
    if (!interactive || !element) return;

    const galleryImages: ZoomableImage[] = [];
    const galleryItems: ImageGallery[] = [];
    for (const gallery of element.querySelectorAll<HTMLElement>(
      ".ui-gallery:not([data-fade-scroll-rendered])",
    )) {
      // Replace sanitized gallery markup with a target for the shared FadeScroll component.
      // Make image slots first so they survive the move into the scrollable gallery.
      galleryImages.push(...slotImages(gallery));
      lastGalleryId += 1;
      const id = `zoom-gallery-${lastGalleryId}`;
      const placeholder = document.createElement("div");
      placeholder.id = id;
      galleryItems.push({ id, html: gallery.innerHTML });
      gallery.replaceWith(placeholder);
    }
    const ordinaryImages = slotImages(element);
    if (galleryItems.length === 0 && ordinaryImages.length === 0) return;
    galleries.set(galleryItems);
    images.set([...ordinaryImages, ...galleryImages]);
  };
  onConnected(root, adoptImages);
  if (typeof html !== "string") html.listen(() => queueMicrotask(adoptImages));

  return (
    <>
      <div {...frame} dangerouslySetInnerHTML={{ __html: html }} />
      {For(
        galleries,
        (gallery) => (
          <Teleport to={`#${gallery.id}`}>
            <FadeScroll
              direction="horizontal"
              class={classes.galleryScroll}
              role="region"
              aria-label="Image gallery"
              tabIndex={0}
            >
              <div
                class="ui-gallery"
                data-fade-scroll-rendered=""
                dangerouslySetInnerHTML={{ __html: gallery.html }}
              />
            </FadeScroll>
          </Teleport>
        ),
        { key: "id" },
      )}
      {For(
        images,
        (image) => (
          <Teleport to={`#${image.id}`}>
            <ZoomImage id={image.id} src={image.src} alt={image.alt} />
          </Teleport>
        ),
        { key: "id" },
      )}
    </>
  );
}
