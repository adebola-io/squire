import { type AsyncCell, Cell, For, onConnected, type SourceCell } from "retend";
import type { JSX } from "retend/jsx-runtime";

import classes from "./FadeSwitch.module.css";

/** Resolved value type for synchronous and async cells. */
type Resolved<V> = Awaited<V extends AsyncCell<infer P> ? P : V extends Cell<infer S> ? S : never>;

export interface FadeSwitchProps<V extends Cell<unknown>> extends Omit<
  JSX.BaseContainerProps,
  "children"
> {
  /** Current value. A key change starts a cross-fade. */
  value: V;
  /** Component identity. An unchanged key preserves the mounted instance. */
  keyOf: (value: Resolved<V>) => PropertyKey;
  /** Render a value once when its keyed instance mounts. */
  render: (value: Resolved<V>) => JSX.Template;
}

interface Layer<T> {
  /** Unique ID for this mount. Re-entering after unmount creates fresh DOM and state. */
  id: number;
  key: PropertyKey;
  value: T;
  /** Animate entry, except for the initial value. */
  enter: boolean;
  leaving: SourceCell<boolean>;
}

const nextFrame = () => {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
};

/**
 * Cross-fade keyed values in overlapping grid cells. Unmount outgoing instances after their
 * animations finish. If a key returns during exit, reuse that instance and reverse its
 * transition.
 */
export function FadeSwitch<V extends Cell<unknown>>(props: FadeSwitchProps<V>) {
  type T = Resolved<V>;
  const { value, keyOf, render, class: className, ...rest } = props;
  // Remove completed exit animations on the next update.
  const exited = Cell.source<ReadonlySet<Layer<T>>>(new Set());
  let shown: Layer<T>[] = [];
  let started = false;
  let nextId = 0;

  const layers = Cell.derivedAsync(async (get) => {
    const current = (await get(value)) as T;
    const done = get(exited);
    const key = keyOf(current);
    const kept = shown.filter((layer) => !done.has(layer));
    if (!kept.some((layer) => layer.key === key)) {
      nextId += 1;
      kept.push({ id: nextId, key, value: current, enter: started, leaving: Cell.source(false) });
    }
    for (const layer of kept) {
      layer.leaving.set(layer.key !== key);
    }
    started = true;
    shown = kept;
    return kept;
  });

  const finishExit = (layer: Layer<T>) => {
    const stillShown = [...exited.get()].filter((entry) => shown.includes(entry));
    exited.set(new Set([...stillShown, layer]));
  };

  return (
    <div {...rest} class={[classes.switch, className]}>
      {For(
        layers,
        (layer) => {
          const ref = Cell.source<HTMLElement | null>(null);
          onConnected(ref, (node) => {
            return layer.leaving.runAndListen(async (isLeaving) => {
              if (!isLeaving) {
                return;
              }
              // Wait for the state attribute to trigger the layer transition. Ignore descendant
              // animations, which may loop indefinitely.
              await nextFrame();
              await Promise.allSettled(node.getAnimations().map((animation) => animation.finished));
              if (layer.leaving.get()) {
                finishExit(layer);
              }
            });
          });
          return (
            <div
              ref={ref}
              class={classes.layer}
              data-enter={layer.enter}
              data-leaving={layer.leaving}
              inert={layer.leaving}
            >
              {render(layer.value)}
            </div>
          );
        },
        { key: "id" },
      )}
    </div>
  );
}
