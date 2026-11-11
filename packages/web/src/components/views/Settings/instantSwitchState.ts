import { Cell } from "retend";

export function useInstantSwitch(on: Cell<boolean>, save: (next: boolean) => Promise<void>) {
  const optimistic = Cell.source<boolean | null>(null);
  const shown = Cell.derived(() => optimistic.get() ?? on.get());
  const task = Cell.task(async (next: boolean) => {
    optimistic.set(next);
    try {
      await save(next);
    } finally {
      optimistic.set(null);
    }
  });
  const flip = () => {
    if (task.pending.get()) return;
    return task.runWith(!shown.get());
  };

  return { shown, pending: task.pending, error: task.error, flip };
}
