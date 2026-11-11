import { Cell, onSetup, type AsyncCell, type SourceCell } from "retend";

import { discoverModels, saveModelPrefs } from "@/platform/desktopClient";
import type {
  CommonCapabilities,
  ModelInfo,
  ModelMetadata,
  ModelPrefs,
} from "@/platform/desktopClient";

export type { CommonCapabilities } from "@/platform/desktopClient";

/** Model-list page size. */
const PAGE_SIZE = 50;
/** Search debounce interval. */
const SEARCH_DELAY_MS = 250;

export interface ModelPages {
  /** Loaded models, deduplicated and sorted by ID. */
  rows: Cell<ModelInfo[]>;
  /** Total from the latest unfiltered provider listing. */
  total: Cell<number>;
  common: Cell<CommonCapabilities>;
  hasMore: Cell<boolean>;
  /** Initial request exposed as an Await render dependency. */
  initialLoad: AsyncCell<boolean>;
  /** Whether a first-page search or refresh is pending. */
  pending: Cell<boolean>;
  loadingMore: Cell<boolean>;
  error: Cell<Error | null>;
  search: SourceCell<string>;
  /** Refresh the provider's model list instead of using the server cache. */
  refresh: () => void;
  loadMore: () => void;
  /** Update or insert a saved model in the loaded rows. */
  patch: (model: ModelInfo) => void;
}

function mergeRows(current: ModelInfo[], incoming: ModelInfo[]) {
  const byId = new Map(
    current.map((model) => {
      return [model.id, model] as const;
    }),
  );
  for (const model of incoming) {
    byId.set(model.id, model);
  }
  return [...byId.values()].sort((left, right) => {
    return left.id.localeCompare(right.id);
  });
}

/**
 * Load model pages with server-side search. Cancel superseded requests, ignore late responses,
 * and abort pending work on unmount.
 */
export function useModelPages(profileId: string, include: Cell<string | null>): ModelPages {
  const rows = Cell.source<ModelInfo[]>([]);
  const total = Cell.source(0);
  const common = Cell.source<CommonCapabilities>({ tools: false, vision: false });
  const search = Cell.source("");
  const cursor = Cell.source<string | null>(null);
  const hasMore = Cell.derived(() => cursor.get() !== null);
  const request = Cell.source({
    q: "",
    include: include.get(),
    refresh: false,
    after: null as string | null,
    revision: 0,
  });

  /** Fetch the first page or the page after a cursor. */
  const pageRequest = Cell.derivedAsync(async (get, signal) => {
    const { q, include: included, refresh, after } = get(request);
    const first = after === null;
    const page = await discoverModels(
      profileId,
      signal,
      first ? { q, limit: PAGE_SIZE, include: included, refresh } : { q, limit: PAGE_SIZE, after },
    );
    if (signal.aborted) return;
    rows.set(mergeRows(first ? [] : rows.peek(), page.models));
    // Retain the unfiltered total while search responses report only matching models.
    if (first && q === "") {
      // Older servers omit paging fields and return the complete list.
      total.set(page.total ?? page.models.length);
    }
    if (first) {
      common.set(page.common ?? { tools: false, vision: false });
    }
    cursor.set(page.nextCursor ?? null);
  });
  const pending = Cell.derived(() => pageRequest.pending.get() && request.get().after === null);
  const loadingMore = Cell.derived(() => pageRequest.pending.get() && request.get().after !== null);
  const error = pageRequest.error;
  const fetchPage = (refresh: boolean, after: string | null = null) => {
    request.set({
      q: search.get().trim(),
      include: include.get(),
      refresh,
      after,
      revision: request.get().revision + 1,
    });
  };

  // Fetch a deep-linked model separately if it is absent from the loaded pages.
  const ensureIncluded = async (id: string | null) => {
    if (id === null || id === "" || pending.get()) {
      return;
    }
    const present = rows.get().some((model) => {
      return model.id === id;
    });
    if (present) {
      return;
    }
    try {
      const page = await discoverModels(profileId, undefined, { q: id, limit: PAGE_SIZE });
      const exact = page.models.filter((model) => {
        return model.id === id;
      });
      if (exact.length > 0) {
        rows.set(mergeRows(rows.get(), exact));
      }
    } catch {
      // The dialog opens on defaults; the list's own error says why.
    }
  };

  let searchTimer: number | undefined;
  search.listen(() => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      fetchPage(false);
    }, SEARCH_DELAY_MS);
  });
  include.listen((id) => {
    void ensureIncluded(id);
  });
  // Only the initial load participates in Await. Keep existing rows mounted during later
  // requests; the async cell handles status and cancellation.
  const initialRequest = pageRequest.peek();
  const initialLoad = Cell.derivedAsync(async () => {
    await initialRequest;
    return true;
  });
  onSetup(() => {
    return () => {
      window.clearTimeout(searchTimer);
    };
  });

  return {
    initialLoad,
    rows,
    total,
    common,
    hasMore,
    pending,
    loadingMore,
    error,
    search,
    refresh: () => {
      fetchPage(true);
    },
    loadMore: () => {
      const after = cursor.get();
      if (after !== null && !loadingMore.get() && !pending.get()) {
        fetchPage(false, after);
      }
    },
    patch: (model: ModelInfo) => {
      rows.set(mergeRows(rows.get(), [model]));
    },
  };
}

export const DEFAULT_METADATA: ModelMetadata = {
  contextWindow: 131072,
  maxOutput: 8192,
  tools: true,
  vision: false,
  reasoningStyle: "native",
  inputPrice: null,
  outputPrice: null,
};

const DEFAULT_PREFS: ModelPrefs = {
  hidden: false,
  alias: null,
  nativeOptions: {},
  metadata: null,
};

/** Editable default record for an unlisted model ID. */
export function blankModel(id: string): ModelInfo {
  return { id, metadata: { ...DEFAULT_METADATA }, prefs: { ...DEFAULT_PREFS } };
}

export interface SwitchChange {
  hidden?: boolean;
  tools?: boolean;
  vision?: boolean;
}

/**
 * Save a toggle from persisted model values, excluding unsaved form fields. Capability changes
 * create metadata overrides; visibility changes preserve catalog metadata.
 */
export async function saveSwitch(
  profileId: string,
  model: ModelInfo,
  change: SwitchChange,
): Promise<ModelInfo> {
  const capabilityChanged = change.tools !== undefined || change.vision !== undefined;
  const metadata: ModelMetadata = {
    ...model.metadata,
    tools: change.tools ?? model.metadata.tools,
    vision: change.vision ?? model.metadata.vision,
  };
  const prefs: ModelPrefs = {
    ...model.prefs,
    hidden: change.hidden ?? model.prefs.hidden,
    metadata: capabilityChanged ? metadata : model.prefs.metadata,
  };
  await saveModelPrefs({ profileId, modelId: model.id }, prefs);
  return { ...model, prefs, metadata: capabilityChanged ? metadata : model.metadata };
}

/** Compact token count with at most one decimal place and no trailing `.0`. */
export function formatTokens(count: number) {
  if (count >= 1_000_000) {
    const millions = Math.round(count / 100_000) / 10;
    return `${millions}M`;
  }
  if (count >= 10_000) {
    return `${Math.round(count / 1000)}K`;
  }
  return count.toLocaleString();
}

/** Model alias, catalog name, or ID, in that order. */
export function modelName(model: ModelInfo) {
  return model.prefs.alias ?? model.metadata.name ?? model.id;
}
