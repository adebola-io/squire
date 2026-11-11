export function pluralize(count: number, singular: string, plural: string) {
  if (count === 1) return `${count} ${singular}`;
  return `${count} ${plural}`;
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Normalize a failure to an Error object. */
export function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

/** Return a non-array object or null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function pathBasename(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function debounce(callback: () => void, delay = 100) {
  let timer: number | undefined;
  const run = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(callback, delay);
  };
  run.cancel = () => window.clearTimeout(timer);
  return run;
}

/** Resolve after `ms` or reject when aborted, cancelling obsolete async work. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort);
  });
}
