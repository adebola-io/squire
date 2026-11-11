import { Cell } from "retend";
import type { IconName } from "squire-ui";

import { modelName } from "@/components/views/Settings/modelStore";
import type { ModelRef } from "@/platform/desktopEvents";
import { useChat } from "@/scopes/ChatScope";

import { modelIcon } from "./modelIcon";

/** Tracked getter supplied by an async derived cell. */
type Track = <T>(cell: Cell<T | Promise<T>>) => T | Promise<T>;

/** Read the displayed model from a synchronous or async cell. */
type ModelRead = (track: Track) => ModelRef | null | Promise<ModelRef | null>;

/** A model reference without an ID has no display value. */
function usable(ref: ModelRef | null): ModelRef | null {
  return ref === null || ref.modelId === "" ? null : ref;
}

/** Resolve the model-family icon, then provider icon, then the supplied fallback. */
export function useModelMark(read: ModelRead, fallback: IconName) {
  const { providers } = useChat();
  return Cell.derivedAsync(async (get) => {
    const current = usable(await read(get));
    if (current === null) return fallback;
    try {
      const profile = (await get(providers)).profiles.find((item) => {
        return item.id === current.profileId;
      });
      return modelIcon(current.modelId, profile?.icon);
    } catch {
      // Use the model-family icon if provider data is unavailable.
      return modelIcon(current.modelId);
    }
  });
}

/**
 * Resolve the alias, catalog name, or model ID, in that order. Use the fallback when no model
 * is selected.
 */
export function useModelName(read: ModelRead, fallback: string) {
  const { modelDiscovery } = useChat();
  return Cell.derivedAsync(async (get) => {
    const current = usable(await read(get));
    if (current === null) return fallback;
    try {
      const listed = await get(modelDiscovery.models(current.profileId));
      const entry = listed.find((candidate) => {
        return candidate.id === current.modelId;
      });
      return entry === undefined ? current.modelId : modelName(entry);
    } catch {
      return current.modelId;
    }
  });
}
