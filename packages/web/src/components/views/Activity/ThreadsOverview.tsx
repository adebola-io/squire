import { Cell, If, type AsyncCell } from "retend";
import { Icon } from "squire-ui";

import { BrowserResource } from "@/components/browser/BrowserResource";
import type { Thread } from "@/scopes/ActivityScope";

import { ClientIcon } from "./ClientName";
import { ThreadActions } from "./ThreadActions";
import { ToolCalls } from "./ToolCalls";

import classes from "./Activity.module.css";

interface ThreadOverviewProps {
  thread: AsyncCell<Thread>;
  clock: Cell<number>;
  browserCounts: Cell<Map<string, number>>;
  onDeleteRequest: (thread: Thread) => void;
}

function updatedTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown time";
  }
  const today = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) {
    return `Today, ${time}`;
  }
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday, ${time}`;
  }
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

interface ThreadBrowserAttachmentProps {
  id: string;
  counts: Cell<Map<string, number>>;
}

function ThreadBrowserAttachment(props: ThreadBrowserAttachmentProps) {
  const { id, counts } = props;
  const count = Cell.derived(() => counts.get().get(id) ?? 0);
  const hasBrowser = Cell.derived(() => count.get() > 0);
  return If(hasBrowser, () => <BrowserResource kind="thread" id={id} variant="thread" />);
}

export function ThreadsOverview(props: ThreadOverviewProps) {
  const { thread, clock, browserCounts, onDeleteRequest } = props;
  const disclosure = Cell.source<"unopened" | "closed" | "open">("unopened");
  const open = Cell.derived(() => disclosure.get() === "open");
  const openedOnce = Cell.derived(() => disclosure.get() !== "unopened");
  const view = Cell.derivedAsync(async (get) => {
    const t = await get(thread);
    return {
      id: t.id,
      title: t.title,
      client: t.client,
      lastActivityAt: t.lastActivityAt,
      time: updatedTime(t.lastActivityAt),
      entryCount: t.entryCount,
    };
  });
  const id = Cell.derivedAsync(async (get) => (await get(view)).id);
  const title = Cell.derivedAsync(async (get) => (await get(view)).title);
  const client = Cell.derivedAsync(async (get) => (await get(view)).client);
  const date = Cell.derivedAsync(async (get) => (await get(view)).lastActivityAt);
  const time = Cell.derivedAsync(async (get) => (await get(view)).time);
  const entryCount = Cell.derivedAsync(async (get) => (await get(view)).entryCount);
  const working = Cell.derivedAsync(async (get) => {
    const until = (await get(thread)).workingUntil;
    return until !== null && until > get(clock);
  });
  const toggle = () => {
    disclosure.set(disclosure.get() === "open" ? "closed" : "open");
  };

  return (
    <li class={classes.threadItem}>
      <button type="button" class={classes.threadButton} onClick={toggle} aria-expanded={open}>
        <Icon name="caret" class={classes.threadCaret} data-open={open} aria-hidden="true" />
        <span class={classes.threadText}>
          <span class={classes.threadHeading}>
            <span class={classes.threadTitle} title={title}>
              {title}
            </span>
            <span
              class={classes.threadWorkingSlot}
              data-working={working}
              role="img"
              aria-label="Likely working, based on recent tool calls"
              title="Likely working · Based on recent tool calls"
            />
          </span>
          <span class={classes.threadMetadata}>
            <span class={classes.threadClient}>
              {If(client, (name) => (
                <ClientIcon name={name} class={classes.threadClientIcon} />
              ))}
              <span>{client}</span>
            </span>
            <span aria-hidden="true">·</span>
            <time dateTime={date} title={date}>
              {time}
            </time>
            <span aria-hidden="true">·</span>
            <span>
              {entryCount} {If(entryCount, (count) => (count === 1 ? "tool call" : "tool calls"))}
            </span>
          </span>
        </span>
      </button>
      <div class={classes.threadEnd}>
        {If(id, (threadId) => (
          <ThreadBrowserAttachment id={threadId} counts={browserCounts} />
        ))}
        <ThreadActions
          title={title}
          onDelete={() => {
            void thread.get().then(onDeleteRequest, () => {});
          }}
        />
      </div>
      <div class={classes.threadDisclosure} data-open={open}>
        <div class={classes.threadDisclosureInner}>
          {If(openedOnce, () =>
            If(id, (threadId) => <ToolCalls open={open} threadId={threadId} />),
          )}
        </div>
      </div>
    </li>
  );
}
