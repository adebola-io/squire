import { Cell } from "retend";

type Track = <T>(cell: Cell<T>) => T;

/**
 * Load the requested page with tracked `get` reads. On failure, retain the current page and let
 * the caller show the error.
 */
type PageReady = (get: Track) => Promise<unknown>;

/**
 * Retain the current page until the selected key's data is ready. Reloading the same key
 * preserves its DOM and focus. `switching` compares requested and displayed keys; `loaded`
 * remains true after the first successful load.
 */
export function usePageSwitch(key: Cell<string>, ready: PageReady) {
  const shownKey = Cell.source<string | null>(null);
  const pageKey = Cell.derivedAsync(async (get, signal) => {
    const next = get(key);
    await ready(get);
    if (!signal.aborted) {
      shownKey.set(next);
    }
    return next;
  });
  const switching = Cell.derived(() => {
    const shown = shownKey.get();
    return shown !== null && shown !== key.get() && pageKey.error.get() === null;
  });
  const loaded = Cell.derived(() => shownKey.get() !== null);
  return { pageKey, switching, loaded };
}
