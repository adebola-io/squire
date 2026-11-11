import { Button, Input } from "innate-ui";
import { Cell, For, If, onConnected } from "retend";
import { Icon } from "squire-ui";

import { LoadingState } from "@/components/ui/LoadingState";
import type { DesktopProviderProfile, ModelInfo } from "@/platform/desktopClient";
import { useChat } from "@/scopes/ChatScope";
import { useLiveValue } from "@/utils/fieldValue";
import { toError } from "@/utils/misc";

import { modelIcon } from "./modelIcon";
import { ModelPickerList } from "./ModelPickerList";
import { ModelPickerReasoning } from "./ModelPickerReasoning";

import classes from "./Chat.module.css";

const PAGE_SIZE = 100;

export interface PickerModel extends ModelInfo {
  key: string;
  profileId: string;
  icon: ReturnType<typeof modelIcon>;
}

/** Model-list group for one provider. */
export interface ProviderGroup {
  key: string;
  profileId: string;
  name: string;
  models: PickerModel[];
  error: Error | null;
}

interface ProviderModels {
  profile: DesktopProviderProfile;
  models: ModelInfo[];
  error: Error | null;
}

function matches(model: ModelInfo, term: string) {
  const text = `${model.id} ${model.prefs.alias ?? ""} ${model.metadata.name ?? ""}`;
  return text.toLowerCase().includes(term);
}

/** List models from all providers. Apply a selection only to subsequent requests. */
function useModelPicker() {
  const {
    providers,
    selectedModel,
    modelIntent,
    nativeOptions,
    snapshot,
    busy,
    refreshProviders,
    modelDiscovery,
  } = useChat();
  const search = Cell.source("");
  const searchRef = useLiveValue(search);
  onConnected(searchRef, (input) => {
    // Focus after the opening event, because the native popover restores trigger focus during
    // that event.
    const timeout = window.setTimeout(() => input.focus(), 0);
    return () => window.clearTimeout(timeout);
  });
  const limit = Cell.source(PAGE_SIZE);
  // Exclude built-in providers without configured credentials.
  const profiles = Cell.derivedAsync(async (get) => {
    const all = (await get(providers))?.profiles ?? [];
    return all.filter((profile) => !profile.builtin || profile.configured);
  });
  // Discover providers concurrently and show failures within their own groups.
  const listed = Cell.derivedAsync(async (get) => {
    const available = await get(profiles);
    return await Promise.all(
      available.map(async (profile): Promise<ProviderModels> => {
        const discovery = modelDiscovery.models(profile.id);
        try {
          const models = await get(discovery);
          const error = get(discovery.error);
          if (error !== null) throw error;
          return { profile, models: models.filter((model) => !model.prefs.hidden), error: null };
        } catch (cause) {
          return { profile, models: [], error: toError(cause) };
        }
      }),
    );
  });
  const filtered = Cell.derivedAsync(async (get) => {
    const term = get(search).trim().toLowerCase();
    const current = await get(selectedModel);
    const all = await get(listed);
    // Sort the active provider first. With no search query, put its selected model first as
    // well.
    const ordered = [...all].sort((a, b) => {
      return (
        Number(b.profile.id === current?.profileId) - Number(a.profile.id === current?.profileId)
      );
    });
    return ordered.map((entry) => {
      let models = entry.models.filter((model) => matches(model, term));
      if (term === "" && entry.profile.id === current?.profileId) {
        const index = models.findIndex((model) => model.id === current.modelId);
        if (index > 0) {
          models = [models[index], ...models.slice(0, index), ...models.slice(index + 1)];
        }
      }
      return { ...entry, models };
    });
  });
  const groups = Cell.derivedAsync(async (get): Promise<ProviderGroup[]> => {
    let remaining = get(limit);
    const shown: ProviderGroup[] = [];
    for (const entry of await get(filtered)) {
      const models = entry.models.slice(0, Math.max(remaining, 0));
      remaining -= models.length;
      if (models.length === 0 && entry.error === null) continue;
      shown.push({
        key: entry.profile.id,
        profileId: entry.profile.id,
        name: entry.profile.displayName,
        error: entry.error,
        models: models.map((model) => ({
          ...model,
          key: `${entry.profile.id}/${model.id}`,
          profileId: entry.profile.id,
          icon: modelIcon(model.id, entry.profile.icon),
        })),
      });
    }
    return shown;
  });
  const total = Cell.derivedAsync(async (get) => {
    return (await get(filtered)).reduce((count, entry) => count + entry.models.length, 0);
  });
  const hasMore = Cell.derivedAsync(async (get) => (await get(total)) > get(limit));
  const emptyMessage = Cell.derivedAsync(async (get) => {
    if (get(listed.pending) || get(providers.error)) return null;
    if ((await get(profiles)).length === 0) return "Add a provider to choose a model.";
    const all = await get(listed);
    if (all.some((entry) => entry.error !== null)) return null;
    if (all.every((entry) => entry.models.length === 0)) {
      return "No models listed. Enter a model ID above or manage your providers.";
    }
    return (await get(total)) === 0 ? "No models match your search." : null;
  });
  const customId = Cell.derived(() => search.get().trim());
  // Allow an unlisted model ID with any provider.
  const customTargets = Cell.derivedAsync(async (get) => {
    const id = get(customId);
    if (id === "" || get(listed.pending)) return [];
    const all = await get(listed);
    if (all.some((entry) => entry.models.some((model) => model.id === id))) return [];
    const single = all.length === 1;
    return all.map((entry) => ({
      key: entry.profile.id,
      profileId: entry.profile.id,
      label: single ? "Use model ID" : `Use with ${entry.profile.displayName}`,
    }));
  });
  const blocked = Cell.derived(() => {
    return busy.get() || snapshot.get()?.conversation.executionStatus === "running";
  });
  const loading = Cell.derived(() => providers.pending.get() || listed.pending.get());
  const ready = Cell.derived(() => !loading.get() && providers.error.get() === null);
  const chooseModel = (profile: string, id: string) => {
    if (blocked.get() || profile === "" || id === "") return;
    modelIntent.set({ profileId: profile, modelId: id });
    nativeOptions.set(null);
  };
  const retry = (profileId: string) => modelDiscovery.refresh(profileId);
  const updateSearch = (value: string) => {
    search.set(value);
    limit.set(PAGE_SIZE);
  };
  const showMore = () => limit.set(limit.get() + PAGE_SIZE);
  return {
    providers,
    groups,
    hasMore,
    search,
    searchRef,
    customId,
    customTargets,
    blocked,
    loading,
    ready,
    emptyMessage,
    selectedModel,
    chooseModel,
    retry,
    refreshProviders,
    updateSearch,
    showMore,
  };
}

