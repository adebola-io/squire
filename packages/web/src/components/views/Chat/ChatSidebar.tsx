import { Cell, For, If, onSetup } from "retend";
import { useCurrentRoute } from "retend/router";
import { Button, FadeScroll, Icon } from "squire-ui";

import { AppLink } from "@/components/ui/AppLink";
import { LoadMore } from "@/components/ui/LoadMore";
import { AccountMenu } from "@/components/ui/Sidebar/AccountMenu";
import { SidebarItem } from "@/components/ui/Sidebar/SidebarItem";
import { useBrowserPresence } from "@/scopes/BrowserPresenceScope";
import { chatPath, useChat } from "@/scopes/ChatScope";

import { groupConversations, type HistorySection } from "./chatModel";
import { ChatSearch } from "./ChatSearchModal";
import { HistoryRow } from "./HistoryRow";

import classes from "./Chat.module.css";
import sidebarClasses from "@/components/ui/Sidebar/Sidebar.module.css";

function useChatSidebar() {
  const { conversations, selectedId, clock, listError, refreshConversationSummaries } = useChat();
  const searchOpen = Cell.source(false);
  const presence = useBrowserPresence();
  const browserConversations = Cell.derived(() => new Set(presence.get().conversations));
  const route = useCurrentRoute();
  const isNew = Cell.derived(() => {
    return selectedId.get() === null && (route.get().path === "/" || route.get().path === "/chat");
  });
  const groups = Cell.derived((): HistorySection[] => {
    return groupConversations(conversations.get(), clock.get());
  });
  const setSearchOpen = (next: boolean) => {
    searchOpen.set(next);
  };

  onSetup(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (!isShortcut) {
        return;
      }
      // Cmd/Ctrl+K would otherwise focus the browser's address or search bar.
      event.preventDefault();
      searchOpen.set(!searchOpen.get());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return {
    groups,
    isNew,
    searchOpen,
    setSearchOpen,
    listError,
    refreshConversationSummaries,
    browserConversations,
  };
}

interface HistoryGroupProps {
  group: HistorySection;
  groups: Cell<HistorySection[]>;
  browserConversations: Cell<Set<string>>;
}

/** Render a dated section of chat links. */
function HistoryGroup(props: HistoryGroupProps) {
  const { group, groups, browserConversations } = props;
  const { conversations } = useChat();
  // Key on the oldest row so a section keeps its identity as newer chats arrive above it.
  const headingId = `chat-group-${group.key.replace(/\W+/g, "-")}`;
  // Read current group data because keyed rows persist across list updates.
  const current = Cell.derived(() => {
    return groups.get().find((candidate) => {
      return candidate.key === group.key;
    });
  });
  const rows = Cell.derived(() => {
    return current.get()?.conversations ?? [];
  });
  // Labels age with the clock, so read the current one rather than the one this row was made with.
  const label = Cell.derived(() => {
    return current.get()?.label ?? group.label;
  });

  return (
    <li class={classes.historyGroup}>
      <h3 id={headingId} class={classes.historyHeading} title={label}>
        {label}
      </h3>
      <ul class={classes.historyGroupList} aria-labelledby={headingId}>
        {For(
          rows,
          (conversation) => {
            return (
              <HistoryRow
                initial={conversation}
                conversations={conversations}
                browserConversations={browserConversations}
              />
            );
          },
          { key: "id" },
        )}
      </ul>
    </li>
  );
}

export function ChatSidebar() {
  const {
    groups,
    isNew,
    searchOpen,
    setSearchOpen,
    listError,
    refreshConversationSummaries,
    browserConversations,
  } = useChatSidebar();
  const { hasMoreChats, loadingMoreChats, loadMoreChats } = useChat();

  return (
    <div class={classes.sidebar}>
      <AppLink
        href={chatPath(null)}
        class={sidebarClasses.sidebarItem}
        data-selected={isNew}
        title="New chat"
      >
        <Icon name="plus" class={sidebarClasses.sidebarItemIcon} aria-hidden="true" />
        <span>New</span>
      </AppLink>
      <ChatSearch open={searchOpen} onOpenChange={setSearchOpen} />
      <SidebarItem name="Plugins" icon="plugin" path="/plugins" />
      <SidebarItem name="Connections" icon="activity" path="/connections" />
      <FadeScroll class={classes.historyScroll}>
        {If(listError, (message) => {
          return (
            <div class={classes.historyError} role="alert">
              <p title={message}>{message}</p>
              <Button variant="outline" onClick={refreshConversationSummaries}>
                Retry
              </Button>
            </div>
          );
        })}
        <ul class={classes.history} aria-label="Chats">
          {For(
            groups,
            (group) => {
              return (
                <HistoryGroup
                  group={group}
                  groups={groups}
                  browserConversations={browserConversations}
                />
              );
            },
            { key: "key" },
          )}
        </ul>
        <LoadMore
          hasMore={hasMoreChats}
          loading={loadingMoreChats}
          onLoad={loadMoreChats}
          label="Load older chats"
          loadingLabel="Fetching older chats…"
        />
      </FadeScroll>
      <AccountMenu />
    </div>
  );
}
