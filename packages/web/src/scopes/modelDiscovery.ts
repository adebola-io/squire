import { Cell } from "retend";

import { discoverModels } from "@/platform/desktopClient";

function createModelsCell(profileId: string) {
  return Cell.derivedAsync(async (_get, signal) => {
    return (await discoverModels(profileId, signal)).models;
  });
}

type ModelsCell = ReturnType<typeof createModelsCell>;

interface CacheEntry {
  revision: number;
  models: ModelsCell;
}

/** ChatScope-scoped discovery cache that survives model-picker unmounts. */
export function createModelDiscoveryStore() {
  // Discovery cells live as long as the owning scope so a model picker can come and go without
  // refetching; this context releases them when the scope is torn down.
  const context = Cell.context();
  const cache = new Map<string, CacheEntry>();
  let revision = 0;

  const models = (profileId: string) => {
    const cached = cache.get(profileId);
    if (cached !== undefined) {
      if (cached.revision !== revision) {
        cached.revision = revision;
        cached.models.revalidate();
      }
      return cached.models;
    }
    const entry = {
      revision,
      models: Cell.runWithContext(context, () => createModelsCell(profileId)),
    };
    cache.set(profileId, entry);
    return entry.models;
  };
  const refresh = (profileId: string) => {
    const cached = cache.get(profileId);
    if (cached === undefined) {
      models(profileId);
      return;
    }
    cached.revision = revision;
    cached.models.revalidate();
  };
  const invalidate = () => {
    // Mark provider data stale and refresh on its next use.
    revision += 1;
  };
  const dispose = () => {
    cache.clear();
    context.destroy();
  };

  return { models, refresh, invalidate, dispose };
}

export type ModelDiscoveryStore = ReturnType<typeof createModelDiscoveryStore>;
