import { Cell, For, If } from "retend";
import { useRouteQuery } from "retend/router";
import { Button, Dialog, Icon, SearchInput } from "squire-ui";

import { LoadingState } from "@/components/ui/LoadingState";
import { LoadMore } from "@/components/ui/LoadMore";

import { ModelEditor } from "./ModelEditor";
import { CustomModelForm, ModelListEmpty } from "./ModelListNotices";
import { ModelRow } from "./ModelRow";
import { useModelPages, type ModelPages } from "./modelStore";

import classes from "./Providers.module.css";

interface ProviderModelsProps {
  profileId: string;
}

/**
 * Map provider errors to actionable messages. Preserve unrecognized nonempty backend errors and
 * supply a fallback for empty errors.
 */
function describeDiscoveryError(message: string) {
  if (/HTTP 401|unauthorized|invalid( API)? key|Incorrect API key/i.test(message)) {
    return "This provider rejected the API key. Check the key on the Connection tab, then retry.";
  }
  if (/HTTP 403|forbidden|permission/i.test(message)) {
    return "This provider refused the request. The key may lack model-listing permission.";
  }
  if (/HTTP 404|not[ -]found/i.test(message)) {
    return "This provider has no model list at its discovery address. You can still set up a model by ID.";
  }
  if (/HTTP 4\d\d/.test(message)) {
    return "The model list request was rejected. Check the connection settings, then retry.";
  }
  if (
    /HTTP 5\d\d|timeout|timed out|Failed to fetch|NetworkError|Load failed|network/i.test(message)
  ) {
    return "Couldn't reach the provider. Check your connection, then retry.";
  }
  if (message.trim() === "" || message.trim() === "null") {
    return "Model discovery failed without details. Retry, or set up a model by ID.";
  }
  return message;
}

function useModelList(profileId: string) {
  const query = useRouteQuery();
  const openModel = query.get("model");
  const pages = useModelPages(profileId, openModel);
  const showCustom = Cell.source(false);
  // Restore focus to the model row after closing its dialog.
  let opener: HTMLElement | null = null;

  const loadError = Cell.derived(() => {
    const error = pages.error.get();
    return error === null ? null : describeDiscoveryError(error.message ?? "");
  });
  const searchPlaceholder = Cell.derived(() => {
    const count = pages.total.get();
    if (pages.pending.get() && count === 0) {
      return "Search models";
    }
    return `Search ${count.toLocaleString()} ${count === 1 ? "model" : "models"}`;
  });
  const searchTerm = Cell.derived(() => {
    return pages.search.get().trim();
  });
  const isEmpty = Cell.derived(() => {
    return !pages.pending.get() && pages.error.get() === null && pages.rows.get().length === 0;
  });
  const noMatches = Cell.derived(() => {
    return isEmpty.get() && searchTerm.get() !== "";
  });
  const noModels = Cell.derived(() => {
    return isEmpty.get() && searchTerm.get() === "";
  });
  const sharedNote = Cell.derived(() => {
    const { tools, vision } = pages.common.get();
    if (tools && vision) {
      return "Every model here supports tool use and image input.";
    }
    if (tools) {
      return "Every model here supports tool use.";
    }
    if (vision) {
      return "Every model here supports image input.";
    }
    return null;
  });

  const open = (id: string, element: HTMLElement | null) => {
    opener = element;
    void query.set("model", id);
  };
  const close = () => {
    void query.delete("model");
    const target = opener;
    opener = null;
    // Restore focus on the frame after the dialog closes.
    window.requestAnimationFrame(() => {
      target?.focus();
    });
  };
  const setUpById = (id: string) => {
    showCustom.set(false);
    open(id, null);
  };
  const toggleCustom = () => {
    showCustom.set(!showCustom.get());
  };

  return {
    pages,
    openModel,
    showCustom,
    loadError,
    searchPlaceholder,
    searchTerm,
    noMatches,
    noModels,
    sharedNote,
    open,
    close,
    setUpById,
    toggleCustom,
    useSearchAsId: () => {
      open(searchTerm.get(), null);
    },
    clearSearch: () => {
      pages.search.set("");
    },
  };
}

