import { Cell, For, If, onSetup } from "retend";
import { Dialog, Icon } from "squire-ui";

import { LoadingState } from "@/components/ui/LoadingState";
import { listConversations } from "@/platform/desktopClient";
import type { DesktopConversation } from "@/platform/desktopEvents";
import { useChat } from "@/scopes/ChatScope";

import { groupConversations } from "./chatModel";
import { SearchResultRow, searchRowDomId } from "./ChatSearchRow";

import classes from "./Chat.module.css";
import sidebarClasses from "@/components/ui/Sidebar/Sidebar.module.css";

const SEARCH_DEBOUNCE_MS = 200;
const RECENT_LIMIT = 12;

interface ChatSearchProps {
  open: Cell<boolean>;
  onOpenChange: (open: boolean) => void;
}

interface PaletteRow {
  key: string;
  kind: "heading" | "conversation";
  label?: string;
  conversation?: DesktopConversation;
}

function useSearchPalette() {
  const { conversations, clock } = useChat();
  const text = Cell.source("");
  const revision = Cell.source(0);
  const activeId = Cell.source<string | null>(null);
  const inputRef = Cell.source<HTMLInputElement | null>(null);

  const matches = Cell.derivedAsync(async (get, signal) => {
    const query = get(text).trim();
    get(revision);
    // Not keyed on the conversation list: list events arrive continuously while any chat runs,
    // and re-querying on each one restarts the debounce. Result rows read live titles and status.
    if (query === "") {
      return null;
    }
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, SEARCH_DEBOUNCE_MS);
      signal.addEventListener(
        "abort",
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    if (signal.aborted) {
      return [];
    }
    return (await listConversations(signal, query)).conversations;
  });

  const rows = Cell.derivedAsync(async (get) => {
    const found = await get(matches);
    const source = found ?? get(conversations).slice(0, RECENT_LIMIT);
    const list: PaletteRow[] = [];
    for (const group of groupConversations(source, get(clock))) {
      list.push({ key: `group:${group.label}`, kind: "heading", label: group.label });
      for (const conversation of group.conversations) {
        list.push({ key: conversation.id, kind: "conversation", conversation });
      }
    }
    return list;
  });

  const items = Cell.derivedAsync(async (get) => {
    return (await get(rows))
      .filter((row) => row.kind === "conversation")
      .map((row) => row.conversation!);
  });

  // Reset the active result after new results or search input.
  const onInput = (event: Event) => {
    text.set((event.currentTarget as HTMLInputElement).value);
    activeId.set(null);
  };

  // Handle arrow keys on the container so they work from both the input and result rows.
  const move = async (step: number) => {
    const list = await items.get();
    if (list.length === 0) {
      return;
    }
    const current = list.findIndex((item) => item.id === activeId.get());
    // With nothing highlighted, Down starts at the first result and Up at the last.
    const next =
      current === -1
        ? step > 0
          ? 0
          : list.length - 1
        : (current + step + list.length) % list.length;
    const target = list[next];
    activeId.set(target.id);
    // Scroll the active result into view without moving focus from the input.
    document.getElementById(searchRowDomId(target.id))?.scrollIntoView({ block: "nearest" });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      void move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      void move(-1);
    }
  };

  const searching = Cell.derived(() => {
    return text.get().trim() !== "" && matches.pending.get();
  });
  const noResults = Cell.derivedAsync(async (get) => {
    if (get(text).trim() === "") {
      return false;
    }
    if (get(searching)) {
      return false;
    }
    const found = await get(matches);
    return found !== null && found.length === 0;
  });
  const isEmpty = Cell.derived(() => text.get() === "");

  onSetup(() => {
    inputRef.get()?.focus();
  });

  return {
    text,
    matches,
    rows,
    items,
    activeId,
    inputRef,
    onInput,
    onKeyDown,
    noResults,
    searching,
    isEmpty,
    retry: () => revision.set(revision.get() + 1),
    clear: () => {
      text.set("");
      activeId.set(null);
    },
  };
}

interface SearchPaletteProps {
  onNavigate: (id: string) => void;
}

const isMac = window.navigator.platform.startsWith("Mac");
const shortcutLabel = isMac ? "⌘K" : "Ctrl K";

export function ChatSearch(props: ChatSearchProps) {
  const { open, onOpenChange } = props;
  const dialogId = `chat-search-${crypto.randomUUID()}`;
  const { select } = useChat();
  const close = () => onOpenChange(false);
  const navigate = (id: string) => {
    select(id);
    close();
  };

  return (
    <Dialog id={dialogId} open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger>
        <button
          type="button"
          class={[sidebarClasses.sidebarItem, classes.searchButton]}
          title="Search chats"
        >
          <Icon name="search" class={sidebarClasses.sidebarItemIcon} aria-hidden="true" />
          <span>Search</span>
          <kbd class={classes.searchShortcut}>{shortcutLabel}</kbd>
        </button>
      </Dialog.Trigger>
      <Dialog.Content size="medium" class={classes.searchDialog} ariaLabel="Search chats">
        {If(open, () => (
          <SearchPalette onNavigate={navigate} />
        ))}
      </Dialog.Content>
    </Dialog>
  );
}

function SearchPalette(props: SearchPaletteProps) {
  const palette = useSearchPalette();
  const activeDescendant = Cell.derived(() => {
    const id = palette.activeId.get();
    return id === null ? undefined : searchRowDomId(id);
  });
  const submit = (event: SubmitEvent | undefined) => {
    if (!event) {
      return;
    }
    void (async () => {
      const list = await palette.items.get();
      if (list.length === 0) {
        return;
      }
      const highlighted = palette.activeId.get();
      const target = list.some((item) => item.id === highlighted) ? highlighted! : list[0].id;
      props.onNavigate(target);
    })();
  };
  return (
    <div class={classes.searchPalette} onKeyDown={palette.onKeyDown}>
      <form
        class={classes.searchField}
        role="search"
        onSubmit--prevent={submit}
        aria-label="Search chats by title or message"
      >
        <Icon name="search" aria-hidden="true" />
        <input
          ref={palette.inputRef}
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls="chat-search-results"
          aria-activedescendant={activeDescendant}
          aria-label="Search chats by title or message"
          placeholder="Search by title or message…"
          value={palette.text}
          onInput={palette.onInput}
        />
        <button
          type="button"
          class={classes.searchClear}
          title="Clear search"
          disabled={palette.isEmpty}
          onClick={palette.clear}
        >
          <Icon name="cancel" aria-hidden="true" />
        </button>
      </form>
      <ul
        class={classes.searchResults}
        id="chat-search-results"
        role="listbox"
        aria-label="Matching chats"
        aria-busy={palette.searching}
      >
        {If(palette.searching, () => (
          <li class={classes.searchLoading}>
            <LoadingState region label="Searching chats…" />
          </li>
        ))}
        {If(palette.matches.error, (error) => (
          <li class={classes.searchEmpty} role="alert">
            {error.message}
            <button type="button" onClick={palette.retry}>
              Retry
            </button>
          </li>
        ))}
        {For(
          palette.rows,
          (row) => {
            if (row.kind === "heading") {
              return (
                <li class={classes.searchGroupLabel} aria-hidden="true">
                  {row.label}
                </li>
              );
            }
            return (
              <SearchResultRow
                conversation={row.conversation!}
                activeId={palette.activeId}
                onOpen={props.onNavigate}
              />
            );
          },
          { key: "key" },
        )}
        {If(palette.noResults, () => (
          <li class={classes.searchEmpty}>No chats match this search.</li>
        ))}
      </ul>
    </div>
  );
}