export type ModelPickerState = ReturnType<typeof useModelPicker>;

interface ModelPickerProps {
  onSelect?: () => void;
}

export function ModelPicker(props: ModelPickerProps) {
  const { onSelect } = props;
  const picker = useModelPicker();
  const { search, searchRef, blocked } = picker;
  // Select models from result rows; Enter in the search field only submits the search.
  const ignoreSubmit = () => undefined;
  return (
    <div class={classes.modelPicker}>
      <form class={classes.modelPickerControls} onSubmit--prevent={ignoreSubmit}>
        <label class={classes.modelPickerSearch}>
          <Icon name="search" aria-hidden="true" />
          <Input
            ref={searchRef}
            type="search"
            aria-label="Search models or enter a model ID"
            value={search}
            onChange={picker.updateSearch}
            placeholder="Search models or enter an ID"
            {...{ autocomplete: "off", autofocus: true }}
          />
        </label>
      </form>
      <div class={classes.modelPickerResults} aria-busy={picker.loading}>
        {If(picker.loading, () => (
          <LoadingState region label="Fetching available models…" />
        ))}
        {If(picker.providers.error, (error) => (
          <div class={classes.modelPickerError} role="alert">
            <p>{error.message}</p>
            <Button type="button" variant="ghost" onClick={picker.refreshProviders}>
              Retry
            </Button>
          </div>
        ))}
        {If(picker.emptyMessage, (message) => (
          <p class={classes.modelHint} role="status">
            {message}
          </p>
        ))}
        {If(picker.ready, () => (
          <ModelPickerList picker={picker} />
        ))}
        {For(
          picker.customTargets,
          (target) => (
            <Button
              type="button"
              variant="ghost"
              class={classes.modelPickerCustom}
              disabled={blocked}
              onClick={() => picker.chooseModel(target.profileId, picker.customId.get())}
              title={picker.customId}
            >
              <span>
                {target.label} <strong>{picker.customId}</strong>
              </span>
              <Button.End>
                <Icon name="caret" aria-hidden="true" />
              </Button.End>
            </Button>
          ),
          { key: "key" },
        )}
      </div>
      <div class={classes.modelPickerFooter}>
        {If(blocked, () => (
          <p class={classes.modelHint}>Stop or wait to change models.</p>
        ))}
        <ModelPickerReasoning onSelect={onSelect} />
      </div>
    </div>
  );
}