interface ModelSettingsDialogProps {
  profileId: string;
  pages: ModelPages;
  openModel: Cell<string | null>;
  onClose: () => void;
}

/** Model settings dialog selected by `?model=<id>`; restore focus to its row when dismissed. */
function ModelSettingsDialog(props: ModelSettingsDialogProps) {
  const { profileId, pages, openModel, onClose } = props;
  // Key editors by model ID to preserve drafts on save. Wait for the first page before mounting
  // so deep-linked models do not initialize from defaults.
  const editors = Cell.derived(() => {
    const id = openModel.get();
    if (id === null || id === "" || pages.pending.get()) {
      return [];
    }
    return [{ key: id }];
  });
  const isOpen = Cell.derived(() => {
    return editors.get().length > 0;
  });
  const onOpenChange = (next: boolean) => {
    if (!next) {
      onClose();
    }
  };

  return (
    <Dialog id={`model-settings-${profileId}`} open={isOpen} onOpenChange={onOpenChange}>
      <Dialog.Content size="larger" class={classes.dialog} ariaLabel="Model settings">
        {For(
          editors,
          ({ key }) => {
            return (
              <ModelEditor
                profileId={profileId}
                modelId={key}
                rows={pages.rows}
                pending={pages.pending}
                onSaved={pages.patch}
                onClose={onClose}
              />
            );
          },
          { key: "key" },
        )}
      </Dialog.Content>
    </Dialog>
  );
}

/** Provider model list with server-side search, paging and settings dialogs. */
export function ProviderModels(props: ProviderModelsProps) {
  const { profileId } = props;
  const list = useModelList(profileId);
  const { pages } = list;

  return (
    <section class={classes.models} aria-busy={pages.pending} data-initialized={pages.initialLoad}>
      <SearchInput
        model={pages.search}
        placeholder={list.searchPlaceholder}
        label="Search models"
      />
      <div class={classes.listMeta}>
        {If(list.sharedNote, (note) => {
          return (
            <p class={classes.status} title={note}>
              {note}
            </p>
          );
        })}
        <button
          type="button"
          class={classes.disclosure}
          aria-expanded={list.showCustom}
          onClick={list.toggleCustom}
        >
          <Icon name="caret" aria-hidden="true" />
          Model not listed?
        </button>
      </div>
      <CustomModelForm open={list.showCustom} onSetUp={list.setUpById} />
      {If(pages.pending, () => (
        <LoadingState region label="Fetching models from this provider…" />
      ))}
      {If(list.loadError, (message) => {
        return (
          <div class={classes.notice} role="alert">
            <p title={message}>{message}</p>
            <Button variant="outline" onClick={pages.refresh}>
              Retry
            </Button>
          </div>
        );
      })}
      <ModelListEmpty
        noModels={list.noModels}
        noMatches={list.noMatches}
        searchTerm={list.searchTerm}
        showCustom={list.showCustom}
        onUseSearch={list.useSearchAsId}
        onClearSearch={list.clearSearch}
      />
      <ul class={classes.modelList}>
        {For(
          pages.rows,
          (model) => {
            return (
              <ModelRow
                profileId={profileId}
                initial={model}
                rows={pages.rows}
                common={pages.common}
                onOpen={list.open}
                onSaved={pages.patch}
              />
            );
          },
          { key: "id" },
        )}
      </ul>
      <LoadMore
        hasMore={pages.hasMore}
        loading={pages.loadingMore}
        onLoad={pages.loadMore}
        label="Load more models"
        loadingLabel="Fetching more models…"
      />
      <ModelSettingsDialog
        profileId={profileId}
        pages={pages}
        openModel={list.openModel}
        onClose={list.close}
      />
    </section>
  );
}
