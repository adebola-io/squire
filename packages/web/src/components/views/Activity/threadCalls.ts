import { Cell, onSetup } from "retend";

import { listActivityForThread } from "@/platform/desktopClient";
import { onDesktopEvent } from "@/scopes/DesktopEventsScope";

import type { ToolCallType } from "./ToolCalls";

interface ToolCallPage {
  entries: ToolCallType[];
  nextBefore: string | null;
}

const PAGE_SIZE = 10;
const REFRESH_DEBOUNCE_MS = 100;

/** Merge older pages with the latest first page. */
export function useThreadCalls(open: Cell<boolean>, threadId: string) {
  let refreshTimer: number | undefined;
  let stale = false;
  const older = Cell.source<ToolCallPage | null>(null);
  const revealFrom = Cell.source<number | null>(null);
  const loadOlder = Cell.task(async (_: unknown, signal) => {
    const current = await view.get();
    if (current.nextBefore === null || signal.aborted) return;
    const page = await listActivityForThread<ToolCallPage>(
      threadId,
      PAGE_SIZE,
      current.nextBefore,
      signal,
    );
    if (signal.aborted) return;
    const latest = await view.get();
    if (signal.aborted) return;
    const ids = new Set(latest.entries.map((call) => call.id));
    const fresh = page.entries.filter((call) => !ids.has(call.id));
    revealFrom.set(latest.entries.length);
    older.set({
      entries: [...(older.get()?.entries ?? []), ...fresh],
      nextBefore: page.nextBefore,
    });
  });
  const firstPage = Cell.derivedAsync((_get, signal) => {
    return listActivityForThread<ToolCallPage>(threadId, PAGE_SIZE, null, signal);
  });
  const view = Cell.derivedAsync(async (get): Promise<ToolCallPage> => {
    const page = await get(firstPage);
    if (page === null) return { entries: [], nextBefore: null };
    const previous = get(older);
    const last = page.entries.at(-1);
    const tail =
      last === undefined
        ? []
        : (previous?.entries ?? []).filter((call) => {
            return (
              call.startedAt < last.startedAt ||
              (call.startedAt === last.startedAt && call.id < last.id)
            );
          });
    return {
      entries: [...page.entries, ...tail],
      nextBefore: tail.length > 0 && previous !== null ? previous.nextBefore : page.nextBefore,
    };
  });
  const toolCalls = Cell.derivedAsync(async (get) => (await get(view)).entries);
  const maxToolCalls = Cell.derivedAsync(async (get) => (await get(toolCalls)).length);
  const hasOlder = Cell.derivedAsync(async (get) => (await get(view)).nextBefore !== null);
  const olderError = Cell.derived(() => {
    const cause = loadOlder.error.get();
    if (cause === null) return null;
    return cause instanceof Error ? cause.message : "Could not load earlier calls";
  });
  const showOlder = async () => {
    if (!loadOlder.pending.get()) await loadOlder.runWith(null);
  };

  // Refresh a stale thread when it expands.
  open.listen((isOpen) => {
    if (isOpen && stale) {
      stale = false;
      firstPage.revalidate();
    }
  });
  onDesktopEvent("activity", (event) => {
    if (event.threadId !== undefined && event.threadId !== threadId) return;
    if (!open.get()) {
      stale = true;
      return;
    }
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => firstPage.revalidate(), REFRESH_DEBOUNCE_MS);
  });
  onSetup(() => () => window.clearTimeout(refreshTimer));

  return {
    toolCalls,
    maxToolCalls,
    hasOlder,
    loadingOlder: loadOlder.pending,
    olderError,
    revealFrom,
    showOlder,
  };
}
