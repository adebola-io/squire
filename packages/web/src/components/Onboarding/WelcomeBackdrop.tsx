import { Cell, onConnected } from "retend";

import backdrop from "@/assets/backdrops-optimized/Pink Sunset.webp";

import classes from "./Onboarding.module.css";

/**
 * The welcome page's backdrop, revealed as the account site reveals it: only once the image has
 * loaded and decoded, so it never starts its fade and settle before there is a picture to show.
 */
export function WelcomeBackdrop() {
  const ready = Cell.source(false);
  const imageRef = Cell.source<HTMLImageElement | null>(null);

  const reveal = (image: HTMLImageElement) => {
    if (ready.get()) return;
    // Decode before transitioning so the first revealed frame is already sharp.
    void image
      .decode()
      .catch(() => {})
      .then(() => {
        // Commit the hidden starting frame first, including when the image was already cached.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (image.isConnected) ready.set(true);
          });
        });
      });
  };

  // A cached image can finish loading before the node connects, so check it there too.
  onConnected(imageRef, (image) => {
    if (image.complete && image.naturalWidth > 0) reveal(image);
  });

  return (
    <img
      ref={imageRef}
      src={backdrop}
      alt=""
      aria-hidden="true"
      class={classes.welcomeBackdrop}
      data-ready={ready}
      onLoad={(event) => {
        const image = event.currentTarget;
        if (image instanceof HTMLImageElement) reveal(image);
      }}
    />
  );
}
