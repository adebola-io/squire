import { Cell, type AsyncCell } from "retend";

/**
 * Mirror the latest resolved async value into a synchronous cell, retaining the previous
 * value while a new task runs so downstream UI can use ordinary Cell.derived cells.
 * Retend's AsyncCell/Cell.task already prevents superseded runs from publishing stale
 * results.
 */
export function useDerivedSync<T>(source: AsyncCell<T>): Cell<T | null> {
  const value = Cell.source<T | null>(null);
  source.listen(async (pending) => {
    value.set(await pending);
  });
  return value;
}
