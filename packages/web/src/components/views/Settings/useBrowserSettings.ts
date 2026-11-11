import { Cell, onSetup } from "retend";

import { changeBrowserSettings, DesktopRequestError } from "@/platform/desktopClient";
import type { BrowserSettingsChange, BrowserSettingsResponse } from "@/platform/desktopClient";
import { useBrowserSettingsState } from "@/scopes/BrowserSettingsScope";
import { errorMessage } from "@/utils/misc";

/** Browser setting change and label for its confirmation dialog. */
interface PendingChange {
  change: BrowserSettingsChange;
  label: string;
}
export type BrowserSettingsModel = ReturnType<typeof useBrowserSettings>;

const needsConfirmation = (cause: Error | null) =>
  cause instanceof DesktopRequestError && cause.code === "confirmation_required";

export function useBrowserSettings() {
  // Reuse browser settings loaded at app startup.
  const { settings, refresh } = useBrowserSettingsState();
  const confirmation = Cell.source<PendingChange | null>(null);
  /** Browser selection awaiting application. */
  const choice = Cell.source<string | null>(null);
  let trigger: HTMLElement | null = null;

  const applyTask = Cell.task(async (change: BrowserSettingsChange) => {
    await changeBrowserSettings(change);
    return change.action === "open" ? "Browser opened." : "Browser settings updated.";
  });
  const busy = applyTask.pending;
  // Handle confirmation-required responses with a dialog instead of an inline error.
  const error = Cell.derived(() => {
    const cause = applyTask.error.get();
    return cause === null || needsConfirmation(cause) ? null : errorMessage(cause);
  });
  const success = Cell.derivedAsync(async (get) => {
    const message = await get(applyTask);
    return get(applyTask.error) === null ? message : null;
  });
  const loadError = Cell.derived(() => {
    const cause = settings.error.get();
    return cause === null ? null : errorMessage(cause);
  });

  const open = Cell.derived(() => confirmation.get() !== null);
  const confirmLabel = Cell.derived(() => {
    if (busy.get()) {
      return "Applying…";
    }
    if (confirmation.get()?.change.action === "select") {
      return "Change browser";
    }
    return "Reset browser data";
  });
  const dialogTitle = Cell.derived(() => {
    if (confirmation.get()?.change.action === "select") {
      return "Change browser?";
    }
    return "Reset browser data?";
  });
  const warning = Cell.derived(() => {
    const target = confirmation.get();
    let prefix = "";
    if (target?.change.action === "select") {
      prefix = `Switch to ${target.label}. `;
    }
    return `${prefix}Saved website logins and site state will be cleared. All open tabs in the shared browser, including tabs you opened, will close.`;
  });

  const apply = async (pending: PendingChange) => {
    if (busy.get()) {
      return;
    }
    await applyTask.runWith(pending.change);
    const cause = applyTask.error.get();
    if (cause === null) {
      confirmation.set(null);
      choice.set(null);
      refresh();
      trigger?.focus();
    } else if (needsConfirmation(cause) && pending.change.action === "select") {
      // Request confirmation if the browser profile was initialized after the previous read.
      confirmation.set(pending);
    }
  };
  const close = () => {
    if (busy.get()) {
      return;
    }
    confirmation.set(null);
    choice.set(null);
    queueMicrotask(() => {
      trigger?.focus();
    });
  };
  const choose = (event: Event, current: BrowserSettingsResponse) => {
    const select = event.currentTarget as HTMLSelectElement;
    trigger = select;
    const executable = select.value;
    if (executable === current.selected) {
      choice.set(null);
      return;
    }
    choice.set(executable);
    const label =
      current.browsers.find((browser) => browser.executable === executable)?.label ??
      "the selected browser";
    const pending: PendingChange = { change: { action: "select", executable }, label };
    if (current.initialized) {
      confirmation.set(pending);
    } else {
      void apply(pending);
    }
  };
  const openBrowser = () => {
    void apply({ change: { action: "open" }, label: "" });
  };
  const reset = (event: MouseEvent) => {
    trigger = event.currentTarget as HTMLElement;
    applyTask.error.set(null);
    confirmation.set({ change: { action: "reset" }, label: "" });
  };
  const confirm = () => {
    const target = confirmation.get();
    if (target) {
      void apply({ change: { ...target.change, confirm: true }, label: target.label });
    }
  };
  /** Detect browsers again after a failed read or a new installation. */
  const redetect = () => refresh({ redetect: true });

  onSetup(() => {
    // Refresh the startup snapshot when this page mounts.
    if (!settings.pending.get()) {
      refresh();
    }
  });

  return {
    settings,
    loadError,
    busy,
    error,
    success,
    choice,
    open,
    confirmLabel,
    dialogTitle,
    warning,
    close,
    choose,
    openBrowser,
    reset,
    confirm,
    redetect,
  };
}
