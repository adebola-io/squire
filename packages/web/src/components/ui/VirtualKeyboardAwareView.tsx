import { Cell, onConnected } from "retend";
import type { JSX } from "retend/jsx-runtime";

const MOBILE = "(max-width: 48rem)";
const MIN_KEYBOARD_HEIGHT = 100;

interface VirtualKeyboard extends EventTarget {
  overlaysContent: boolean;
  boundingRect: DOMRectReadOnly;
}

interface NavigatorWithKeyboard extends Navigator {
  virtualKeyboard?: VirtualKeyboard;
}

export interface KeyboardVisibility {
  isVisible: boolean;
  approximateHeight: number;
}

type VirtualKeyboardAwareViewProps = JSX.IntrinsicElements["div"] & {
  children: () => JSX.Template;
  onKeyboardVisibilityChange: (state: KeyboardVisibility) => void;
};

/**
 * Track the on-screen keyboard without resizing the application. The caller can translate
 * only its input area by approximateHeight, leaving the rest of the page stationary.
 */
export function VirtualKeyboardAwareView(props: VirtualKeyboardAwareViewProps) {
  const { children: Content, onKeyboardVisibilityChange, ...rest } = props;
  const ref = Cell.source<HTMLDivElement | null>(null);

  onConnected(ref, (element) => mountKeyboardAwareness(element, onKeyboardVisibilityChange));

  return (
    <div {...rest} ref={ref}>
      <Content />
    </div>
  );
}

/** Identifies inputs that are allowed to trigger keyboard avoidance. */
export function VirtualKeyboardTriggers(props: JSX.IntrinsicElements["div"]) {
  return <div {...props} data-keyboard-trigger />;
}

function mountKeyboardAwareness(
  container: HTMLElement,
  onChange: (state: KeyboardVisibility) => void,
) {
  const mobile = window.matchMedia(MOBILE);
  const visualViewport = window.visualViewport;
  const keyboard = (navigator as NavigatorWithKeyboard).virtualKeyboard;
  const previousOverlay = keyboard?.overlaysContent;
  let lastHeight = 0;
  let redirectingFocus = false;

  const isTrigger = (element: Element | null): boolean =>
    !!element && container.contains(element) && !!element.closest("[data-keyboard-trigger]");

  const update = () => {
    let height = 0;
    if (mobile.matches && isTrigger(document.activeElement)) {
      if (keyboard?.overlaysContent) {
        height = keyboard.boundingRect.height;
      } else if (visualViewport) {
        // Account for iOS panning the visual viewport as well as shrinking it.
        height = window.innerHeight - visualViewport.height - visualViewport.offsetTop;
      }
    }
    height = height >= MIN_KEYBOARD_HEIGHT ? Math.max(0, height) : 0;
    if (height === lastHeight) return;
    lastHeight = height;
    onChange({ isVisible: height > 0, approximateHeight: height });
  };

  // iOS Safari otherwise scrolls the layout viewport to reveal the focused textarea.
  const refocusWithoutScroll = (target: HTMLElement) => {
    redirectingFocus = true;
    target.blur();
    target.focus({ preventScroll: true });
    redirectingFocus = false;
  };
  const onFocusIn = (event: FocusEvent) => {
    if (!mobile.matches || redirectingFocus || !isTrigger(event.target as Element)) return;
    if (!keyboard?.overlaysContent && event.target instanceof HTMLElement) {
      refocusWithoutScroll(event.target);
    }
    update();
  };
  const onFocusOut = (event: FocusEvent) => {
    if (redirectingFocus) return;
    if (
      mobile.matches &&
      !keyboard?.overlaysContent &&
      event.relatedTarget instanceof HTMLElement &&
      isTrigger(event.relatedTarget)
    ) {
      refocusWithoutScroll(event.relatedTarget);
    }
    queueMicrotask(update);
  };
  const resetPageScroll = () => {
    if (mobile.matches && isTrigger(document.activeElement) && (scrollX || scrollY)) {
      window.scrollTo(0, 0);
    }
  };
  const updateOverlay = () => {
    if (keyboard) keyboard.overlaysContent = mobile.matches || previousOverlay === true;
    update();
  };

  container.addEventListener("focusin", onFocusIn);
  container.addEventListener("focusout", onFocusOut);
  visualViewport?.addEventListener("resize", update);
  visualViewport?.addEventListener("scroll", update);
  keyboard?.addEventListener("geometrychange", update);
  window.addEventListener("resize", update);
  window.addEventListener("scroll", resetPageScroll, { passive: true });
  mobile.addEventListener("change", updateOverlay);
  updateOverlay();

  return () => {
    container.removeEventListener("focusin", onFocusIn);
    container.removeEventListener("focusout", onFocusOut);
    visualViewport?.removeEventListener("resize", update);
    visualViewport?.removeEventListener("scroll", update);
    keyboard?.removeEventListener("geometrychange", update);
    window.removeEventListener("resize", update);
    window.removeEventListener("scroll", resetPageScroll);
    mobile.removeEventListener("change", updateOverlay);
    if (keyboard && previousOverlay !== undefined) keyboard.overlaysContent = previousOverlay;
  };
}
