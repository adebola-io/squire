import { Cell } from "retend";

import { useChat } from "@/scopes/ChatScope";

export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORT_LABELS: Record<Effort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const isEffort = (value: unknown): value is Effort => {
  return typeof value === "string" && value in EFFORT_LABELS;
};

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Read saved reasoning effort, including older nested Responses options. */
export function readEffort(options: unknown): Effort | null {
  const native = asObject(options);
  const value = native.reasoning_effort ?? asObject(native.reasoning).effort;
  return isEffort(value) ? value : null;
}

/** Set the portable reasoning-effort field that provider adapters translate. */
export function withEffort(options: unknown, next: Effort) {
  const body: Record<string, unknown> = { ...asObject(options), reasoning_effort: next };
  const reasoning = { ...asObject(body.reasoning) };
  delete reasoning.effort;
  if (Object.keys(reasoning).length === 0) delete body.reasoning;
  else body.reasoning = reasoning;
  return body;
}

export function effortLabel(effort: Effort): string {
  return EFFORT_LABELS[effort];
}

/**
 * Resolve supported reasoning levels and the saved or model-default level. Return null for
 * models without reasoning-effort settings.
 */
export function useSelectedEffort() {
  const { selectedModel, modelDiscovery, nativeOptions } = useChat();
  return Cell.derivedAsync(async (get) => {
    const model = await get(selectedModel);
    if (model === null || model.modelId === "") return null;
    try {
      const models = await get(modelDiscovery.models(model.profileId));
      const info = models.find((item) => item.id === model.modelId);
      const supported = (info?.metadata.reasoningLevels ?? []).filter(isEffort);
      if (info === undefined || supported.length === 0) return null;
      const fallback = info.metadata.reasoningDefault;
      const effort =
        readEffort(get(nativeOptions) ?? info.prefs.nativeOptions) ??
        (isEffort(fallback)
          ? fallback
          : (supported.find((level) => level !== "none") ?? supported[0]));
      return { model, info, supported, effort };
    } catch {
      return null;
    }
  });
}
