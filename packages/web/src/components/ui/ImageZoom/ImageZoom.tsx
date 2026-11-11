import { Cell, createScope, createUnique, If, onConnected, onMove, useScopeContext } from "retend";
import type { JSX } from "retend/jsx-runtime";
import { Icon } from "squire-ui";

import classes from "./ImageZoom.module.css";

export interface ZoomableImage {
  /** The `id` of the image's `ZoomImage` instance. */
  id: string;
  src: string;
  alt: string;
}

type OpenImageZoom = (image: ZoomableImage) => void;

const ImageZoomScope = createScope<OpenImageZoom>();

export function useImageZoom() {
  return useScopeContext(ImageZoomScope);
}

let lastId = 0;

export function zoomImageId() {
  lastId += 1;
  return `zoom-image-${lastId}`;
}

interface ZoomImageProps {
  src: string;
  alt: string;
}

interface ZoomFlight {
  animation: Animation;
  finish: () => void;
}

/**
 * Move and resize the viewport, not the pixels. A FLIP transform scales width and height
 * independently when moving between a square thumbnail and a portrait/landscape viewer,
 * visibly stretching the image. Animating the viewport's geometry instead lets object-fit
 * progressively crop/reveal the original image without changing its proportions.
 */
export const ZoomImage = createUnique<ZoomImageProps>((props) => {
  const src = Cell.derived(() => props.get().src);
  const alt = Cell.derived(() => props.get().alt);
  const frame = Cell.source<HTMLElement | null>(null);
  let flight: ZoomFlight | null = null;
  let moveVersion = 0;

  onMove(() => {
    const element = frame.get();
    if (!element) return;
    const from = element.getBoundingClientRect();
    const version = ++moveVersion;
    flight?.animation.cancel();
    flight?.finish();
    return () => {
      requestAnimationFrame(() => {
        if (!element.isConnected || version !== moveVersion) return;
        const to = element.getBoundingClientRect();
        if (!from.width || !from.height || !to.width || !to.height) return;

        const duration = parseFloat(
          getComputedStyle(element).getPropertyValue("--image-zoom-duration"),
        );
        element.dataset.zoomFlying = "";
        element.setAttribute("popover", "manual");
        element.style.left = `${from.left}px`;
        element.style.top = `${from.top}px`;
        element.style.width = `${from.width}px`;
        element.style.height = `${from.height}px`;
        element.showPopover();

        const animation = element.animate(
          [
            {
              left: `${from.left}px`,
              top: `${from.top}px`,
              width: `${from.width}px`,
              height: `${from.height}px`,
            },
            {
              left: `${to.left}px`,
              top: `${to.top}px`,
              width: `${to.width}px`,
              height: `${to.height}px`,
            },
          ],
          { duration, easing: "cubic-bezier(0.2, 0, 0, 1)" },
        );

        const cleanup = () => {
          if (flight?.animation !== animation) return;
          flight = null;
          if (element.matches(":popover-open")) element.hidePopover();
          element.removeAttribute("popover");
          delete element.dataset.zoomFlying;
          element.style.removeProperty("left");
          element.style.removeProperty("top");
          element.style.removeProperty("width");
          element.style.removeProperty("height");
        };
        flight = { animation, finish: cleanup };
        void animation.finished.then(cleanup, cleanup);
      });
    };
  });

  return (
    <span ref={frame} class={classes.frame}>
      <img
        class={classes.image}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={(event) => {
          const image = event.currentTarget;
          if (image instanceof HTMLImageElement && image.naturalHeight > 0) {
            image.parentElement?.style.setProperty(
              "--image-zoom-ratio",
              String(image.naturalWidth / image.naturalHeight),
            );
          }
        }}
      />
    </span>
  );
});

interface ImageZoomViewerProps {
  image: ZoomableImage;
  onClose: () => void;
}

function ImageZoomViewer(props: ImageZoomViewerProps) {
  const { image, onClose } = props;
  const dialog = Cell.source<HTMLDialogElement | null>(null);
  // Escape would hide the dialog before the image could fly home, so unmount it instead.
  const onCancel = (event: Event) => {
    event.preventDefault();
    onClose();
  };
  onConnected(dialog, (element) => element.showModal());

  return (
    <dialog
      ref={dialog}
      class={classes.dialog}
      aria-label="Image viewer"
      onClick={onClose}
      onCancel={onCancel}
    >
      <ZoomImage id={image.id} src={image.src} alt={image.alt} />
      <button type="button" class={classes.close} aria-label="Close image">
        <Icon name="cancel" aria-hidden="true" />
      </button>
    </dialog>
  );
}

interface ImageZoomProviderProps {
  children: JSX.Children;
}

/** Lets any `ZoomImage` under it open in the zoom viewer. */
export function ImageZoomProvider(props: ImageZoomProviderProps) {
  const { children } = props;
  const zoomed = Cell.source<ZoomableImage | null>(null);
  const open: OpenImageZoom = (image) => zoomed.set(image);
  const close = () => zoomed.set(null);

  return (
    <ImageZoomScope.Provider value={open}>
      {children}
      {If(zoomed, (image) => (
        <ImageZoomViewer image={image} onClose={close} />
      ))}
    </ImageZoomScope.Provider>
  );
}
