import { Cell, For, If } from "retend";
import type { SourceCell } from "retend";
import { Icon } from "squire-ui";

import type { DesktopConversation } from "@/platform/desktopEvents";
import { useChat } from "@/scopes/ChatScope";

import { plainPreview } from "./chatModel";

import classes from "./Chat.module.css";

interface SearchResultRowProps {
  conversation: DesktopConversation;
  activeId: SourceCell<string | null>;
  onOpen: (id: string) => void;
}

/** Stable result-row ID for `aria-activedescendant`. */
export function searchRowDomId(conversationId: string) {
  return `chat-search-row-${conversationId}`;
}

/** Full-text-search markers use control characters excluded from message text. */
const MARK_START = "\u0001";
const MARK_END = "\u0002";

interface TextSegment {
  text: string;
  mark: boolean;
}

/** Split search text into matched and unmatched segments. */
function splitMarked(source: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (;;) {
    const start = source.indexOf(MARK_START, cursor);
    if (start === -1) {
      break;
    }
    const end = source.indexOf(MARK_END, start + MARK_START.length);
    if (end === -1) {
      break;
    }
    if (start > cursor) {
      segments.push({ text: source.slice(cursor, start), mark: false });
    }
    segments.push({ text: source.slice(start + MARK_START.length, end), mark: true });
    cursor = end + MARK_END.length;
  }
  if (cursor < source.length || segments.length === 0) {
    segments.push({ text: source.slice(cursor), mark: false });
  }
  return segments;
}

interface MarkedTextProps {
  segments: Cell<TextSegment[]>;
}

function MarkedText(props: MarkedTextProps) {
  return For(props.segments, (segment) =>
    segment.mark ? <mark class={classes.searchMark}>{segment.text}</mark> : segment.text,
  );
}

export function SearchResultRow(props: SearchResultRowProps) {
  const { conversation, activeId, onOpen } = props;
  const { conversations } = useChat();
  const live = Cell.derived(() => {
    return conversations.get().find((item) => item.id === conversation.id) ?? conversation;
  });
  // Read highlight markers from the search response; live conversation records do not contain
  // them.
  const titleSource = Cell.derived(() => {
    return conversation.titleHighlight ?? live.get().title;
  });
  const excerptSource = Cell.derived(() => {
    const excerpt = conversation.matchExcerpt;
    if (excerpt !== null && excerpt !== undefined) {
      return excerpt.replace(/\s+/g, " ").trim();
    }
    return plainPreview(live.get().preview ?? "");
  });
  const title = Cell.derived(() => {
    const text = titleSource.get();
    return text === "" ? "New Chat" : text;
  });
  const titleSegments = Cell.derived(() => splitMarked(title.get()));
  const excerptSegments = Cell.derived(() => splitMarked(excerptSource.get()));
  const isRunning = Cell.derived(() => live.get().executionStatus === "running");
  const showUnread = Cell.derived(() => !isRunning.get() && live.get().unread);
  const isActive = Cell.derived(() => activeId.get() === live.get().id);
  const domId = searchRowDomId(conversation.id);
  return (
    <li>
      <button
        type="button"
        id={domId}
        role="option"
        aria-selected={isActive}
        class={classes.searchRow}
        data-active={isActive}
        onMouseEnter={() => activeId.set(live.get().id)}
        onFocus={() => activeId.set(live.get().id)}
        onClick={() => onOpen(live.get().id)}
      >
        <span class={classes.searchRowTitle} title={title}>
          <span class={classes.searchRowTitleText}>
            <MarkedText segments={titleSegments} />
          </span>
          {If(isRunning, () => (
            <Icon name="spinner" class={classes.historySpinner} aria-hidden="true" />
          ))}
          {If(showUnread, () => (
            <span class={classes.unreadMark} title="Unread">
              <span class={classes.srOnly}>Unread</span>
            </span>
          ))}
        </span>
        <span class={classes.searchRowPreview} title={excerptSource}>
          <MarkedText segments={excerptSegments} />
        </span>
      </button>
    </li>
  );
}
