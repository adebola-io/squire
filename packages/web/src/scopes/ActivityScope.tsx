import {
  Cell,
  createScope,
  onSetup,
  useScopeContext,
  type AsyncCell,
  type SourceCell,
} from "retend";
import type { JSX } from "retend/jsx-runtime";

import { listAllConnectionThreads } from "@/platform/desktopClient";
import { onDesktopEvent } from "@/scopes/DesktopEventsScope";
import { debounce, delay } from "@/utils/misc";

interface ActivityCtx {
  threads: AsyncCell<ThreadPage>;
  search: SourceCell<string>;
  query: AsyncCell<string>;
  limit: SourceCell<number>;
  refresh: () => void;
}

const ActivityScope = createScope<ActivityCtx>();

interface ActivityProviderProps {
  children: JSX.Children;
}

export interface Thread {
  cursorId: string;
  id: string;
  startedAt: string;
  lastActivityAt: string;
  title: string;
  client: string;
  errorCount: number;
  entryCount: number;
  /** Client-local, monotonic expiry; null means no observed/inferred work. */
  workingUntil: number | null;
}

interface ServerThread extends Omit<Thread, "workingUntil"> {
  workingRemainingMs: number | null;
}

interface ServerThreadPage {
  threads: ServerThread[];
  total: number;
}

export interface ThreadPage {
  threads: Thread[];
  total: number;
}

const SEARCH_DELAY_MS = 200;
export const CONNECTION_PAGE_SIZE = 20;
export const MAX_CONNECTION_ROWS = 1000;

export function ActivityProvider(props: ActivityProviderProps) {
  const { children } = props;
  const search = Cell.source("");
  const limit = Cell.source(CONNECTION_PAGE_SIZE);
  const query = Cell.derivedAsync(async (get, signal) => {
    const value = get(search).trim();
    if (value === "") return value;
    await delay(SEARCH_DELAY_MS, signal);
    return value;
  });
  const threads = Cell.derivedAsync(async (get, signal) => {
    const requested = get(limit);
    const searched = await get(query);
    // Anchor to the request start, not the skewable wall clock. Network delay
    // can only shorten an inferred display, never resurrect expired work.
    const receivedAt = performance.now();
    const page = await listAllConnectionThreads<ServerThreadPage>(
      requested,
      null,
      searched,
      signal,
    );
    return {
      ...page,
      threads: page.threads.map(({ workingRemainingMs, ...thread }) => ({
        ...thread,
        workingUntil: workingRemainingMs === null ? null : receivedAt + workingRemainingMs,
      })),
    };
  });

  // The visible prefix is revalidated on each activity event. Reset its size
  // when searching rather than retaining a large loaded count.
  search.listen(() => limit.set(CONNECTION_PAGE_SIZE));
  const refresh = debounce(() => threads.revalidate());
  onDesktopEvent("activity", refresh);
  onDesktopEvent("connection.opened", () => threads.revalidate());
  onDesktopEvent("resync", () => threads.revalidate());
  onSetup(() => () => refresh.cancel());

  return (
    <ActivityScope.Provider
      value={{ threads, search, query, limit, refresh: () => threads.revalidate() }}
    >
      {children}
    </ActivityScope.Provider>
  );
}

export function useActivity() {
  return useScopeContext(ActivityScope);
}
