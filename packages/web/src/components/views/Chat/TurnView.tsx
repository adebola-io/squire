import { Cell, For, If } from "retend";

import { useChat } from "@/scopes/ChatScope";

import { type Turn } from "./chatModel";
import { QueuedFollowUps } from "./QueuedFollowUps";
import { ReplyActions } from "./ReplyActions";
import { ReplyBody, ReplyHeader } from "./ReplyParts";
import { useReplyState } from "./replyState";
import { UserMessage } from "./UserMessage";
import { InlineWork } from "./WorkLog";
import { useInlineWorkState } from "./workLogState";

import classes from "./Chat.module.css";

interface TurnViewProps {
  turns: Cell<Turn[]>;
  index: Cell<number>;
  /** Initial turn used while the row is being removed. */
  initial: Turn;
  /** Whether this turn should run its entry animation. */
  entering: boolean;
}

/**
 * Key subtrees to preserve DOM and scroll position when visible data is unchanged. All inputs
 * are synchronous.
 */
export function TurnView(props: TurnViewProps) {
  const { turns, index, initial, entering } = props;
  const { snapshot, live } = useChat();
  // Use the initial turn while a shrinking list updates before `For` unmounts this row.
  const turn = Cell.derived(() => {
    return turns.get()[index.get()] ?? initial;
  });
  const isLast = Cell.derived(() => {
    return index.get() === turns.get().length - 1;
  });
  const users = useTurnUsers(turn);
  // Show queued follow-ups only on the active turn, at the position where they will be sent.
  const queued = Cell.derived(() => {
    const current = snapshot.get();
    return current !== null && isLast.get() ? current.queued : [];
  });
  // A follow-up that joins the active run ends this turn's work and starts the next turn.
  const joinedFollowUp = Cell.derived(() => {
    const next = turns.get()[index.get() + 1];
    const first = next?.users[0];
    return first !== undefined && first.joinedRun === true ? first.createdAt : null;
  });
  // Create reply state immediately for the active turn, before model output arrives. Retain
  // stopped and error states after execution ends.
  const replySlots = Cell.derived(() => {
    const current = turn.get();
    if (current.replies.length > 0) {
      return [{ id: current.id }];
    }
    if (!isLast.get()) {
      return [];
    }
    const status = snapshot.get()?.conversation.executionStatus;
    const started = status !== undefined && status !== "idle";
    if (started || live.get() !== null) {
      return [{ id: current.id }];
    }
    return [];
  });

  return (
    <li class={classes.turn} data-turn-id={initial.id} data-entering={entering}>
      {/* Render the user messages that open this turn, excluding work-log entries. */}
      <div class={classes.userGroup}>
        {For(
          users,
          ({ current }) => {
            return <UserMessage message={current} />;
          },
          { key: "id" },
        )}
      </div>
      {For(
        replySlots,
        () => {
          return (
            <AssistantReply
              turn={turn}
              isLast={isLast}
              joinedFollowUp={joinedFollowUp}
              entering={entering}
            />
          );
        },
        { key: "id" },
      )}
      {/* Place queued messages after the assistant reply and before the next turn. */}
      <QueuedFollowUps queued={queued} />
    </li>
  );
}

interface AssistantReplyProps {
  turn: Cell<Turn>;
  isLast: Cell<boolean>;
  /** Timestamp of the follow-up that continued this run, if any. */
  joinedFollowUp: Cell<string | null>;
  entering: boolean;
}

/** Work status, execution log, reply body, and its actions. */
function AssistantReply(props: AssistantReplyProps) {
  const { turn, isLast, joinedFollowUp, entering } = props;
  const reply = useReplyState(turn, isLast, entering, joinedFollowUp);
  const work = useInlineWorkState(turn, isLast);
  // Keep the log open until the completed Markdown is prepared, so the exit and reveal
  // share one start point. An explicit disclosure choice takes precedence.
  const manualOpen = Cell.source<boolean | null>(null);
  const wasAutoOpen = Cell.source(isLast.get() && reply.phase.get() === "working");
  const open = Cell.derived(
    () =>
      manualOpen.get() ??
      (isLast.get() &&
        (reply.phase.get() === "working" ||
          (reply.phase.get() === "done" && reply.bodyPanes.get().length === 0))),
  );
  const reveal = Cell.derived(() => reply.bodyPanes.get()[0]?.reveal === true);
  const handoff = Cell.derived(
    () => reveal.get() && wasAutoOpen.get() && work.hasWork.get() && manualOpen.get() === null,
  );
  // Stopped and unanswered replies render only their status.
  const empty = Cell.derived(() => {
    return reply.phase.get() === "stopped" || reply.phase.get() === "unanswered";
  });
  const toggleWork = () => manualOpen.set(!open.get());
  open.listen((expanded) => {
    if (expanded && manualOpen.get() === null) wasAutoOpen.set(true);
  });

  return (
    <article class={classes.reply} data-reveal={reveal} data-handoff={handoff}>
      <div class={classes.workSection}>
        <ReplyHeader
          phase={reply.phase}
          reply={reply}
          hasWork={work.hasWork}
          open={open}
          onToggle={toggleWork}
        />
        {If(work.hasWork, () => (
          <InlineWork work={work} open={open} />
        ))}
      </div>
      <div class={classes.assistantContent} data-empty={empty}>
        {For(
          reply.bodyPanes,
          (pane) => {
            return <ReplyBody pane={pane} reply={reply} />;
          },
          { key: "key" },
        )}
      </div>
      <div class={classes.messageActions}>
        {For(
          reply.actionPanes,
          (pane) => {
            return <ReplyActions pane={pane} />;
          },
          { key: "key" },
        )}
      </div>
    </article>
  );
}

function useTurnUsers(turn: Cell<Turn>) {
  const users = Cell.derived(() => {
    const messages = turn.get().users;
    const rows = messages.map((message) => {
      const current = Cell.derived(() => {
        return turn.get().users.find((user) => user.id === message.id) ?? message;
      });
      return { id: message.id, current };
    });
    return rows;
  });
  return users;
}
