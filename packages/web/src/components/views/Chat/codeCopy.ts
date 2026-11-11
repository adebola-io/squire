import { CODE_BLOCK_ATTRIBUTE, CODE_COPY_ATTRIBUTE } from "./markdownRender";

/** Duration of the copied-state indicator. */
const COPIED_MS = 1500;

const CHECK_SVG =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4.5 12.5l5 5 10-11"/>' +
  "</svg>";

const timers = new WeakMap<HTMLButtonElement, number>();
interface IdleButton {
  html: string;
  label: string;
}

/** The idle icon and label, captured before the first flash so repeat clicks cannot overwrite them. */
const idle = new WeakMap<HTMLButtonElement, IdleButton>();

function flashCopied(button: HTMLButtonElement) {
  let saved = idle.get(button);
  if (saved === undefined) {
    saved = { html: button.innerHTML, label: button.getAttribute("aria-label") ?? "Copy code" };
    idle.set(button, saved);
  }
  const { html: original, label } = saved;
  button.innerHTML = CHECK_SVG;
  button.setAttribute("data-done", "");
  button.title = "Copied";
  button.setAttribute("aria-label", "Copied");
  window.clearTimeout(timers.get(button));
  timers.set(
    button,
    window.setTimeout(() => {
      button.innerHTML = original;
      button.removeAttribute("data-done");
      button.title = label;
      button.setAttribute("aria-label", label);
    }, COPIED_MS),
  );
}

/**
 * Delegate code-copy clicks at document level because buttons are generated inside Markdown
 * markup.
 */
function copyCodeBlock(event: MouseEvent) {
  if (!(event.target instanceof Element)) {
    return;
  }
  const button = event.target.closest(`button[${CODE_COPY_ATTRIBUTE}]`);
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  const code = button.closest(`[${CODE_BLOCK_ATTRIBUTE}]`)?.querySelector("code");
  if (!code) {
    return;
  }
  event.preventDefault();
  void navigator.clipboard.writeText(code.textContent ?? "").then(
    () => {
      flashCopied(button);
    },
    () => {
      // The clipboard can refuse (no focus, no permission); nothing was copied.
    },
  );
}

let listening = false;
export function listenForCodeCopy() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("click", copyCodeBlock);
}
