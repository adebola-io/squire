import type { SourceCell } from "retend";

const MOBILE = "(max-width: 48rem)";
const EDGE_WIDTH = 36;
const DRAG_SLOP = 12;
const FLING_DISTANCE = 40;
const FLING_VELOCITY = 0.45;

interface Gesture {
  id: number;
  x: number;
  y: number;
  sampleX: number;
  sampleTime: number;
  lastX: number;
  lastTime: number;
  width: number;
  wasOpen: boolean;
  dragging: boolean;
  progress: number;
}

function findTouch(touches: TouchList, id: number): Touch | undefined {
  for (let index = 0; index < touches.length; index++) {
    if (touches[index].identifier === id) return touches[index];
  }
}

/** Mount mobile gestures and synchronize the native modal with the shared sidebar cell. */
export function mountSidebar(
  element: HTMLDialogElement,
  sidebarIsOpen: SourceCell<boolean>,
  subscribeRoute: (listener: () => void) => () => void,
) {
  const mobile = window.matchMedia(MOBILE);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const panel = element.querySelector("aside") as HTMLElement;
  let gesture: Gesture | null = null;

  const clearStyles = () => {
    panel.style.removeProperty("transform");
    element.style.removeProperty("--sidebar-progress");
    delete element.dataset.swiping;
  };
  const finishTransition = () => {
    if (!mobile.matches || !element.open) return;
    if (!sidebarIsOpen.get()) element.close();
    clearStyles();
  };
  const onTransitionEnd = (event: TransitionEvent) => {
    if (event.target === panel && event.propertyName === "transform") finishTransition();
  };
  const animateTo = (open: boolean) => {
    panel.style.transform = open ? "translate3d(0, 0, 0)" : "translate3d(-100%, 0, 0)";
    element.style.setProperty("--sidebar-progress", open ? "1" : "0");
  };

  const stopTracking = () => {
    gesture = null;
    window.removeEventListener("touchmove", onTouchMove);
    window.removeEventListener("touchend", onTouchEnd);
    window.removeEventListener("touchcancel", onTouchCancel);
  };
  const settle = (open: boolean) => {
    const progress = gesture?.progress ?? (sidebarIsOpen.get() ? 1 : 0);
    stopTracking();
    delete element.dataset.swiping;
    animateTo(open);
    if (sidebarIsOpen.get() !== open) sidebarIsOpen.set(open);
    if (reducedMotion.matches || Math.abs(progress - Number(open)) < 0.001) {
      finishTransition();
    }
  };
  const onTouchMove = (event: TouchEvent) => {
    const current = gesture;
    if (!current) return;
    const touch = findTouch(event.touches, current.id);
    if (!touch || event.touches.length !== 1) {
      if (current.dragging) settle(current.wasOpen);
      else stopTracking();
      return;
    }

    const dx = touch.clientX - current.x;
    const dy = touch.clientY - current.y;
    if (!current.dragging) {
      if (Math.abs(dy) > DRAG_SLOP && Math.abs(dy) > Math.abs(dx)) {
        stopTracking();
        return;
      }
      if (
        Math.abs(dx) < DRAG_SLOP ||
        Math.abs(dx) < Math.abs(dy) * 1.2 ||
        (current.wasOpen ? dx > 0 : dx < 0)
      )
        return;

      current.dragging = true;
      element.dataset.swiping = "";
      if (!current.wasOpen) {
        panel.style.transform = "translate3d(-100%, 0, 0)";
        element.style.setProperty("--sidebar-progress", "0");
        element.showModal();
      }
      current.width = panel.getBoundingClientRect().width;
    }

    if (event.cancelable) event.preventDefault();
    const progress = Math.max(0, Math.min(1, (current.wasOpen ? 1 : 0) + dx / current.width));
    current.progress = progress;
    // Skip reactivity and layout during the drag: only composite transform and opacity.
    panel.style.transform = "translate3d(" + (progress - 1) * current.width + "px, 0, 0)";
    element.style.setProperty("--sidebar-progress", String(progress));

    if (event.timeStamp - current.sampleTime >= 40) {
      current.sampleX = current.lastX;
      current.sampleTime = current.lastTime;
    }
    current.lastX = touch.clientX;
    current.lastTime = event.timeStamp;
  };
  const onTouchEnd = (event: TouchEvent) => {
    const current = gesture;
    if (!current) return;
    const touch = findTouch(event.changedTouches, current.id);
    if (!touch) return;
    if (!current.dragging) {
      stopTracking();
      return;
    }
    const dx = touch.clientX - current.x;
    current.progress = Math.max(0, Math.min(1, (current.wasOpen ? 1 : 0) + dx / current.width));
    const velocity =
      (touch.clientX - current.sampleX) / Math.max(1, event.timeStamp - current.sampleTime);
    const fling = Math.abs(dx) >= FLING_DISTANCE && Math.abs(velocity) >= FLING_VELOCITY;
    settle(fling ? velocity > 0 : current.progress >= 0.5);
  };
  const onTouchCancel = () => {
    if (gesture?.dragging) settle(gesture.wasOpen);
    else stopTracking();
  };
  const onTouchStart = (event: TouchEvent) => {
    if (!mobile.matches || gesture || event.touches.length !== 1) return;
    for (const modal of document.querySelectorAll("dialog:modal")) {
      if (modal !== element) return;
    }
    const touch = event.touches[0];
    const open = sidebarIsOpen.get();
    if (open ? !panel.contains(event.target as Node) : touch.clientX > EDGE_WIDTH || element.open) {
      return;
    }
    if ((event.target as Element).closest("input, textarea, select, [contenteditable]")) return;
    gesture = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      sampleX: touch.clientX,
      sampleTime: event.timeStamp,
      lastX: touch.clientX,
      lastTime: event.timeStamp,
      width: 0,
      wasOpen: open,
      dragging: false,
      progress: open ? 1 : 0,
    };
    // Only candidate gestures install a non-passive touchmove listener.
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchCancel, { passive: true });
  };

  const sync = () => {
    if (mobile.matches) {
      if (sidebarIsOpen.get()) {
        if (!element.matches(":modal")) {
          if (element.open) element.close();
          element.showModal();
        }
      } else if (element.open && !element.matches(":modal")) {
        element.close();
      } else if (element.open && !gesture?.dragging) {
        animateTo(false);
        if (reducedMotion.matches) finishTransition();
      }
    } else {
      stopTracking();
      clearStyles();
      if (!element.open || element.matches(":modal")) {
        if (element.open) element.close();
        element.show();
      }
    }
  };
  const onClose = () => {
    stopTracking();
    clearStyles();
  };
  panel.addEventListener("transitionend", onTransitionEnd);
  element.addEventListener("close", onClose);
  window.addEventListener("touchstart", onTouchStart, { passive: true });
  sync();
  mobile.addEventListener("change", sync);
  const stopWatchingOpen = sidebarIsOpen.listen(sync);
  const stopWatchingRoute = subscribeRoute(() => {
    if (mobile.matches && sidebarIsOpen.get()) sidebarIsOpen.set(false);
  });
  return () => {
    stopTracking();
    mobile.removeEventListener("change", sync);
    panel.removeEventListener("transitionend", onTransitionEnd);
    element.removeEventListener("close", onClose);
    window.removeEventListener("touchstart", onTouchStart);
    stopWatchingOpen();
    stopWatchingRoute();
  };
}
